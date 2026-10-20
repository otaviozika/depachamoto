// Pré-saída: o motoboy confere cada sacola, o DespacheFull calcula a sequência das
// entregas e só então a saída definitiva é registrada (pelo fluxo de despacho que já
// existe). Também guarda a sequência da saída e as correções de endereço do admin.
//
// Regras de concorrência:
// - cada mutação trava a linha da pré-saída (FOR UPDATE) e confere a versão enviada;
// - a reserva do pedido é um índice único parcial (platform, external_order_id) WHERE active;
// - nenhuma transação fica aberta durante chamadas ao Google: o cálculo lê um retrato,
//   consulta o Google sem transação e grava conferindo se a base do cálculo não mudou.
import crypto from "node:crypto";
import { LONGE_STORE, haversineMeters, resolveStoreOrigin, validCoordinate } from "./longe-zone.js";
import { ORS_ATTRIBUTION, configuredRouteProvider, createTravelClient } from "./route-providers.js";
import { ROUTE_MAX_STOPS, ROUTE_PLANNER_DEFAULTS, normalizePlannerParams, planRoute } from "./route-planner.js";

export const PRE_DEPARTURE_OPEN_STATES = Object.freeze(["DRAFT", "AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "BLOCKED"]);
export const PRE_DEPARTURE_TRANSITIONS = Object.freeze({
  DRAFT: ["AWAITING_CHECK", "CANCELLED"],
  AWAITING_CHECK: ["AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "BLOCKED", "CANCELLED", "EXPIRED"],
  PARTIALLY_CHECKED: ["AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "BLOCKED", "CANCELLED", "EXPIRED"],
  CHECKED: ["AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "BLOCKED", "CANCELLED", "EXPIRED"],
  ROUTE_READY: ["AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "DISPATCHED", "BLOCKED", "CANCELLED", "EXPIRED"],
  BLOCKED: ["AWAITING_CHECK", "PARTIALLY_CHECKED", "CHECKED", "ROUTE_READY", "BLOCKED", "DISPATCHED", "CANCELLED", "EXPIRED"],
  DISPATCHED: [],
  CANCELLED: [],
  EXPIRED: []
});
export const PRE_DEPARTURE_SETTINGS = Object.freeze({
  pre_departure: "pre_departure_enabled",
  route_planner: "route_planner_enabled",
  address_correction: "address_correction_enabled",
  params: "route_planner_params",
  ttl: "pre_departure_ttl_minutes",
  store_origin: "route_store_origin"
});
export const PRE_DEPARTURE_TTL_MINUTES = 45;
export const ROUTE_REGION_MAX_METERS = 30000;
const ROUTE_READY_STATUSES = ["READY", "DISABLED", "ADMIN"];
const MATRIX_CACHE_DAYS = 30;
const PLATFORM_LABEL = { ifood: "iFood", anotaai: "Anota AI" };

export function canTransition(from, to) {
  return (PRE_DEPARTURE_TRANSITIONS[from] || []).includes(to);
}

export function deriveStatus({ total, checked, routeReady, blocked }) {
  if (blocked) return "BLOCKED";
  if (!total || checked <= 0) return "AWAITING_CHECK";
  if (checked < total) return "PARTIALLY_CHECKED";
  return routeReady ? "ROUTE_READY" : "CHECKED";
}

// Base do cálculo: composição + versão do endereço de cada pedido + parâmetros. Se mudar,
// a rota gravada deixa de valer.
export function routeBasis({ compositionVersion, orders, plannerEnabled, params }) {
  const parts = orders.map(o => `${o.platform}:${o.external_order_id}@${Number(o.address_version || 0)}`).sort();
  const p = plannerEnabled ? JSON.stringify(normalizePlannerParams(params || {})) : "off";
  return crypto.createHash("sha256").update(`c${compositionVersion}|${parts.join(",")}|${p}`).digest("hex").slice(0, 32);
}

function fail(status, message, code, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

const pointKey = p => `${Number(p.latitude).toFixed(5)},${Number(p.longitude).toFixed(5)}`;
const addressKey = text => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const round1 = v => v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
const text = (v, max = 160) => typeof v === "string" ? v.trim().slice(0, max) : "";

export function formatOverrideAddress(f) {
  const line = [f.street, f.number].filter(Boolean).join(", ");
  const locality = [f.neighborhood, [f.city, f.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
  return [line, locality, f.postal_code, "Brasil"].filter(Boolean).join(", ");
}

export function validateAddressFields(input = {}) {
  const fields = {
    street: text(input.street, 160), number: text(input.number, 20), complement: text(input.complement, 160),
    neighborhood: text(input.neighborhood, 100), city: text(input.city, 100), state: text(input.state, 30),
    postal_code: text(input.postal_code, 12), reference: text(input.reference, 200)
  };
  const missing = ["street", "number", "neighborhood", "city"].filter(k => !fields[k]);
  if (missing.length) throw fail(400, "Informe rua, número, bairro e cidade.", "ADDRESS_FIELDS_REQUIRED", { missing });
  if (fields.postal_code && !/^\d{5}-?\d{3}$/.test(fields.postal_code)) throw fail(400, "CEP inválido. Use 00000-000.", "ADDRESS_POSTAL_CODE_INVALID");
  return fields;
}

export function createPreDepartureService({
  pool,
  describeOrder,
  emitRealtime = () => {},
  audit = async () => {},
  env = process.env,
  routesClientFactory = () => createTravelClient({ env }),
  onAddressCorrected = async () => {},
  now = () => new Date(),
  logger = console
}) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function event(client, { preDepartureId = null, dispatchId = null, name, actorUserId = null, details = {}, dedupeKey = null }) {
    await client.query(`INSERT INTO pre_departure_events(pre_departure_id,dispatch_id,event,actor_user_id,details,dedupe_key)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
      [preDepartureId, dispatchId, name, actorUserId, JSON.stringify(details), dedupeKey]);
  }

  // ---------------------------------------------------------------- configurações
  async function readSettings(client = pool) {
    const keys = Object.values(PRE_DEPARTURE_SETTINGS);
    const rows = (await client.query("SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])", [keys])).rows;
    const map = new Map(rows.map(r => [r.setting_key, r.setting_value]));
    let params = ROUTE_PLANNER_DEFAULTS;
    try { params = normalizePlannerParams(JSON.parse(map.get(PRE_DEPARTURE_SETTINGS.params) || "{}")); } catch { params = ROUTE_PLANNER_DEFAULTS; }
    const ttl = Number(map.get(PRE_DEPARTURE_SETTINGS.ttl));
    return {
      pre_departure: map.get(PRE_DEPARTURE_SETTINGS.pre_departure) === "true",
      route_planner: map.get(PRE_DEPARTURE_SETTINGS.route_planner) === "true",
      address_correction: map.get(PRE_DEPARTURE_SETTINGS.address_correction) === "true",
      params,
      ttl_minutes: Number.isInteger(ttl) && ttl >= 10 && ttl <= 240 ? ttl : PRE_DEPARTURE_TTL_MINUTES,
      route_provider: configuredRouteProvider(env)
    };
  }

  async function saveSettings({ actorUserId, flags = {}, params, ttlMinutes, reason }) {
    const why = text(reason, 300);
    if (why.length < 5) throw fail(400, "Informe o motivo da alteração (mínimo de 5 caracteres).", "SETTINGS_REASON_REQUIRED");
    const before = await readSettings();
    const updates = [];
    for (const [flag, key] of [["pre_departure", PRE_DEPARTURE_SETTINGS.pre_departure], ["route_planner", PRE_DEPARTURE_SETTINGS.route_planner], ["address_correction", PRE_DEPARTURE_SETTINGS.address_correction]]) {
      if (flags[flag] === undefined) continue;
      if (typeof flags[flag] !== "boolean") throw fail(400, `Valor inválido para ${flag}.`, "SETTINGS_INVALID");
      updates.push([key, String(flags[flag])]);
    }
    if (params !== undefined) updates.push([PRE_DEPARTURE_SETTINGS.params, JSON.stringify(normalizePlannerParams(params))]);
    if (ttlMinutes !== undefined) {
      const ttl = Number(ttlMinutes);
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > 240) throw fail(400, "Expiração deve ficar entre 10 e 240 minutos.", "SETTINGS_INVALID");
      updates.push([PRE_DEPARTURE_SETTINGS.ttl, String(ttl)]);
    }
    const next = { ...before, ...Object.fromEntries(Object.entries(flags).filter(([, v]) => typeof v === "boolean")) };
    if (flags.route_planner === true && !next.pre_departure) throw fail(409, "A sequência automática depende da conferência das sacolas ligada.", "ROUTE_PLANNER_REQUIRES_PRE_DEPARTURE");
    if (flags.route_planner === true && !configuredRouteProvider(env)) {
      throw fail(409, "Configure a chave do serviço de rotas no Render (OPENROUTESERVICE_API_KEY, gratuita) antes de ligar a sequência automática.", "ROUTE_PROVIDER_NOT_CONFIGURED");
    }
    // Rollback em um toque: desligar a conferência desliga a sequência e libera os pedidos
    // reservados nas pré-saídas abertas, para a saída direta voltar na hora.
    const turningOff = before.pre_departure && flags.pre_departure === false;
    if (turningOff && before.route_planner) updates.push([PRE_DEPARTURE_SETTINGS.route_planner, "false"]);
    const released = await tx(async client => {
      for (const [key, value] of updates) {
        await client.query(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES($1,$2,NOW())
          ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [key, value]);
      }
      if (!turningOff) return [];
      const rows = (await client.query(`UPDATE pre_departures SET status='CANCELLED',closed_at=NOW(),close_reason='FEATURE_DISABLED',version=version+1,updated_at=NOW()
        WHERE status = ANY($1::text[]) RETURNING id,courier_id`, [PRE_DEPARTURE_OPEN_STATES])).rows;
      for (const row of rows) {
        await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='FEATURE_DISABLED' WHERE pre_departure_id=$1 AND active", [row.id]);
        await event(client, { preDepartureId: row.id, name: "CANCELLED", actorUserId, details: { reason: "Conferência de sacolas desligada pelo admin", settings_reason: why } });
      }
      return rows;
    });
    const after = await readSettings();
    await audit(actorUserId, "PRE_DEPARTURE_SETTINGS_CHANGED", "setting", null, { reason: why, before, after, released_pre_departures: released.map(r => Number(r.id)) });
    emitRealtime("settings:changed", { scope: "pre_departure" });
    emitRealtime("dispatch:changed", { all: true, change: "PRE_DEPARTURE_SETTINGS" });
    return after;
  }

  // ---------------------------------------------------------------- dados dos pedidos
  async function loadOrders(client, refs) {
    const ifood = refs.filter(r => r.platform === "ifood").map(r => r.external_order_id);
    const anota = refs.filter(r => r.platform === "anotaai").map(r => r.external_order_id);
    const keys = refs.map(r => `${r.platform}:${r.external_order_id}`);
    const [i, a, ov] = await Promise.all([
      ifood.length ? client.query(`SELECT order_id,display_id,status,order_created_at AS created_at,payload FROM ifood_orders WHERE order_id = ANY($1::text[])`, [ifood]) : { rows: [] },
      anota.length ? client.query(`SELECT order_id,display_id,status,remote_created_at AS created_at,payload,customer_name FROM anotaai_orders WHERE order_id = ANY($1::text[])`, [anota]) : { rows: [] },
      keys.length ? client.query(`SELECT DISTINCT ON (platform,external_order_id) o.*,u.name AS changed_by_name
          FROM order_address_overrides o LEFT JOIN users u ON u.id=o.changed_by
          WHERE (platform||':'||external_order_id) = ANY($1::text[])
          ORDER BY platform,external_order_id,version DESC`, [keys]) : { rows: [] }
    ]);
    const out = new Map();
    const overrides = new Map(ov.rows.map(r => [`${r.platform}:${r.external_order_id}`, r]));
    for (const [platform, rows] of [["ifood", i.rows], ["anotaai", a.rows]]) {
      for (const row of rows) {
        const described = describeOrder(platform, row.payload, row) || {};
        out.set(`${platform}:${row.order_id}`, {
          platform,
          external_order_id: row.order_id,
          display_id: row.display_id,
          status: String(row.status || "").toUpperCase(),
          created_at: row.created_at,
          customer_name: described.customer_name || row.customer_name || "",
          platform_address: platformAddress(described),
          override: overrides.get(`${platform}:${row.order_id}`) || null
        });
      }
    }
    return out;
  }

  function platformAddress(described) {
    const nav = described.navigation || {};
    const f = described.fields || {};
    return {
      source: "PLATFORM",
      version: 0,
      address: nav.address || null,
      address_complete: nav.address_complete === true,
      latitude: validCoordinate(nav) ? Number(nav.latitude) : null,
      longitude: validCoordinate(nav) ? Number(nav.longitude) : null,
      fields: {
        street: f.street || "", number: f.number || "", complement: f.complement || "",
        neighborhood: f.neighborhood || "", city: f.city || "", state: f.state || "",
        postal_code: f.postalCode || f.postal_code || "", reference: f.reference || ""
      }
    };
  }

  function operationalAddress(order) {
    const ov = order?.override;
    if (!ov) return order?.platform_address || null;
    return {
      source: "ADMIN",
      version: Number(ov.version),
      address: ov.formatted_address,
      address_complete: true,
      latitude: Number(ov.latitude),
      longitude: Number(ov.longitude),
      location_source: ov.location_source,
      fields: {
        street: ov.street, number: ov.number, complement: ov.complement || "", neighborhood: ov.neighborhood,
        city: ov.city, state: ov.state || "", postal_code: ov.postal_code || "", reference: ov.reference || ""
      },
      changed_at: ov.created_at,
      changed_by_name: ov.changed_by_name || null,
      reason: ov.reason
    };
  }

  // Destino no formato que o app já usa para Waze/Google Maps.
  function navigationFor(address) {
    if (!address) return null;
    return {
      latitude: address.latitude ?? null,
      longitude: address.longitude ?? null,
      address: address.address || null,
      address_complete: address.address_complete === true,
      source: address.address ? "address" : "coordinates"
    };
  }

  // ---------------------------------------------------------------- visão da pré-saída
  async function readPreDeparture(client, id, { lock = false } = {}) {
    return (await client.query(`SELECT * FROM pre_departures WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id])).rows[0] || null;
  }
  async function activeOrders(client, id, { lock = false } = {}) {
    return (await client.query(`SELECT * FROM pre_departure_orders WHERE pre_departure_id=$1 AND active ORDER BY position ${lock ? "FOR UPDATE" : ""}`, [id])).rows;
  }

  async function currentBasis(client, pd, rows, settings) {
    const data = await loadOrders(client, rows);
    return routeBasis({
      compositionVersion: pd.composition_version,
      orders: rows.map(r => ({ ...r, address_version: data.get(`${r.platform}:${r.external_order_id}`)?.override?.version || 0 })),
      plannerEnabled: settings.route_planner,
      params: settings.params
    });
  }

  async function view(id, { client = pool } = {}) {
    const pd = await readPreDeparture(client, id);
    if (!pd) return null;
    const settings = await readSettings(client);
    const rows = await activeOrders(client, id);
    const data = await loadOrders(client, rows);
    const courier = (await client.query("SELECT id,name FROM users WHERE id=$1", [pd.courier_id])).rows[0] || null;
    const open = PRE_DEPARTURE_OPEN_STATES.includes(pd.status);
    const basis = open ? routeBasis({
      compositionVersion: pd.composition_version,
      orders: rows.map(r => ({ ...r, address_version: data.get(`${r.platform}:${r.external_order_id}`)?.override?.version || 0 })),
      plannerEnabled: settings.route_planner,
      params: settings.params
    }) : pd.route_basis;
    const routeValid = Boolean(pd.route) && ROUTE_READY_STATUSES.includes(pd.route_status) && pd.route_basis === basis;
    const checked = rows.filter(r => r.checked_at).length;
    const orders = rows.map(r => {
      const d = data.get(`${r.platform}:${r.external_order_id}`) || {};
      const address = operationalAddress(d);
      const stop = routeValid ? (pd.route.stops || []).find(s => s.platform === r.platform && s.external_order_id === r.external_order_id) : null;
      return {
        id: Number(r.id),
        position: Number(r.position),
        order_number: r.order_number,
        platform: r.platform,
        platform_label: PLATFORM_LABEL[r.platform] || r.platform,
        external_order_id: r.external_order_id,
        checked: Boolean(r.checked_at),
        checked_at: r.checked_at,
        created_at_platform: d.created_at || null,
        customer_name: d.customer_name || "",
        address: address ? { text: address.address, fields: address.fields, source: address.source, version: address.version } : null,
        address_override: address?.source === "ADMIN" ? { version: address.version, changed_at: address.changed_at, reason: address.reason, original: d.platform_address?.address || null } : null,
        navigation: navigationFor(address),
        sequence: stop?.sequence || null,
        arrival_minutes: stop?.arrival_minutes ?? null
      };
    });
    const blockers = [];
    if (open) {
      if (checked < rows.length) blockers.push({ code: "CHECK_PENDING", message: `Faltam ${rows.length - checked} sacola(s) para conferir.` });
      if (pd.ack_required) blockers.push({ code: "ACK_REQUIRED", message: "O admin alterou um endereço. Toque em Ciente antes de sair." });
      if (pd.status === "BLOCKED") blockers.push({ code: pd.blocked_reason?.code || "BLOCKED", message: pd.blocked_reason?.message || "Pré-saída bloqueada. Procure o admin." });
      else if (!routeValid && checked === rows.length) blockers.push({ code: "ROUTE_PENDING", message: "A rota ainda não foi calculada para a composição atual." });
    }
    const last = new Date(pd.last_activity_at).getTime();
    return {
      id: Number(pd.id),
      courier: courier ? { id: courier.id, name: courier.name } : null,
      status: pd.status,
      version: pd.version,
      composition_version: pd.composition_version,
      route_status: pd.route_status,
      route_version: pd.route_version,
      route_valid: routeValid,
      route: routeValid ? publicRoute(pd.route, orders) : null,
      route_error: pd.route_error,
      blocked_reason: pd.blocked_reason,
      ack_required: pd.ack_required,
      admin_override: pd.admin_override,
      orders,
      counts: { total: rows.length, checked, max: ROUTE_MAX_STOPS },
      can_dispatch: open && blockers.length === 0 && routeValid,
      blockers,
      settings: { route_planner: settings.route_planner, ttl_minutes: settings.ttl_minutes },
      expires_at: open ? new Date(last + settings.ttl_minutes * 60000).toISOString() : null,
      dispatch_id: pd.dispatch_id ? Number(pd.dispatch_id) : null,
      created_at: pd.created_at,
      updated_at: pd.updated_at,
      closed_at: pd.closed_at,
      close_reason: pd.close_reason
    };
  }

  function publicRoute(route, orders) {
    const byKey = new Map(orders.map(o => [`${o.platform}:${o.external_order_id}`, o]));
    return {
      source: route.source,
      provider: route.provider || null,
      attribution: route.attribution || null,
      computed_at: route.computed_at,
      evaluated: route.evaluated ?? null,
      duration_minutes: round1(route.duration_minutes),
      total_wait_minutes: round1(route.total_wait_minutes),
      max_wait_minutes: round1(route.max_wait_minutes),
      params: route.params || null,
      admin: route.admin || null,
      stops: (route.stops || []).map(s => ({
        sequence: s.sequence,
        order_number: s.order_number,
        platform: s.platform,
        external_order_id: s.external_order_id,
        arrival_minutes: round1(s.arrival_minutes),
        wait_minutes: round1(s.wait_minutes),
        age_minutes: round1(s.age_minutes),
        customer_name: byKey.get(`${s.platform}:${s.external_order_id}`)?.customer_name || ""
      }))
    };
  }

  async function current(courierId, { touch = true } = {}) {
    const row = (await pool.query(`SELECT id FROM pre_departures WHERE courier_id=$1 AND status = ANY($2::text[]) ORDER BY id DESC LIMIT 1`, [courierId, PRE_DEPARTURE_OPEN_STATES])).rows[0];
    if (!row) return null;
    if (touch) await pool.query("UPDATE pre_departures SET last_activity_at=NOW() WHERE id=$1", [row.id]);
    return view(row.id);
  }

  // ---------------------------------------------------------------- criação e edição
  function normalizeLinks(links) {
    const list = Array.isArray(links) ? links : [];
    if (list.length < 1 || list.length > ROUTE_MAX_STOPS) throw fail(400, `Uma saída tem de 1 a ${ROUTE_MAX_STOPS} pedidos.`, "PRE_DEPARTURE_LIMIT");
    const out = list.map(l => ({
      platform: String(l.platform || "").toLowerCase(),
      external_order_id: String(l.order_id || l.external_order_id || "").trim(),
      order_number: String(l.order_number || "").trim(),
      order_date: l.order_date || null
    }));
    if (out.some(l => !["ifood", "anotaai"].includes(l.platform) || !l.external_order_id || !l.order_number)) {
      throw fail(400, "Pedido sem plataforma identificada.", "ORDER_PLATFORM_REQUIRED");
    }
    if (new Set(out.map(l => `${l.platform}:${l.external_order_id}`)).size !== out.length ||
        new Set(out.map(l => l.order_number.replace(/^#/, "").toLowerCase())).size !== out.length) {
      throw fail(400, "O mesmo pedido foi informado duas vezes.", "ORDER_DUPLICATED");
    }
    return out;
  }

  async function assertOrdersFree(client, links, preDepartureId = null) {
    for (const l of links) {
      // Mesma trava de linha usada pelo despacho: reserva e saída de outro motoboy se enfileiram.
      await client.query(l.platform === "ifood" ? "SELECT 1 FROM ifood_orders WHERE order_id=$1 FOR UPDATE" : "SELECT 1 FROM anotaai_orders WHERE order_id=$1 FOR UPDATE", [l.external_order_id]);
      const linked = l.platform === "ifood"
        ? await client.query("SELECT dispatch_id FROM ifood_dispatch_links WHERE ifood_order_id=$1", [l.external_order_id])
        : await client.query("SELECT dispatch_id FROM anotaai_dispatch_links WHERE anotaai_order_id=$1", [l.external_order_id]);
      if (linked.rowCount) throw fail(409, `Pedido ${l.order_number} já está vinculado a uma saída.`, "ORDER_ALREADY_ACTIVE", { order_number: l.order_number });
      const held = (await client.query(`SELECT p.id,p.courier_id,u.name AS courier_name FROM pre_departure_orders o
          JOIN pre_departures p ON p.id=o.pre_departure_id LEFT JOIN users u ON u.id=p.courier_id
          WHERE o.platform=$1 AND o.external_order_id=$2 AND o.active AND o.pre_departure_id <> COALESCE($3::bigint,0)`,
        [l.platform, l.external_order_id, preDepartureId])).rows[0];
      if (held) throw reservedError(l, held);
    }
  }

  function reservedError(link, held) {
    return fail(409, `Pedido ${link.order_number} (${PLATFORM_LABEL[link.platform]}) já está reservado na pré-saída de ${held.courier_name || "outro motoboy"}.`,
      "ORDER_RESERVED", { order_number: link.order_number, platform: link.platform, holder_courier_id: held.courier_id });
  }

  async function insertOrder(client, preDepartureId, position, link) {
    try {
      await client.query("SAVEPOINT reserve_order");
      const row = (await client.query(`INSERT INTO pre_departure_orders(pre_departure_id,position,order_number,platform,external_order_id,order_date)
        VALUES($1,$2,$3,$4,$5,$6::date) RETURNING *`, [preDepartureId, position, link.order_number, link.platform, link.external_order_id, link.order_date])).rows[0];
      await client.query("RELEASE SAVEPOINT reserve_order");
      return row;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT reserve_order");
      if (e.code === "23505" && String(e.constraint || "").includes("reserved")) {
        const held = (await client.query(`SELECT p.courier_id,u.name AS courier_name FROM pre_departure_orders o JOIN pre_departures p ON p.id=o.pre_departure_id
          LEFT JOIN users u ON u.id=p.courier_id WHERE o.platform=$1 AND o.external_order_id=$2 AND o.active`, [link.platform, link.external_order_id])).rows[0];
        throw reservedError(link, held || {});
      }
      if (e.code === "23505" || e.code === "23514") throw fail(409, `A saída pode ter no máximo ${ROUTE_MAX_STOPS} pedidos.`, "PRE_DEPARTURE_LIMIT");
      throw e;
    }
  }

  async function create({ courierId, links: rawLinks, actorUserId = courierId }) {
    const links = normalizeLinks(rawLinks);
    const result = await tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1::int)", [courierId]);
      const open = (await client.query(`SELECT id FROM pre_departures WHERE courier_id=$1 AND status = ANY($2::text[]) FOR UPDATE`, [courierId, PRE_DEPARTURE_OPEN_STATES])).rows[0];
      if (open) {
        const rows = await activeOrders(client, open.id);
        const same = rows.length === links.length && links.every(l => rows.some(r => r.platform === l.platform && r.external_order_id === l.external_order_id));
        if (same) return { id: open.id, duplicate: true };
        throw fail(409, "Você já tem uma pré-saída aberta. Termine ou cancele antes de começar outra.", "PRE_DEPARTURE_OPEN", { pre_departure_id: Number(open.id) });
      }
      const onRoad = (await client.query("SELECT id FROM dispatches WHERE courier_id=$1 AND status='ON_ROAD' LIMIT 1", [courierId])).rows[0];
      if (onRoad) throw fail(409, "Você possui entregas pendentes. Confirme todas as entregas ou solicite liberação ao administrador.", "PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE");
      await assertOrdersFree(client, links);
      const pd = (await client.query(`INSERT INTO pre_departures(courier_id,status,client_token) VALUES($1,'DRAFT',$2) RETURNING *`,
        [courierId, `pd-${crypto.randomUUID()}`])).rows[0];
      for (const [i, link] of links.entries()) await insertOrder(client, pd.id, i + 1, link);
      await client.query("UPDATE pre_departures SET status='AWAITING_CHECK' WHERE id=$1", [pd.id]);
      await event(client, { preDepartureId: pd.id, name: "CREATED", actorUserId, details: { orders: links } });
      return { id: pd.id, duplicate: false };
    });
    if (!result.duplicate) {
      await audit(actorUserId, "PRE_DEPARTURE_CREATED", "pre_departure", result.id, { courier_id: courierId, orders: links.map(l => ({ order_number: l.order_number, platform: l.platform, external_order_id: l.external_order_id })) });
      emitRealtime("dispatch:changed", { courier_id: courierId, change: "PRE_DEPARTURE_UPDATED" });
    }
    return { ...(await view(result.id)), duplicate: result.duplicate };
  }

  // Trava a pré-saída do motoboy e confere a versão da composição enviada pelo app.
  async function lockForCourier(client, { id, courierId, compositionVersion, allowBlocked = true }) {
    await client.query("SELECT pg_advisory_xact_lock($1::int)", [courierId]);
    const pd = await readPreDeparture(client, id, { lock: true });
    if (!pd || Number(pd.courier_id) !== Number(courierId)) throw fail(404, "Pré-saída não encontrada.", "PRE_DEPARTURE_NOT_FOUND");
    if (!PRE_DEPARTURE_OPEN_STATES.includes(pd.status) || (!allowBlocked && pd.status === "BLOCKED")) {
      throw fail(409, pd.status === "DISPATCHED" ? "Esta pré-saída já virou saída." : "Esta pré-saída não está mais aberta.", "PRE_DEPARTURE_CLOSED", { current_status: pd.status });
    }
    if (compositionVersion !== undefined && Number(compositionVersion) !== Number(pd.composition_version)) {
      throw fail(409, "Os pedidos desta pré-saída mudaram. A tela foi atualizada; confira novamente.", "PRE_DEPARTURE_VERSION_CONFLICT", { composition_version: pd.composition_version });
    }
    return pd;
  }

  async function refreshStatus(client, pd, { clearBlock = false } = {}) {
    const rows = await activeOrders(client, pd.id);
    const settings = await readSettings(client);
    const fresh = await readPreDeparture(client, pd.id);
    const basis = await currentBasis(client, fresh, rows, settings);
    const routeReady = Boolean(fresh.route) && ROUTE_READY_STATUSES.includes(fresh.route_status) && fresh.route_basis === basis;
    const blocked = !clearBlock && fresh.status === "BLOCKED" && Boolean(fresh.blocked_reason);
    const next = deriveStatus({ total: rows.length, checked: rows.filter(r => r.checked_at).length, routeReady, blocked });
    if (!canTransition(fresh.status, next)) throw fail(409, `Transição inválida ${fresh.status} → ${next}.`, "PRE_DEPARTURE_TRANSITION");
    await client.query(`UPDATE pre_departures SET status=$2,blocked_reason=CASE WHEN $3 THEN NULL ELSE blocked_reason END,
      version=version+1,updated_at=NOW(),last_activity_at=NOW() WHERE id=$1`, [pd.id, next, clearBlock]);
    return next;
  }

  async function setCheck({ courierId, id, orderId, compositionVersion, checked = true }) {
    if (Array.isArray(orderId) || !Number.isInteger(Number(orderId)) || Number(orderId) < 1) {
      throw fail(400, "A conferência é individual: confirme uma sacola por vez.", "CHECK_MUST_BE_INDIVIDUAL");
    }
    const outcome = await tx(async client => {
      const pd = await lockForCourier(client, { id, courierId, compositionVersion });
      const row = (await client.query("SELECT * FROM pre_departure_orders WHERE id=$1 AND pre_departure_id=$2 AND active FOR UPDATE", [orderId, id])).rows[0];
      if (!row) throw fail(404, "Esse pedido não faz mais parte da pré-saída.", "PRE_DEPARTURE_ORDER_NOT_FOUND");
      if (Boolean(row.checked_at) === Boolean(checked)) return { changed: false };
      await client.query(`UPDATE pre_departure_orders SET checked_at=$2,checked_by=$3,checked_composition_version=$4 WHERE id=$1`,
        [row.id, checked ? now() : null, checked ? courierId : null, checked ? pd.composition_version : null]);
      const status = await refreshStatus(client, pd);
      await event(client, { preDepartureId: id, name: checked ? "BAG_CHECKED" : "BAG_UNCHECKED", actorUserId: courierId,
        details: { order_number: row.order_number, platform: row.platform, external_order_id: row.external_order_id, composition_version: pd.composition_version, status } });
      return { changed: true };
    });
    if (outcome.changed) emitRealtime("dispatch:changed", { courier_id: courierId, change: "PRE_DEPARTURE_UPDATED" });
    return view(id);
  }

  async function changeComposition({ courierId, id, compositionVersion, mutate, eventName, details }) {
    await tx(async client => {
      const pd = await lockForCourier(client, { id, courierId, compositionVersion });
      const rows = await activeOrders(client, id, { lock: true });
      const info = await mutate(client, pd, rows);
      await client.query(`UPDATE pre_departures SET composition_version=composition_version+1,route=NULL,route_status='PENDING',
        route_basis=NULL,route_error=NULL,admin_override=NULL WHERE id=$1`, [id]);
      // A composição mudou: a rota será recalculada e o bloqueio reavaliado nesse cálculo.
      await refreshStatus(client, pd, { clearBlock: true });
      await event(client, { preDepartureId: id, name: eventName, actorUserId: courierId, details: { ...details, ...info, previous_composition_version: pd.composition_version } });
    });
    emitRealtime("dispatch:changed", { courier_id: courierId, change: "PRE_DEPARTURE_UPDATED" });
    return view(id);
  }

  async function replaceOrder({ courierId, id, orderId, link: rawLink, compositionVersion }) {
    const [link] = normalizeLinks([rawLink]);
    return changeComposition({
      courierId, id, compositionVersion, eventName: "ORDER_REPLACED", details: { new_order: link },
      mutate: async (client, pd, rows) => {
        const old = rows.find(r => Number(r.id) === Number(orderId));
        if (!old) throw fail(404, "Esse pedido não faz mais parte da pré-saída.", "PRE_DEPARTURE_ORDER_NOT_FOUND");
        if (rows.some(r => r.id !== old.id && (`${r.platform}:${r.external_order_id}` === `${link.platform}:${link.external_order_id}` || r.order_number.replace(/^#/, "").toLowerCase() === link.order_number.replace(/^#/, "").toLowerCase()))) {
          throw fail(400, "O mesmo pedido foi informado duas vezes.", "ORDER_DUPLICATED");
        }
        await assertOrdersFree(client, [link], id);
        await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='REPLACED' WHERE id=$1", [old.id]);
        const added = await insertOrder(client, id, old.position, link);
        return { removedRowId: Number(old.id), old_order: { order_number: old.order_number, platform: old.platform, was_checked: Boolean(old.checked_at) }, new_row_id: Number(added.id) };
      }
    });
  }

  async function addOrder({ courierId, id, link: rawLink, compositionVersion }) {
    const [link] = normalizeLinks([rawLink]);
    return changeComposition({
      courierId, id, compositionVersion, eventName: "ORDER_ADDED", details: { new_order: link },
      mutate: async (client, pd, rows) => {
        if (rows.length >= ROUTE_MAX_STOPS) throw fail(409, `A saída pode ter no máximo ${ROUTE_MAX_STOPS} pedidos.`, "PRE_DEPARTURE_LIMIT");
        if (rows.some(r => `${r.platform}:${r.external_order_id}` === `${link.platform}:${link.external_order_id}` || r.order_number.replace(/^#/, "").toLowerCase() === link.order_number.replace(/^#/, "").toLowerCase())) {
          throw fail(400, "O mesmo pedido foi informado duas vezes.", "ORDER_DUPLICATED");
        }
        await assertOrdersFree(client, [link], id);
        const used = new Set(rows.map(r => Number(r.position)));
        const position = [1, 2, 3, 4, 5].find(p => !used.has(p));
        const added = await insertOrder(client, id, position, link);
        return { new_row_id: Number(added.id) };
      }
    });
  }

  async function removeOrder({ courierId, id, orderId, compositionVersion }) {
    return changeComposition({
      courierId, id, compositionVersion, eventName: "ORDER_REMOVED", details: {},
      mutate: async (client, pd, rows) => {
        const old = rows.find(r => Number(r.id) === Number(orderId));
        if (!old) throw fail(404, "Esse pedido não faz mais parte da pré-saída.", "PRE_DEPARTURE_ORDER_NOT_FOUND");
        if (rows.length <= 1) throw fail(409, "A pré-saída precisa de pelo menos 1 pedido. Cancele a pré-saída se for o caso.", "PRE_DEPARTURE_MIN_ORDERS");
        await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='REMOVED' WHERE id=$1", [old.id]);
        return { removedRowId: Number(old.id), old_order: { order_number: old.order_number, platform: old.platform, was_checked: Boolean(old.checked_at) } };
      }
    });
  }

  async function cancel({ actorUserId, id, reason = "", byAdmin = false, courierId = null }) {
    const why = text(reason, 300);
    if (byAdmin && why.length < 5) throw fail(400, "Informe o motivo (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const pd = await tx(async client => {
      const row = await readPreDeparture(client, id, { lock: true });
      if (!row || (!byAdmin && Number(row.courier_id) !== Number(courierId))) throw fail(404, "Pré-saída não encontrada.", "PRE_DEPARTURE_NOT_FOUND");
      if (!PRE_DEPARTURE_OPEN_STATES.includes(row.status)) throw fail(409, "Esta pré-saída não está mais aberta.", "PRE_DEPARTURE_CLOSED", { current_status: row.status });
      await client.query(`UPDATE pre_departures SET status='CANCELLED',closed_at=NOW(),close_reason=$2,version=version+1,updated_at=NOW() WHERE id=$1`,
        [id, byAdmin ? `ADMIN: ${why}` : (why || "COURIER")]);
      await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='CANCELLED' WHERE pre_departure_id=$1 AND active", [id]);
      await event(client, { preDepartureId: id, name: "CANCELLED", actorUserId, details: { by_admin: byAdmin, reason: why } });
      return row;
    });
    await audit(actorUserId, "PRE_DEPARTURE_CANCELLED", "pre_departure", id, { by_admin: byAdmin, reason: why, courier_id: pd.courier_id });
    emitRealtime("dispatch:changed", { courier_id: pd.courier_id, change: "PRE_DEPARTURE_UPDATED" });
    return view(id);
  }

  // Expira só pré-saídas paradas: cada abertura da tela do motoboy renova a atividade,
  // então uma queda de conexão curta não perde a conferência.
  async function expireStale() {
    const { ttl_minutes } = await readSettings();
    const expired = await tx(async client => {
      const rows = (await client.query(`UPDATE pre_departures SET status='EXPIRED',closed_at=NOW(),close_reason='IDLE_TIMEOUT',version=version+1,updated_at=NOW()
        WHERE status = ANY($1::text[]) AND route_status<>'CALCULATING' AND last_activity_at < NOW() - ($2::int * INTERVAL '1 minute')
        RETURNING id,courier_id`, [PRE_DEPARTURE_OPEN_STATES, ttl_minutes])).rows;
      for (const row of rows) {
        await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='EXPIRED' WHERE pre_departure_id=$1 AND active", [row.id]);
        await event(client, { preDepartureId: row.id, name: "EXPIRED", details: { ttl_minutes } });
      }
      return rows;
    });
    for (const row of expired) emitRealtime("dispatch:changed", { courier_id: row.courier_id, change: "PRE_DEPARTURE_UPDATED" });
    return expired.length;
  }

  // Reinício do servidor no meio de um cálculo: volta para PENDING e o app recalcula.
  async function recoverInterrupted() {
    const rows = (await pool.query(`UPDATE pre_departures SET route_status='PENDING',route_basis=NULL,updated_at=NOW()
      WHERE route_status='CALCULATING' RETURNING id,courier_id`)).rows;
    for (const row of rows) await event(pool, { preDepartureId: row.id, name: "ROUTE_RECOVERED_AFTER_RESTART", details: {} });
    return rows.length;
  }

  // ---------------------------------------------------------------- rota
  let routesClient = null;
  const routes = () => (routesClient ||= routesClientFactory());

  async function savedOrigin() {
    const row = (await pool.query("SELECT setting_value FROM app_settings WHERE setting_key=$1", [PRE_DEPARTURE_SETTINGS.store_origin])).rows[0];
    if (!row) return null;
    try {
      const p = JSON.parse(row.setting_value);
      if (!validCoordinate(p)) return null;
      return { latitude: Number(p.latitude), longitude: Number(p.longitude), source: p.source || "GEOCODED", address: LONGE_STORE.address,
        confirmed_by: p.confirmed_by || null, confirmed_at: p.confirmed_at || null };
    } catch { return null; }
  }

  // Ponto de partida: o local confirmado pelo admin no mapa; senão o da zona LONGE; senão a
  // localização precisa do endereço da loja pelo serviço de rotas (a até 400 m do esperado).
  async function knownOrigin() {
    const saved = await savedOrigin();
    if (saved?.source === "ADMIN_CONFIRMED") return saved;
    const zone = (await pool.query("SELECT store_latitude,store_longitude FROM longe_zones ORDER BY id LIMIT 1")).rows[0];
    if (zone) return { latitude: Number(zone.store_latitude), longitude: Number(zone.store_longitude), source: "LONGE_ZONE", address: LONGE_STORE.address };
    return saved;
  }

  async function storeOrigin() {
    const known = await knownOrigin();
    if (known) return known;
    const resolved = await resolveStoreOrigin(routes());
    await pool.query(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,
      [PRE_DEPARTURE_SETTINGS.store_origin, JSON.stringify({ ...resolved, source: "GEOCODED", provider: configuredRouteProvider(env), resolved_at: now().toISOString() })]);
    return { latitude: resolved.latitude, longitude: resolved.longitude, source: "GEOCODED", address: LONGE_STORE.address };
  }

  async function confirmStoreOrigin({ adminId, latitude, longitude, reason }) {
    const why = text(reason, 300);
    if (why.length < 5) throw fail(400, "Informe o motivo (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const point = { latitude: Number(latitude), longitude: Number(longitude) };
    if (!validCoordinate(point)) throw fail(400, "Marque o local da loja no mapa.", "STORE_ORIGIN_INVALID");
    if (haversineMeters(point, LONGE_STORE.approx) > 1500) throw fail(422, "O ponto ficou longe da R. Tapajós, 846. Confira o mapa.", "STORE_ORIGIN_INVALID");
    const before = await savedOrigin();
    await pool.query(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,
      [PRE_DEPARTURE_SETTINGS.store_origin, JSON.stringify({ ...point, source: "ADMIN_CONFIRMED", confirmed_by: adminId, confirmed_at: now().toISOString(), reason: why })]);
    await audit(adminId, "ROUTE_STORE_ORIGIN_CONFIRMED", "setting", null, { reason: why, before, after: point });
    return knownOrigin();
  }

  // Localiza cada parada sem inventar: pino da plataforma ou do admin; senão o endereço
  // completo pelo Google; senão vai para análise do admin.
  async function locateStop(stop, origin) {
    const a = stop.address;
    const label = `Pedido ${stop.order_number}`;
    let point = null, source = null;
    if (a && validCoordinate(a)) {
      point = { latitude: Number(a.latitude), longitude: Number(a.longitude) };
      source = a.source === "ADMIN" ? `ADMIN_${a.location_source || "PIN"}` : "PLATFORM_PIN";
    } else if (a?.address && a.address_complete) {
      const key = addressKey(a.address);
      const cached = (await pool.query("SELECT latitude,longitude FROM route_geocode_cache WHERE address_key=$1", [key])).rows[0];
      if (cached) point = { latitude: Number(cached.latitude), longitude: Number(cached.longitude) };
      else {
        try {
          point = await routes().geocodeAddress(a.address, origin);
        } catch (e) {
          if (["GOOGLE_ROUTES_ADDRESS_NOT_FOUND", "ROUTES_ADDRESS_NOT_FOUND"].includes(e.code)) {
            return { error: { code: "ADDRESS_NOT_FOUND", message: `${label}: o serviço de rotas não localizou o endereço. O admin precisa corrigir.`, order_number: stop.order_number } };
          }
          throw e;
        }
        // Só a rua ou o bairro (sem o número): ambíguo demais para calcular a rota.
        if (point.precise === false) {
          return { error: { code: "ADDRESS_AMBIGUOUS", message: `${label}: o endereço só foi localizado de forma aproximada (rua ou bairro). O admin precisa marcar o ponto no mapa.`, order_number: stop.order_number } };
        }
        await pool.query(`INSERT INTO route_geocode_cache(address_key,latitude,longitude) VALUES($1,$2,$3)
          ON CONFLICT(address_key) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,computed_at=NOW()`, [key, point.latitude, point.longitude]);
      }
      source = "ROUTES_GEOCODE";
    } else {
      return { error: { code: "ADDRESS_INCOMPLETE", message: `${label}: endereço incompleto (falta rua, número ou cidade) e sem localização. O admin precisa corrigir.`, order_number: stop.order_number } };
    }
    const distance = haversineMeters(origin, point);
    if (distance > ROUTE_REGION_MAX_METERS) {
      return { error: { code: "ADDRESS_OUT_OF_REGION", message: `${label}: localização a ${(distance / 1000).toFixed(1)} km da loja. O endereço pode estar errado ou ambíguo.`, order_number: stop.order_number } };
    }
    return { point, source };
  }

  async function travelMinutes(points) {
    const keys = points.map(pointKey);
    const pairs = [];
    for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) if (i !== j) pairs.push([i, j]);
    const cached = (await pool.query(`SELECT from_key,to_key,duration_seconds FROM route_matrix_cache
      WHERE from_key = ANY($1::text[]) AND to_key = ANY($1::text[]) AND computed_at >= NOW() - ($2::int * INTERVAL '1 day')`, [keys, MATRIX_CACHE_DAYS])).rows;
    const map = new Map(cached.map(r => [`${r.from_key}>${r.to_key}`, Number(r.duration_seconds)]));
    let elements = 0;
    if (pairs.some(([i, j]) => keys[i] !== keys[j] && !map.has(`${keys[i]}>${keys[j]}`))) {
      const matrix = await routes().travelMatrix(points);
      elements = points.length * points.length;
      for (const [i, j] of pairs) {
        const seconds = matrix.seconds[i][j];
        if (seconds === null || seconds === undefined) continue;
        map.set(`${keys[i]}>${keys[j]}`, seconds);
        await pool.query(`INSERT INTO route_matrix_cache(from_key,to_key,duration_seconds,distance_meters) VALUES($1,$2,$3,$4)
          ON CONFLICT(from_key,to_key) DO UPDATE SET duration_seconds=EXCLUDED.duration_seconds,distance_meters=EXCLUDED.distance_meters,computed_at=NOW()`,
          [keys[i], keys[j], seconds, matrix.meters[i][j]]);
      }
    }
    const minutes = points.map((_, i) => points.map((__, j) => {
      if (i === j || keys[i] === keys[j]) return 0;
      const s = map.get(`${keys[i]}>${keys[j]}`);
      return s === undefined ? null : Math.round(s / 6) / 10;
    }));
    return { minutes, elements };
  }

  function typedRoute(stops, status, extra = {}) {
    return {
      route_status: status,
      route: {
        source: status === "ADMIN" ? "ADMIN_SEQUENCE" : "TYPED_ORDER",
        computed_at: now().toISOString(),
        stops: stops.map((s, i) => ({ sequence: i + 1, order_number: s.order_number, platform: s.platform, external_order_id: s.external_order_id, typed_position: s.position, address_version: s.address?.version || 0 })),
        ...extra
      }
    };
  }

  // stops: [{order_number, platform, external_order_id, position, created_at, address}]
  async function planWithGoogle(stops, params, { origin: forcedOrigin = null, elapsedMinutes = 0 } = {}) {
    let origin;
    try {
      origin = forcedOrigin || await storeOrigin();
    } catch (e) {
      const notConfigured = ["GOOGLE_ROUTES_NOT_CONFIGURED", "ROUTES_NOT_CONFIGURED"].includes(e.code);
      return { route_status: "NEEDS_ADMIN", error: { code: e.code || "ROUTE_ORIGIN_UNAVAILABLE", message: notConfigured ? "Rota indisponível: o serviço de rotas não está configurado." : `Rota indisponível: ${e.message}`, retryable: true } };
    }
    const located = [];
    const problems = [];
    for (const stop of stops) {
      try {
        const found = await locateStop(stop, origin);
        if (found.error) problems.push(found.error);
        else located.push({ ...stop, point: found.point, location_source: found.source });
      } catch (e) {
        return { route_status: "NEEDS_ADMIN", error: { code: e.code || "ROUTE_SERVICE_FAILED", message: `Rota indisponível: ${e.message}`, retryable: true } };
      }
    }
    if (problems.length) {
      return { route_status: "NEEDS_ADMIN", error: { code: problems[0].code, message: problems.map(p => p.message).join(" "), problems, retryable: false } };
    }
    const at = now().getTime();
    const ages = located.map(s => {
      const created = s.created_at ? new Date(s.created_at).getTime() : NaN;
      return Number.isFinite(created) ? Math.max(0, (at - created) / 60000) : null;
    });
    if (ages.some(a => a === null)) {
      return { route_status: "NEEDS_ADMIN", error: { code: "ROUTE_ORDER_TIME_MISSING", message: "Horário original de um pedido não chegou da plataforma.", retryable: true } };
    }
    let matrix;
    try {
      matrix = await travelMinutes([origin, ...located.map(s => s.point)]);
    } catch (e) {
      return { route_status: "NEEDS_ADMIN", error: { code: e.code || "ROUTE_SERVICE_FAILED", message: `Rota indisponível: ${e.message}`, retryable: true } };
    }
    let plan;
    try {
      plan = planRoute({ stops: located.map((s, i) => ({ key: i, age_minutes: ages[i] })), minutes: matrix.minutes, params });
    } catch (e) {
      return { route_status: "NEEDS_ADMIN", error: { code: e.code || "ROUTE_PLAN_FAILED", message: e.message, retryable: e.code === "ROUTE_MATRIX_INCOMPLETE" } };
    }
    const best = plan.best;
    const summarize = c => c && ({ sequence: c.order.map(i => located[i].order_number), cost: round1(c.cost), duration_minutes: round1(c.duration_minutes), total_wait_minutes: round1(c.total_wait_minutes), max_wait_minutes: round1(c.max_wait_minutes) });
    return {
      route_status: "READY",
      elements: matrix.elements,
      route: {
        source: "ROAD_MATRIX",
        provider: routesClient?.provider || configuredRouteProvider(env),
        // Tempos do cache também vieram do serviço: a atribuição vale sempre.
        attribution: routesClient?.attribution ?? (configuredRouteProvider(env) === "openrouteservice" ? ORS_ATTRIBUTION : null),
        travel_mode: "DRIVE",
        routing_preference: "TRAFFIC_UNAWARE",
        computed_at: new Date(at).toISOString(),
        origin: { ...origin, elapsed_minutes: elapsedMinutes },
        params: plan.params,
        evaluated: plan.evaluated,
        duration_minutes: best.duration_minutes,
        total_wait_minutes: best.total_wait_minutes,
        max_wait_minutes: best.max_wait_minutes,
        penalty: best.penalty,
        cost: best.cost,
        stops: best.stops.map(s => {
          const stop = located[s.stop];
          return {
            sequence: s.position,
            order_number: stop.order_number,
            platform: stop.platform,
            external_order_id: stop.external_order_id,
            typed_position: stop.position,
            leg_minutes: s.leg_minutes,
            arrival_minutes: s.arrival_minutes,
            wait_minutes: s.wait_minutes,
            age_minutes: s.age_minutes,
            excess_minutes: s.excess_minutes,
            latitude: stop.point.latitude,
            longitude: stop.point.longitude,
            location_source: stop.location_source,
            address_version: stop.address?.version || 0
          };
        }),
        typed_order: summarize(plan.typed_order),
        runner_up: summarize(plan.runner_up),
        matrix_minutes: matrix.minutes,
        matrix_elements: matrix.elements
      }
    };
  }

  async function snapshotStops(client, pd) {
    const rows = await activeOrders(client, pd.id);
    const data = await loadOrders(client, rows);
    return rows.map(r => {
      const d = data.get(`${r.platform}:${r.external_order_id}`) || {};
      return { id: Number(r.id), position: Number(r.position), order_number: r.order_number, platform: r.platform, external_order_id: r.external_order_id,
        checked: Boolean(r.checked_at), created_at: d.created_at || null, status: d.status || "", address: operationalAddress(d) };
    });
  }

  function cancelledOnPlatform(stop) {
    return stop.platform === "ifood" ? stop.status === "CANCELLED" : ["CANCELLED", "DENIED", "CANCELLATION_REQUESTED"].includes(stop.status);
  }

  async function computeRoute(id, { courierId = null, force = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pd = await readPreDeparture(pool, id);
      if (!pd || (courierId !== null && Number(pd.courier_id) !== Number(courierId))) throw fail(404, "Pré-saída não encontrada.", "PRE_DEPARTURE_NOT_FOUND");
      if (!PRE_DEPARTURE_OPEN_STATES.includes(pd.status)) return view(id);
      const settings = await readSettings();
      const stops = await snapshotStops(pool, pd);
      if (stops.some(s => !s.checked)) throw fail(409, "Confira todas as sacolas antes de calcular a rota.", "PRE_DEPARTURE_CHECK_PENDING");
      const basis = routeBasis({ compositionVersion: pd.composition_version, orders: stops.map(s => ({ ...s, address_version: s.address?.version || 0 })), plannerEnabled: settings.route_planner, params: settings.params });
      if (!force && pd.route_basis === basis && pd.route_status !== "PENDING" && pd.route_status !== "CALCULATING") return view(id);
      // Duplo toque: outro cálculo da mesma base acabou de começar.
      if (pd.route_status === "CALCULATING" && pd.route_basis === basis && now().getTime() - new Date(pd.updated_at).getTime() < 30000) return view(id);
      const cancelled = stops.find(cancelledOnPlatform);
      let outcome;
      if (cancelled) {
        outcome = { route_status: "NEEDS_ADMIN", error: { code: "ORDER_CANCELLED", message: `Pedido ${cancelled.order_number} foi cancelado na plataforma. Retire ou troque o pedido.`, order_row_id: cancelled.id, retryable: false } };
      } else {
        const marked = await pool.query(`UPDATE pre_departures SET route_status='CALCULATING',route_basis=$2,updated_at=NOW()
          WHERE id=$1 AND composition_version=$3 AND status = ANY($4::text[])`, [id, basis, pd.composition_version, PRE_DEPARTURE_OPEN_STATES]);
        if (!marked.rowCount) continue;
        outcome = settings.route_planner ? await planWithGoogle(stops, settings.params) : typedRoute(stops, "DISABLED");
      }
      const committed = await tx(async client => {
        const fresh = await readPreDeparture(client, id, { lock: true });
        if (!fresh || !PRE_DEPARTURE_OPEN_STATES.includes(fresh.status)) return true;
        const rows = await activeOrders(client, id);
        const nowBasis = await currentBasis(client, fresh, rows, await readSettings(client));
        if (nowBasis !== basis) return false; // endereço/composição mudou durante o cálculo
        if (fresh.route_status !== "CALCULATING" && fresh.route_basis === basis && !cancelled) return true;
        const ready = ROUTE_READY_STATUSES.includes(outcome.route_status);
        const blocked = ready ? null : { kind: "ROUTE", ...outcome.error };
        const allChecked = rows.every(r => r.checked_at);
        const status = blocked ? "BLOCKED" : deriveStatus({ total: rows.length, checked: rows.filter(r => r.checked_at).length, routeReady: allChecked });
        await client.query(`UPDATE pre_departures SET route=$2::jsonb,route_status=$3,route_error=$4::jsonb,route_basis=$5,route_version=route_version+1,
          route_calculated_at=NOW(),status=$6,blocked_reason=$7::jsonb,admin_override=NULL,version=version+1,updated_at=NOW(),last_activity_at=NOW() WHERE id=$1`,
          [id, ready ? JSON.stringify(outcome.route) : null, ready ? outcome.route_status : "NEEDS_ADMIN", blocked ? JSON.stringify(outcome.error) : null, basis, status, blocked ? JSON.stringify(blocked) : null]);
        await event(client, { preDepartureId: id, name: ready ? "ROUTE_CALCULATED" : "ROUTE_NEEDS_ADMIN", details: ready
          ? { route_status: outcome.route_status, sequence: outcome.route.stops.map(s => s.order_number), evaluated: outcome.route.evaluated ?? null, cost: outcome.route.cost ?? null, matrix_elements: outcome.elements || 0 }
          : outcome.error });
        return true;
      });
      if (!committed) continue;
      const after = await view(id);
      emitRealtime("dispatch:changed", { courier_id: pd.courier_id, change: "PRE_DEPARTURE_UPDATED" });
      if (after.status === "BLOCKED") emitRealtime("notification:changed", {});
      return after;
    }
    throw fail(409, "Os dados mudaram durante o cálculo. Tente novamente.", "ROUTE_BASIS_CHANGED");
  }

  async function acknowledge({ courierId, id, version }) {
    await tx(async client => {
      const pd = await lockForCourier(client, { id, courierId });
      if (version !== undefined && Number(version) !== Number(pd.version)) {
        throw fail(409, "Há uma alteração mais nova. A tela foi atualizada.", "PRE_DEPARTURE_VERSION_CONFLICT", { version: pd.version });
      }
      if (!pd.ack_required) return;
      await client.query("UPDATE pre_departures SET ack_required=FALSE,version=version+1,updated_at=NOW(),last_activity_at=NOW() WHERE id=$1", [id]);
      await event(client, { preDepartureId: id, name: "ADDRESS_CHANGE_ACKNOWLEDGED", actorUserId: courierId, details: { version: pd.version } });
    });
    emitRealtime("dispatch:changed", { courier_id: courierId, change: "PRE_DEPARTURE_UPDATED" });
    return view(id);
  }

  // Exceção administrativa: sequência definida pelo admin (ou a ordem digitada) quando
  // a rota não pôde ser calculada. Fica auditada e vale só para a composição atual.
  async function adminSequence({ adminId, id, sequence = null, reason }) {
    const why = text(reason, 300);
    if (why.length < 5) throw fail(400, "Informe o motivo (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const pd = await tx(async client => {
      const row = await readPreDeparture(client, id, { lock: true });
      if (!row || !PRE_DEPARTURE_OPEN_STATES.includes(row.status)) throw fail(409, "Esta pré-saída não está aberta.", "PRE_DEPARTURE_CLOSED");
      const stops = await snapshotStops(client, row);
      let ordered = stops;
      if (Array.isArray(sequence) && sequence.length) {
        const ids = sequence.map(Number);
        if (ids.length !== stops.length || new Set(ids).size !== ids.length || !ids.every(x => stops.some(s => s.id === x))) {
          throw fail(400, "A sequência precisa conter cada pedido da pré-saída uma vez.", "SEQUENCE_INVALID");
        }
        ordered = ids.map(x => stops.find(s => s.id === x));
      }
      const settings = await readSettings(client);
      const basis = routeBasis({ compositionVersion: row.composition_version, orders: stops.map(s => ({ ...s, address_version: s.address?.version || 0 })), plannerEnabled: settings.route_planner, params: settings.params });
      const override = { kind: "ADMIN_SEQUENCE", by: adminId, reason: why, at: now().toISOString(), previous_error: row.route_error || null };
      const { route } = typedRoute(ordered, "ADMIN", { admin: override });
      const allChecked = stops.every(s => s.checked);
      const status = deriveStatus({ total: stops.length, checked: stops.filter(s => s.checked).length, routeReady: allChecked });
      if (!canTransition(row.status, status)) throw fail(409, "Transição inválida.", "PRE_DEPARTURE_TRANSITION");
      await client.query(`UPDATE pre_departures SET route=$2::jsonb,route_status='ADMIN',route_error=NULL,route_basis=$3,route_version=route_version+1,
        route_calculated_at=NOW(),admin_override=$4::jsonb,blocked_reason=NULL,status=$5,ack_required=TRUE,version=version+1,updated_at=NOW() WHERE id=$1`,
        [id, JSON.stringify(route), basis, JSON.stringify(override), status]);
      await event(client, { preDepartureId: id, name: "ADMIN_SEQUENCE", actorUserId: adminId, details: { ...override, sequence: ordered.map(s => s.order_number) } });
      return row;
    });
    await audit(adminId, "PRE_DEPARTURE_ADMIN_SEQUENCE", "pre_departure", id, { reason: why, courier_id: pd.courier_id, sequence });
    emitRealtime("dispatch:changed", { courier_id: pd.courier_id, change: "PRE_DEPARTURE_UPDATED" });
    return view(id);
  }

  // ---------------------------------------------------------------- saída definitiva
  // Chamado pelo despacho existente ANTES de criar a saída: devolve exatamente os pedidos
  // da pré-saída e o token idempotente dela.
  async function prepareDispatch({ courierId, id, compositionVersion }) {
    const pd = await readPreDeparture(pool, id);
    if (!pd || Number(pd.courier_id) !== Number(courierId)) throw fail(404, "Pré-saída não encontrada.", "PRE_DEPARTURE_NOT_FOUND");
    const rows = (await pool.query(`SELECT * FROM pre_departure_orders WHERE pre_departure_id=$1 AND (active OR release_reason='DISPATCHED') ORDER BY position`, [id])).rows;
    const payload = {
      client_token: pd.client_token,
      composition_version: pd.composition_version,
      order_numbers: rows.map(r => r.order_number),
      platform_selections: rows.map(r => ({ order_number: r.order_number, platform: r.platform, external_order_id: r.external_order_id })),
      already_dispatched: pd.status === "DISPATCHED"
    };
    if (pd.status === "DISPATCHED") return payload;
    if (compositionVersion !== undefined && Number(compositionVersion) !== Number(pd.composition_version)) {
      throw fail(409, "Os pedidos desta pré-saída mudaram. Confira a tela antes de sair.", "PRE_DEPARTURE_VERSION_CONFLICT");
    }
    const v = await view(id);
    if (!v.can_dispatch) {
      const first = v.blockers[0] || { code: "PRE_DEPARTURE_NOT_READY", message: "A pré-saída ainda não está pronta." };
      throw fail(409, first.message, first.code === "CHECK_PENDING" ? "PRE_DEPARTURE_CHECK_PENDING" : first.code, { blockers: v.blockers });
    }
    return payload;
  }

  // Dentro da transação do despacho: revalida tudo com a linha travada e grava a sequência.
  async function bindDispatch(client, { preDepartureId, courierId, compositionVersion, dispatchId, links }) {
    const pd = await readPreDeparture(client, preDepartureId, { lock: true });
    if (!pd || Number(pd.courier_id) !== Number(courierId)) throw fail(409, "Pré-saída não encontrada.", "PRE_DEPARTURE_NOT_FOUND");
    if (!["ROUTE_READY"].includes(pd.status)) throw fail(409, "A pré-saída não está pronta para a saída.", pd.status === "DISPATCHED" ? "PRE_DEPARTURE_CLOSED" : "PRE_DEPARTURE_NOT_READY", { current_status: pd.status });
    if (compositionVersion !== undefined && Number(compositionVersion) !== Number(pd.composition_version)) throw fail(409, "Os pedidos desta pré-saída mudaram.", "PRE_DEPARTURE_VERSION_CONFLICT");
    if (pd.ack_required) throw fail(409, "Toque em Ciente na alteração de endereço antes de sair.", "ACK_REQUIRED");
    const rows = await activeOrders(client, preDepartureId, { lock: true });
    const want = new Set(links.map(l => `${l.platform}:${l.external_order_id}`));
    if (rows.length !== want.size || !rows.every(r => want.has(`${r.platform}:${r.external_order_id}`))) {
      throw fail(409, "Os pedidos enviados não são os da pré-saída.", "PRE_DEPARTURE_ORDERS_CHANGED");
    }
    if (rows.some(r => !r.checked_at)) {
      throw fail(409, "Há sacola sem conferência.", "PRE_DEPARTURE_CHECK_PENDING");
    }
    const settings = await readSettings(client);
    const basis = await currentBasis(client, pd, rows, settings);
    if (!pd.route || !ROUTE_READY_STATUSES.includes(pd.route_status) || pd.route_basis !== basis) {
      throw fail(409, "A rota está desatualizada. Calcule de novo antes de sair.", "ROUTE_STALE");
    }
    await client.query(`UPDATE pre_departures SET status='DISPATCHED',dispatch_id=$2,dispatched_at=NOW(),closed_at=NOW(),close_reason='DISPATCHED',
      version=version+1,updated_at=NOW() WHERE id=$1`, [preDepartureId, dispatchId]);
    await client.query("UPDATE pre_departure_orders SET active=FALSE,released_at=NOW(),release_reason='DISPATCHED' WHERE pre_departure_id=$1 AND active", [preDepartureId]);
    await client.query(`INSERT INTO dispatch_routes(dispatch_id,pre_departure_id,route_version,route_status,route,acked_version)
      VALUES($1,$2,1,$3,$4::jsonb,1)`, [dispatchId, preDepartureId, pd.route_status, JSON.stringify({ ...pd.route, history: [{ version: 1, cause: "DEPARTURE", at: now().toISOString() }] })]);
    for (const stop of pd.route.stops) {
      const row = rows.find(r => r.platform === stop.platform && r.external_order_id === stop.external_order_id);
      await client.query(`INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id,checked_at,checked_by,eta_minutes,address_version,changed_in_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
        [dispatchId, stop.sequence, stop.order_number, stop.platform, stop.external_order_id, row.checked_at, row.checked_by, stop.arrival_minutes ?? null, stop.address_version || 0]);
    }
    await event(client, { preDepartureId, dispatchId, name: "DISPATCHED", actorUserId: courierId, details: { composition_version: pd.composition_version, route_status: pd.route_status, sequence: pd.route.stops.map(s => s.order_number) } });
    return { pre_departure_id: Number(preDepartureId) };
  }

  async function block({ id, code, message, orderNumber = null }) {
    const pd = await readPreDeparture(pool, id);
    if (!pd || !PRE_DEPARTURE_OPEN_STATES.includes(pd.status)) return;
    const row = orderNumber ? (await pool.query("SELECT id FROM pre_departure_orders WHERE pre_departure_id=$1 AND active AND LOWER(order_number)=LOWER($2)", [id, orderNumber])).rows[0] : null;
    await pool.query(`UPDATE pre_departures SET status='BLOCKED',blocked_reason=$2::jsonb,version=version+1,updated_at=NOW() WHERE id=$1`,
      [id, JSON.stringify({ code, message, order_number: orderNumber, order_row_id: row ? Number(row.id) : null })]);
    await event(pool, { preDepartureId: id, name: "BLOCKED", details: { code, message, order_number: orderNumber } });
    emitRealtime("dispatch:changed", { courier_id: pd.courier_id, change: "PRE_DEPARTURE_UPDATED" });
  }

  // ---------------------------------------------------------------- rota em andamento
  async function routeStops(client, dispatchId) {
    return (await client.query(`
      SELECT s.*,
        CASE WHEN s.platform='ifood' THEN (UPPER(COALESCE(io.status,'')) IN ('CONCLUDED','DELIVERED') OR UPPER(COALESCE(idc.status,'')) IN ('VERIFIED','CONCLUDED'))
             ELSE (adc.confirmed_at IS NOT NULL OR UPPER(COALESCE(ao.status,''))='FINISHED') END AS delivered,
        CASE WHEN s.platform='ifood' THEN UPPER(COALESCE(io.status,''))='CANCELLED'
             ELSE UPPER(COALESCE(ao.status,'')) IN ('CANCELLED','DENIED','CANCELLATION_REQUESTED') END AS cancelled,
        COALESCE(idc.verified_at,idc.concluded_at,adc.confirmed_at) AS delivered_at,
        EXISTS (SELECT 1 FROM dispatch_orders o WHERE o.dispatch_id=s.dispatch_id AND o.platform=s.platform AND LOWER(o.order_number)=LOWER(s.order_number)) AS in_dispatch
      FROM dispatch_route_stops s
      LEFT JOIN ifood_orders io ON s.platform='ifood' AND io.order_id=s.external_order_id
      LEFT JOIN ifood_delivery_confirmations idc ON s.platform='ifood' AND idc.ifood_order_id=s.external_order_id
      LEFT JOIN anotaai_orders ao ON s.platform='anotaai' AND ao.order_id=s.external_order_id
      LEFT JOIN anotaai_delivery_confirmations adc ON s.platform='anotaai' AND adc.anotaai_order_id=s.external_order_id AND adc.dispatch_id=s.dispatch_id
      WHERE s.dispatch_id=$1 ORDER BY s.sequence`, [dispatchId])).rows;
  }

  async function dispatchRouteView(dispatchId, { client = pool } = {}) {
    const route = (await client.query("SELECT * FROM dispatch_routes WHERE dispatch_id=$1", [dispatchId])).rows[0];
    if (!route) return null;
    const dispatch = (await client.query("SELECT id,courier_id,status,departed_at FROM dispatches WHERE id=$1", [dispatchId])).rows[0];
    const stops = (await routeStops(client, dispatchId)).filter(s => s.in_dispatch);
    const data = await loadOrders(client, stops);
    // Pedidos incluídos depois pelo admin ficam no fim, fora da sequência calculada.
    const extra = (await client.query(`SELECT o.order_number,o.platform FROM dispatch_orders o WHERE o.dispatch_id=$1 AND NOT EXISTS (
      SELECT 1 FROM dispatch_route_stops s WHERE s.dispatch_id=o.dispatch_id AND s.platform=o.platform AND LOWER(s.order_number)=LOWER(o.order_number)) ORDER BY o.id`, [dispatchId])).rows;
    let nextFound = false;
    const items = stops.map(s => {
      const d = data.get(`${s.platform}:${s.external_order_id}`) || {};
      const address = operationalAddress(d);
      const state = s.delivered ? "DELIVERED" : s.cancelled ? "CANCELLED" : "PENDING";
      const isNext = state === "PENDING" && !nextFound;
      if (isNext) nextFound = true;
      return {
        sequence: Number(s.sequence),
        order_number: s.order_number,
        platform: s.platform,
        platform_label: PLATFORM_LABEL[s.platform],
        external_order_id: s.external_order_id,
        state,
        is_next: isNext,
        delivered_at: s.delivered_at,
        customer_name: d.customer_name || "",
        address: address ? { text: address.address, fields: address.fields, source: address.source, version: address.version } : null,
        address_override: address?.source === "ADMIN" ? { version: address.version, changed_at: address.changed_at, reason: address.reason, original: d.platform_address?.address || null } : null,
        changed_unacked: route.ack_required && Number(s.changed_in_version || 0) > Number(route.acked_version || 0),
        navigation: navigationFor(address),
        eta_minutes: s.eta_minutes === null ? null : round1(s.eta_minutes)
      };
    });
    // Desvio da sequência: entrega confirmada antes de uma parada anterior pendente. Não
    // reordena nada; só registra uma vez para o admin.
    for (const item of items) {
      if (item.state !== "DELIVERED") continue;
      const skipped = items.filter(x => x.sequence < item.sequence && x.state === "PENDING");
      if (skipped.length) {
        await event(pool, { dispatchId, name: "ROUTE_SEQUENCE_DEVIATION", details: { delivered: item.order_number, sequence: item.sequence, skipped: skipped.map(x => x.order_number) }, dedupeKey: `deviation:${dispatchId}:${item.platform}:${item.external_order_id}` });
      }
    }
    return {
      dispatch_id: Number(dispatchId),
      courier_id: dispatch ? Number(dispatch.courier_id) : null,
      dispatch_status: dispatch?.status || null,
      departed_at: dispatch?.departed_at || null,
      route_version: Number(route.route_version),
      route_status: route.route_status,
      ack_required: route.ack_required,
      acked_version: Number(route.acked_version),
      duration_minutes: round1(route.route?.duration_minutes),
      source: route.route?.source || null,
      last_change: (route.route?.history || []).at(-1) || null,
      stops: items,
      extra_orders: extra,
      counts: {
        total: items.length,
        delivered: items.filter(i => i.state === "DELIVERED").length,
        pending: items.filter(i => i.state === "PENDING").length
      }
    };
  }

  async function activeRouteForCourier(courierId) {
    const d = (await pool.query("SELECT d.id FROM dispatches d JOIN dispatch_routes r ON r.dispatch_id=d.id WHERE d.courier_id=$1 AND d.status='ON_ROAD' ORDER BY d.id DESC LIMIT 1", [courierId])).rows[0];
    return d ? dispatchRouteView(d.id) : null;
  }

  // Recalcula só o que falta entregar. Origem confiável: a última entrega confirmada
  // (o motoboy estava lá) ou, se ainda não entregou nada, a loja. Sem posição inventada.
  async function recalculatePending(dispatchId, { actorUserId = null, cause, reason = null }) {
    const routeRow = (await pool.query("SELECT * FROM dispatch_routes WHERE dispatch_id=$1", [dispatchId])).rows[0];
    if (!routeRow) return null;
    const settings = await readSettings();
    const all = (await routeStops(pool, dispatchId)).filter(s => s.in_dispatch);
    const data = await loadOrders(pool, all);
    const resolved = all.filter(s => s.delivered || s.cancelled);
    const pending = all.filter(s => !s.delivered && !s.cancelled);
    if (!pending.length) return dispatchRouteView(dispatchId);
    const lastDelivered = all.filter(s => s.delivered && s.delivered_at).sort((a, b) => new Date(b.delivered_at) - new Date(a.delivered_at))[0] || null;
    const dispatch = (await pool.query("SELECT courier_id,departed_at FROM dispatches WHERE id=$1", [dispatchId])).rows[0];
    let origin = null, originLabel = "LOJA", outcome;
    if (lastDelivered) {
      const addr = operationalAddress(data.get(`${lastDelivered.platform}:${lastDelivered.external_order_id}`));
      if (addr && validCoordinate(addr)) {
        origin = { latitude: Number(addr.latitude), longitude: Number(addr.longitude), source: "LAST_CONFIRMED_DELIVERY", order_number: lastDelivered.order_number };
        originLabel = `ENTREGA ${lastDelivered.order_number}`;
      }
    }
    const stops = pending.map(s => {
      const d = data.get(`${s.platform}:${s.external_order_id}`) || {};
      return { order_number: s.order_number, platform: s.platform, external_order_id: s.external_order_id, position: Number(s.sequence), created_at: d.created_at, address: operationalAddress(d) };
    });
    if (lastDelivered && !origin) {
      outcome = { route_status: "NEEDS_ADMIN", error: { code: "ROUTE_ORIGIN_UNTRUSTED", message: `Sem localização confiável da última entrega (${lastDelivered.order_number}). Defina a sequência manualmente.` } };
    } else if (!settings.route_planner) {
      outcome = typedRoute(stops, "DISABLED");
    } else {
      outcome = await planWithGoogle(stops, settings.params, { origin });
    }
    const ready = outcome.route_status === "READY" || outcome.route_status === "DISABLED";
    const newOrder = ready ? outcome.route.stops.map(s => `${s.platform}:${s.external_order_id}`) : pending.map(s => `${s.platform}:${s.external_order_id}`);
    const view = await tx(async client => {
      const fresh = (await client.query("SELECT * FROM dispatch_routes WHERE dispatch_id=$1 FOR UPDATE", [dispatchId])).rows[0];
      if (Number(fresh.route_version) !== Number(routeRow.route_version)) throw fail(409, "A rota mudou durante o recálculo. Tente de novo.", "ROUTE_VERSION_CONFLICT");
      const version = Number(fresh.route_version) + 1;
      const ordered = [...resolved.sort((a, b) => a.sequence - b.sequence).map(s => `${s.platform}:${s.external_order_id}`), ...newOrder];
      const before = new Map(all.map(s => [`${s.platform}:${s.external_order_id}`, s]));
      for (const [i, key] of ordered.entries()) {
        const s = before.get(key);
        const planned = ready ? outcome.route.stops.find(x => `${x.platform}:${x.external_order_id}` === key) : null;
        const addressVersion = data.get(key)?.override?.version || 0;
        const changed = Number(s.sequence) !== i + 1 || Number(s.address_version) !== addressVersion;
        await client.query(`UPDATE dispatch_route_stops SET sequence=$2,eta_minutes=$3,address_version=$4,changed_in_version=CASE WHEN $5 THEN $6 ELSE changed_in_version END WHERE id=$1`,
          [s.id, i + 1, planned?.arrival_minutes ?? (s.delivered || s.cancelled ? s.eta_minutes : null), addressVersion, changed, version]);
      }
      const history = [...(fresh.route?.history || []), { version, cause, reason, at: now().toISOString(), by: actorUserId, origin: originLabel, route_status: outcome.route_status, error: outcome.error || null, pending_sequence: newOrder.map(k => before.get(k).order_number) }];
      const routeJson = { ...(fresh.route || {}), ...(ready ? { pending_plan: outcome.route } : {}), history };
      await client.query(`UPDATE dispatch_routes SET route_version=$2,route_status=$3,route=$4::jsonb,ack_required=TRUE,updated_at=NOW() WHERE dispatch_id=$1`,
        [dispatchId, version, ready ? outcome.route_status : "NEEDS_ADMIN", JSON.stringify(routeJson)]);
      await event(client, { dispatchId, name: ready ? "ROUTE_RECALCULATED" : "ROUTE_NEEDS_ADMIN", actorUserId, details: { cause, reason, version, origin: originLabel, pending_sequence: history.at(-1).pending_sequence, error: outcome.error || null } });
      return version;
    });
    emitRealtime("dispatch:changed", { courier_id: dispatch.courier_id, dispatch_id: Number(dispatchId), change: "ROUTE_UPDATED" });
    return { version: view, ...(await dispatchRouteView(dispatchId)) };
  }

  async function acknowledgeRoute({ courierId, dispatchId, routeVersion }) {
    await tx(async client => {
      const route = (await client.query(`SELECT r.* FROM dispatch_routes r JOIN dispatches d ON d.id=r.dispatch_id WHERE r.dispatch_id=$1 AND d.courier_id=$2 FOR UPDATE OF r`, [dispatchId, courierId])).rows[0];
      if (!route) throw fail(404, "Rota não encontrada.", "ROUTE_NOT_FOUND");
      if (Number(routeVersion) !== Number(route.route_version)) throw fail(409, "Há uma alteração mais nova. A tela foi atualizada.", "ROUTE_VERSION_CONFLICT", { route_version: route.route_version });
      await client.query("UPDATE dispatch_routes SET ack_required=FALSE,acked_version=route_version,acked_at=NOW(),updated_at=NOW() WHERE dispatch_id=$1", [dispatchId]);
      await event(client, { dispatchId, name: "ROUTE_ACKNOWLEDGED", actorUserId: courierId, details: { route_version: route.route_version } });
    });
    emitRealtime("dispatch:changed", { courier_id: courierId, dispatch_id: Number(dispatchId), change: "ROUTE_UPDATED" });
    return dispatchRouteView(dispatchId);
  }

  // Exceção do admin durante a saída: nova ordem das paradas pendentes, com motivo.
  async function adminResequenceRoute({ adminId, dispatchId, sequence, reason }) {
    const why = text(reason, 300);
    if (why.length < 5) throw fail(400, "Informe o motivo (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const all = (await routeStops(pool, dispatchId)).filter(s => s.in_dispatch);
    const pending = all.filter(s => !s.delivered && !s.cancelled);
    const keys = (Array.isArray(sequence) ? sequence : []).map(String);
    if (keys.length !== pending.length || new Set(keys).size !== keys.length || !keys.every(k => pending.some(s => `${s.platform}:${s.external_order_id}` === k))) {
      throw fail(400, "Informe a nova ordem com todas as entregas pendentes, uma vez cada.", "SEQUENCE_INVALID");
    }
    const resolved = all.filter(s => s.delivered || s.cancelled).sort((a, b) => a.sequence - b.sequence);
    const courierId = await tx(async client => {
      const route = (await client.query("SELECT * FROM dispatch_routes WHERE dispatch_id=$1 FOR UPDATE", [dispatchId])).rows[0];
      if (!route) throw fail(404, "Rota não encontrada.", "ROUTE_NOT_FOUND");
      const version = Number(route.route_version) + 1;
      const ordered = [...resolved.map(s => `${s.platform}:${s.external_order_id}`), ...keys];
      for (const [i, key] of ordered.entries()) {
        const s = all.find(x => `${x.platform}:${x.external_order_id}` === key);
        await client.query(`UPDATE dispatch_route_stops SET sequence=$2,eta_minutes=CASE WHEN $3 THEN eta_minutes ELSE NULL END,changed_in_version=CASE WHEN sequence<>$2 THEN $4 ELSE changed_in_version END WHERE id=$1`,
          [s.id, i + 1, Boolean(s.delivered || s.cancelled), version]);
      }
      const history = [...(route.route?.history || []), { version, cause: "ADMIN_RESEQUENCE", reason: why, by: adminId, at: now().toISOString(), pending_sequence: keys.map(k => all.find(x => `${x.platform}:${x.external_order_id}` === k).order_number) }];
      await client.query(`UPDATE dispatch_routes SET route_version=$2,route_status='ADMIN',route=$3::jsonb,ack_required=TRUE,updated_at=NOW() WHERE dispatch_id=$1`,
        [dispatchId, version, JSON.stringify({ ...(route.route || {}), history })]);
      await event(client, { dispatchId, name: "ADMIN_RESEQUENCE", actorUserId: adminId, details: history.at(-1) });
      return Number((await client.query("SELECT courier_id FROM dispatches WHERE id=$1", [dispatchId])).rows[0].courier_id);
    });
    await audit(adminId, "ROUTE_ADMIN_RESEQUENCE", "dispatch", dispatchId, { reason: why, sequence: keys });
    emitRealtime("dispatch:changed", { courier_id: courierId, dispatch_id: Number(dispatchId), change: "ROUTE_UPDATED" });
    return dispatchRouteView(dispatchId);
  }

  // ---------------------------------------------------------------- correção de endereço
  async function orderContext(client, platform, externalOrderId) {
    const order = (await loadOrders(client, [{ platform, external_order_id: externalOrderId }])).get(`${platform}:${externalOrderId}`) || null;
    const pre = (await client.query(`SELECT o.pre_departure_id,o.checked_at,o.order_number,p.courier_id,p.status FROM pre_departure_orders o JOIN pre_departures p ON p.id=o.pre_departure_id
      WHERE o.platform=$1 AND o.external_order_id=$2 AND o.active`, [platform, externalOrderId])).rows[0] || null;
    const linkSql = platform === "ifood"
      ? "SELECT l.dispatch_id,l.local_order_number AS order_number,d.status,d.courier_id FROM ifood_dispatch_links l JOIN dispatches d ON d.id=l.dispatch_id WHERE l.ifood_order_id=$1"
      : "SELECT l.dispatch_id,l.local_order_number AS order_number,d.status,d.courier_id FROM anotaai_dispatch_links l JOIN dispatches d ON d.id=l.dispatch_id WHERE l.anotaai_order_id=$1";
    const link = (await client.query(linkSql, [externalOrderId])).rows[0] || null;
    let delivered = false;
    if (link) {
      const q = platform === "ifood"
        ? await client.query(`SELECT (UPPER(COALESCE(io.status,'')) IN ('CONCLUDED','DELIVERED') OR UPPER(COALESCE(c.status,'')) IN ('VERIFIED','CONCLUDED')) AS done
            FROM ifood_orders io LEFT JOIN ifood_delivery_confirmations c ON c.ifood_order_id=io.order_id WHERE io.order_id=$1`, [externalOrderId])
        : await client.query(`SELECT (UPPER(COALESCE(a.status,''))='FINISHED' OR EXISTS (SELECT 1 FROM anotaai_delivery_confirmations c WHERE c.anotaai_order_id=a.order_id)) AS done
            FROM anotaai_orders a WHERE a.order_id=$1`, [externalOrderId]);
      delivered = Boolean(q.rows[0]?.done);
    }
    const cancelled = order ? (platform === "ifood" ? order.status === "CANCELLED" : ["CANCELLED", "DENIED", "CANCELLATION_REQUESTED"].includes(order.status)) : false;
    const stage = delivered ? "DELIVERED" : link?.status === "ON_ROAD" ? "ON_ROUTE" : link ? "FINISHED_ROUTE"
      : pre ? (pre.checked_at ? "PRE_DEPARTURE_CHECKED" : "PRE_DEPARTURE_UNCHECKED") : "NOT_ALLOCATED";
    return { order, pre, link, delivered, cancelled, stage };
  }

  async function addressInfo(platform, externalOrderId) {
    const ctx = await orderContext(pool, platform, externalOrderId);
    if (!ctx.order) throw fail(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
    const history = (await pool.query(`SELECT o.*,u.name AS changed_by_name FROM order_address_overrides o LEFT JOIN users u ON u.id=o.changed_by
      WHERE platform=$1 AND external_order_id=$2 ORDER BY version DESC`, [platform, externalOrderId])).rows;
    const currentAddress = operationalAddress(ctx.order);
    return {
      platform,
      external_order_id: externalOrderId,
      order_number: ctx.pre?.order_number || ctx.link?.order_number || ctx.order.display_id,
      customer_name: ctx.order.customer_name,
      stage: ctx.stage,
      delivered: ctx.delivered,
      cancelled: ctx.cancelled,
      editable: !ctx.delivered && !ctx.cancelled,
      original: ctx.order.platform_address,
      current: currentAddress,
      version: Number(history[0]?.version || 0),
      history: history.map(h => ({ version: h.version, address: h.formatted_address, reason: h.reason, stage: h.stage, changed_by: h.changed_by_name, changed_at: h.created_at, location_source: h.location_source })),
      courier_id: ctx.pre?.courier_id || ctx.link?.courier_id || null
    };
  }

  async function geocodePreview(fieldsInput) {
    const fields = validateAddressFields(fieldsInput);
    const formatted = formatOverrideAddress(fields);
    const origin = await storeOrigin();
    const point = await routes().geocodeAddress(formatted, origin);
    const distance = haversineMeters(origin, point);
    const warning = distance > ROUTE_REGION_MAX_METERS ? "Localização muito distante da loja: o endereço pode estar ambíguo."
      : point.precise === false ? "Localização aproximada (rua ou bairro). Arraste o pino até a porta certa antes de salvar." : null;
    return { formatted_address: formatted, latitude: point.latitude, longitude: point.longitude, distance_from_store_meters: Math.round(distance), precise: point.precise !== false, warning };
  }

  async function correctAddress({ adminId, platform, externalOrderId, fields: rawFields, latitude, longitude, locationSource = "GOOGLE", reason, expectedVersion, recalculate = true }) {
    if (!["ifood", "anotaai"].includes(platform)) throw fail(400, "Plataforma inválida.", "ORDER_PLATFORM_REQUIRED");
    const fields = validateAddressFields(rawFields);
    const why = text(reason, 300);
    if (why.length < 5) throw fail(400, "Informe o motivo da alteração (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const point = { latitude: Number(latitude), longitude: Number(longitude) };
    if (!validCoordinate(point)) throw fail(400, "Valide o novo endereço no mapa antes de salvar.", "ADDRESS_LOCATION_REQUIRED");
    if (!["GOOGLE", "ADMIN_PIN"].includes(locationSource)) throw fail(400, "Origem da localização inválida.", "ADDRESS_LOCATION_REQUIRED");
    const reference = await storeOrigin().catch(() => ({ ...LONGE_STORE.approx }));
    if (haversineMeters(reference, point) > ROUTE_REGION_MAX_METERS) throw fail(422, "O ponto está a mais de 30 km da loja. Confira o endereço.", "ADDRESS_OUT_OF_REGION");
    const result = await tx(async client => {
      const ctx = await orderContext(client, platform, externalOrderId);
      if (!ctx.order) throw fail(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
      if (ctx.delivered) throw fail(409, "Pedido já entregue: o destino não pode ser alterado. Registre uma ocorrência.", "ORDER_ALREADY_DELIVERED");
      if (ctx.cancelled) throw fail(409, "Pedido cancelado na plataforma.", "ORDER_CANCELLED");
      const current = Number((await client.query("SELECT COALESCE(MAX(version),0)::int AS v FROM order_address_overrides WHERE platform=$1 AND external_order_id=$2", [platform, externalOrderId])).rows[0].v);
      if (Number(expectedVersion) !== current) throw fail(409, "Outro administrador alterou este endereço. Recarregue e confira.", "ADDRESS_VERSION_CONFLICT", { version: current });
      const version = current + 1;
      try {
        await client.query("SAVEPOINT override_insert");
        await client.query(`INSERT INTO order_address_overrides(platform,external_order_id,order_number,version,street,number,complement,neighborhood,city,state,postal_code,reference,
          formatted_address,latitude,longitude,location_source,reason,stage,original_address,changed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)`,
          [platform, externalOrderId, ctx.pre?.order_number || ctx.link?.order_number || ctx.order.display_id, version, fields.street, fields.number, fields.complement || null,
            fields.neighborhood, fields.city, fields.state || null, fields.postal_code || null, fields.reference || null, formatOverrideAddress(fields),
            point.latitude, point.longitude, locationSource, why, ctx.stage, JSON.stringify(ctx.order.platform_address), adminId]);
        await client.query("RELEASE SAVEPOINT override_insert");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT override_insert");
        if (e.code === "23505") throw fail(409, "Outro administrador alterou este endereço ao mesmo tempo. Recarregue e confira.", "ADDRESS_VERSION_CONFLICT");
        throw e;
      }
      if (ctx.pre) {
        const pd = await readPreDeparture(client, ctx.pre.pre_departure_id, { lock: true });
        const rows = await activeOrders(client, pd.id);
        const status = deriveStatus({ total: rows.length, checked: rows.filter(r => r.checked_at).length, routeReady: false, blocked: false });
        await client.query(`UPDATE pre_departures SET route_status='PENDING',route_basis=NULL,admin_override=NULL,ack_required=TRUE,
          status=$2,blocked_reason=NULL,version=version+1,updated_at=NOW() WHERE id=$1`, [pd.id, status]);
        await event(client, { preDepartureId: pd.id, name: "ADDRESS_CORRECTED", actorUserId: adminId, details: { platform, external_order_id: externalOrderId, version, stage: ctx.stage, reason: why } });
      }
      if (ctx.link?.status === "ON_ROAD") {
        await event(client, { dispatchId: ctx.link.dispatch_id, name: "ADDRESS_CORRECTED", actorUserId: adminId, details: { platform, external_order_id: externalOrderId, version, stage: ctx.stage, reason: why } });
      }
      return { version, ctx };
    });
    await audit(adminId, "ORDER_ADDRESS_CORRECTED", "order_address", null, {
      platform, external_order_id: externalOrderId, version: result.version, stage: result.ctx.stage, reason: why,
      original: result.ctx.order.platform_address?.address || null, new_address: formatOverrideAddress(fields), location_source: locationSource
    });
    await onAddressCorrected({ platform, externalOrderId, latitude: point.latitude, longitude: point.longitude }).catch(e => logger.error?.("Falha ao reclassificar após correção:", e.message));
    let routeOutcome = null;
    if (result.ctx.pre) {
      const pdId = result.ctx.pre.pre_departure_id;
      const stops = await snapshotStops(pool, await readPreDeparture(pool, pdId));
      routeOutcome = stops.every(s => s.checked) ? await computeRoute(pdId).catch(e => ({ error: e.message })) : await view(pdId);
      emitRealtime("dispatch:changed", { courier_id: result.ctx.pre.courier_id, change: "PRE_DEPARTURE_UPDATED" });
    } else if (result.ctx.link?.status === "ON_ROAD" && recalculate) {
      const hasRoute = (await pool.query("SELECT 1 FROM dispatch_routes WHERE dispatch_id=$1", [result.ctx.link.dispatch_id])).rowCount;
      if (hasRoute) routeOutcome = await recalculatePending(result.ctx.link.dispatch_id, { actorUserId: adminId, cause: "ADDRESS_CORRECTED", reason: why });
      emitRealtime("dispatch:changed", { courier_id: result.ctx.link.courier_id, dispatch_id: Number(result.ctx.link.dispatch_id), change: "ROUTE_UPDATED" });
      emitRealtime("delivery:changed", { courier_id: result.ctx.link.courier_id });
    }
    return { ...(await addressInfo(platform, externalOrderId)), route: routeOutcome };
  }

  async function registerOccurrence({ adminId, platform, externalOrderId, note }) {
    const why = text(note, 500);
    if (why.length < 5) throw fail(400, "Descreva a ocorrência (mínimo de 5 caracteres).", "REASON_REQUIRED");
    const ctx = await orderContext(pool, platform, externalOrderId);
    if (!ctx.order) throw fail(404, "Pedido não encontrado.", "ORDER_NOT_FOUND");
    await event(pool, { dispatchId: ctx.link?.dispatch_id || null, preDepartureId: ctx.pre?.pre_departure_id || null, name: "ADMIN_OCCURRENCE", actorUserId: adminId, details: { platform, external_order_id: externalOrderId, note: why, stage: ctx.stage } });
    await audit(adminId, "ORDER_ADMIN_OCCURRENCE", "order_address", null, { platform, external_order_id: externalOrderId, note: why, stage: ctx.stage });
    return { ok: true, stage: ctx.stage };
  }

  // ---------------------------------------------------------------- painel do admin
  async function adminOverview() {
    const open = (await pool.query(`SELECT id FROM pre_departures WHERE status = ANY($1::text[]) ORDER BY id`, [PRE_DEPARTURE_OPEN_STATES])).rows;
    const routes = (await pool.query(`SELECT r.dispatch_id FROM dispatch_routes r JOIN dispatches d ON d.id=r.dispatch_id WHERE d.status='ON_ROAD' ORDER BY r.dispatch_id`)).rows;
    const courierNames = new Map((await pool.query("SELECT id,name FROM users")).rows.map(u => [Number(u.id), u.name]));
    return {
      settings: await readSettings(),
      store_origin: await knownOrigin(),
      pre_departures: await Promise.all(open.map(r => view(r.id))),
      routes: (await Promise.all(routes.map(r => dispatchRouteView(r.dispatch_id)))).map(r => ({ ...r, courier_name: courierNames.get(r.courier_id) || null }))
    };
  }

  async function events({ preDepartureId = null, dispatchId = null, limit = 100 }) {
    return (await pool.query(`SELECT e.*,u.name AS actor_name FROM pre_departure_events e LEFT JOIN users u ON u.id=e.actor_user_id
      WHERE ($1::bigint IS NULL OR e.pre_departure_id=$1) AND ($2::bigint IS NULL OR e.dispatch_id=$2) ORDER BY e.id DESC LIMIT $3`, [preDepartureId, dispatchId, limit])).rows;
  }

  return {
    readSettings, saveSettings, current, view, create, setCheck, replaceOrder, addOrder, removeOrder, cancel, expireStale, recoverInterrupted,
    computeRoute, acknowledge, adminSequence, prepareDispatch, bindDispatch, block, dispatchRouteView, activeRouteForCourier,
    recalculatePending, acknowledgeRoute, adminResequenceRoute, addressInfo, geocodePreview, correctAddress, registerOccurrence,
    adminOverview, events, storeOrigin, confirmStoreOrigin
  };
}
