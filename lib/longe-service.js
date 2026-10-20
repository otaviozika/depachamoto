// Serviço da regra LONGE: zona salva, modo (desligado/teste/ativo), classificação
// de cada pedido despachado, correção manual auditada e jobs que consultam o Google.
// As tabelas ficam no bootstrap do server.js (seção "Regra LONGE").
import {
  LONGE_MODES, LONGE_RADIUS_METERS, LONGE_ROUTE_SETTINGS, LONGE_STORE, classifyLongePoint, clusterPoints,
  createRoutesClient, generateLongeZonePolygon, longeTestWeekend, modeAt, normalizePolygon, resolveStoreOrigin,
  routesApiKey, summarizeLongePreview, validCoordinate
} from "./longe-zone.js";

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// Pedido → coordenadas/bairro a partir do endereço de entrega já salvo da plataforma.
const ORDER_ADDRESS_SQL = `
  LEFT JOIN ifood_dispatch_links il ON o.platform='ifood' AND il.dispatch_id=o.dispatch_id AND LOWER(il.local_order_number)=LOWER(o.order_number)
  LEFT JOIN ifood_orders io ON io.order_id=il.ifood_order_id
  LEFT JOIN anotaai_dispatch_links al ON o.platform='anotaai' AND al.dispatch_id=o.dispatch_id AND LOWER(al.local_order_number)=LOWER(o.order_number)
  LEFT JOIN anotaai_orders ao ON ao.order_id=al.anotaai_order_id
  LEFT JOIN LATERAL (SELECT ov.latitude,ov.longitude FROM order_address_overrides ov
    WHERE ov.platform=o.platform AND ov.external_order_id=COALESCE(il.ifood_order_id,al.anotaai_order_id)
    ORDER BY ov.version DESC LIMIT 1) aov ON TRUE`;
const ORDER_ADDRESS_COLUMNS = `io.payload->'delivery' AS ifood_delivery, ao.payload->'deliveryAddress' AS anotaai_address, aov.latitude AS override_latitude, aov.longitude AS override_longitude`;
// Só entrega própria: iFood entregue pela loja (DELIVERY + MERCHANT), Anota AI de
// entrega e saídas manuais dos motoboys. Retirada e frota do iFood ficam de fora.
const OWN_DELIVERY_SQL = `(o.platform='manual'
  OR (o.platform='ifood' AND UPPER(COALESCE(io.order_type,''))='DELIVERY' AND UPPER(COALESCE(io.delivered_by,''))='MERCHANT')
  OR (o.platform='anotaai' AND UPPER(COALESCE(ao.order_type,''))='DELIVERY'))`;

export function createLongeService({ pool, describeDestination, emitRealtime = () => {}, routesClientFactory = () => createRoutesClient(), now = () => new Date(), logger = console, env = process.env }) {
  const destinationOf = row => {
    const order = row.ifood_delivery ? { delivery: row.ifood_delivery } : row.anotaai_address ? { deliveryAddress: row.anotaai_address } : null;
    const found = order ? describeDestination(order) : null;
    const base = found || { latitude: null, longitude: null, neighborhood: "", city: "" };
    // Endereço corrigido pelo admin é onde a entrega de fato aconteceu.
    const override = { latitude: row.override_latitude, longitude: row.override_longitude };
    return validCoordinate(override) ? { ...base, latitude: Number(override.latitude), longitude: Number(override.longitude) } : base;
  };

  async function getZone(client = pool) {
    const row = (await client.query(`SELECT id,radius_meters,store_address,store_latitude,store_longitude,polygon,method,generated_by,generated_at FROM longe_zones ORDER BY id LIMIT 1`)).rows[0];
    return row ? { ...row, polygon: normalizePolygon(row.polygon) } : null;
  }

  async function getModeHistory(client = pool) {
    return (await client.query(`SELECT h.id,h.mode,h.effective_at,h.changed_by,h.reason,u.name changed_by_name FROM longe_mode_history h LEFT JOIN users u ON u.id=h.changed_by ORDER BY h.effective_at,h.id`)).rows;
  }

  function activationWindow(history) {
    const firstTest = history.find(entry => entry.mode === "TEST");
    return firstTest ? longeTestWeekend(firstTest.effective_at) : null;
  }

  async function getState() {
    const [zone, history] = await Promise.all([getZone(), getModeHistory()]);
    const current = modeAt(history, now());
    const jobs = (await pool.query(`SELECT DISTINCT ON (kind) id,kind,status,started_at,finished_at,progress,result,error FROM longe_jobs ORDER BY kind,id DESC`)).rows;
    const counts = (await pool.query(`SELECT rule_mode,COUNT(*)::int total,COUNT(*) FILTER (WHERE longe)::int longe,COUNT(*) FILTER (WHERE auto_status='NO_LOCATION' AND manual_longe IS NULL)::int no_location,COUNT(*) FILTER (WHERE manual_longe IS NOT NULL)::int corrected FROM dispatch_order_longe WHERE rule_mode<>'OFF' GROUP BY rule_mode`)).rows;
    return {
      radius_meters: LONGE_RADIUS_METERS,
      store: { address: LONGE_STORE.address },
      route_settings: LONGE_ROUTE_SETTINGS,
      routes_configured: Boolean(routesApiKey(env)),
      mode: current,
      history,
      test_window: activationWindow(history),
      zone,
      jobs: Object.fromEntries(jobs.map(job => [job.kind, job])),
      classified: Object.fromEntries(counts.map(row => [row.rule_mode, row]))
    };
  }

  async function setMode({ actorUserId, mode, reason }) {
    const next = String(mode || "").trim().toUpperCase();
    const why = String(reason || "").trim();
    if (!LONGE_MODES.includes(next)) throw fail(400, "Modo LONGE inválido.", "LONGE_MODE_INVALID");
    if (why.length < 5) throw fail(400, "Informe o motivo da mudança (mínimo de 5 caracteres).", "LONGE_REASON_REQUIRED");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('longe-mode'))");
      const history = await getModeHistory(client);
      const at = now(), current = modeAt(history, at);
      if (next === current) throw fail(409, `A regra LONGE já está em ${next}.`, "LONGE_MODE_UNCHANGED");
      if (next !== "OFF" && !(await getZone(client))) throw fail(409, "Gere a zona de 6,7 km antes de ligar a regra.", "LONGE_ZONE_REQUIRED");
      if (next === "ACTIVE") {
        const window = activationWindow(history);
        if (!window) throw fail(409, "Coloque a regra em teste antes de ativar o pagamento.", "LONGE_TEST_REQUIRED");
        if (at < new Date(window.ends_at)) throw fail(409, `O primeiro fim de semana é só de teste. O pagamento pode ser ativado a partir de ${new Date(window.ends_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`, "LONGE_TEST_WEEKEND_PENDING");
      }
      const saved = (await client.query(`INSERT INTO longe_mode_history(mode,effective_at,changed_by,reason) VALUES($1,$2,$3,$4) RETURNING *`, [next, at, actorUserId || null, why])).rows[0];
      await client.query("INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,'LONGE_MODE_CHANGED','longe_rule',$2,$3::jsonb)",
        [actorUserId || null, saved.id, JSON.stringify({ from: current, to: next, reason: why, effective_at: at })]);
      await client.query("COMMIT");
      emitRealtime("payment:changed", { all: true, change: "LONGE_MODE" });
      return { from: current, to: next, entry: saved };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  // Classifica pedidos sem classificação cuja saída aconteceu depois da publicação
  // da regra (primeiro modo diferente de OFF). Pedidos anteriores nunca entram.
  async function classifyPending({ dispatchIds = null, limit = 300, lookbackDays = 7 } = {}) {
    const [zone, history] = await Promise.all([getZone(), getModeHistory()]);
    const firstOn = history.find(entry => entry.mode !== "OFF");
    if (!zone || !firstOn) return { classified: 0 };
    const ids = Array.isArray(dispatchIds) ? dispatchIds.map(Number).filter(Number.isInteger) : null;
    const since = new Date(Math.max(new Date(firstOn.effective_at).getTime(), now().getTime() - lookbackDays * 86400000));
    const rows = (await pool.query(`
      SELECT o.id,o.dispatch_id,d.courier_id,d.departed_at,${ORDER_ADDRESS_COLUMNS}
      FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id
      LEFT JOIN dispatch_order_longe lg ON lg.dispatch_order_id=o.id
      ${ORDER_ADDRESS_SQL}
      WHERE lg.dispatch_order_id IS NULL AND d.departed_at >= $1::timestamptz AND ${OWN_DELIVERY_SQL}
        AND ($2::bigint[] IS NULL OR o.dispatch_id=ANY($2::bigint[]))
      ORDER BY o.id LIMIT $3`, [since, ids, limit])).rows;
    const couriers = new Set();
    let classified = 0;
    for (const row of rows) {
      const ruleMode = modeAt(history, row.departed_at);
      const point = destinationOf(row);
      const result = classifyLongePoint(point, zone.polygon);
      const inserted = await pool.query(`INSERT INTO dispatch_order_longe(dispatch_order_id,zone_id,rule_mode,latitude,longitude,auto_status)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dispatch_order_id) DO NOTHING`,
        [row.id, zone.id, ruleMode, validCoordinate(point) ? Number(point.latitude) : null, validCoordinate(point) ? Number(point.longitude) : null, result.status]);
      if (inserted.rowCount && ruleMode !== "OFF") { classified++; couriers.add(Number(row.courier_id)); }
    }
    // Endereço que chegou depois da saída (Anota AI): reavalia por até 48 h, sem
    // mexer em correção manual nem em turno já conferido/pago.
    const late = (await pool.query(`
      SELECT o.id,d.courier_id,${ORDER_ADDRESS_COLUMNS}
      FROM dispatch_order_longe lg JOIN dispatch_orders o ON o.id=lg.dispatch_order_id JOIN dispatches d ON d.id=o.dispatch_id
      ${ORDER_ADDRESS_SQL}
      WHERE lg.auto_status='NO_LOCATION' AND lg.manual_longe IS NULL AND lg.rule_mode<>'OFF' AND lg.classified_at >= NOW()-INTERVAL '48 hours' AND ${OWN_DELIVERY_SQL}
        AND ($1::bigint[] IS NULL OR o.dispatch_id=ANY($1::bigint[]))
        AND NOT EXISTS (SELECT 1 FROM courier_payments p WHERE p.courier_id=d.courier_id AND p.payment_date=d.operational_date AND p.shift_code=d.shift_code AND p.status<>'OPEN')
      LIMIT $2`, [ids, limit])).rows;
    for (const row of late) {
      const point = destinationOf(row);
      if (!validCoordinate(point)) continue;
      const result = classifyLongePoint(point, zone.polygon);
      await pool.query(`UPDATE dispatch_order_longe SET latitude=$2,longitude=$3,auto_status=$4,updated_at=NOW() WHERE dispatch_order_id=$1 AND auto_status='NO_LOCATION' AND manual_longe IS NULL`,
        [row.id, Number(point.latitude), Number(point.longitude), result.status]);
      classified++; couriers.add(Number(row.courier_id));
    }
    if (couriers.size) {
      for (const courierId of couriers) emitRealtime("payment:changed", { courier_id: courierId, change: "LONGE_CLASSIFIED" });
    }
    return { classified };
  }

  async function listOrders({ date, shiftCode = null, courierId = null }) {
    return (await pool.query(`
      SELECT o.id order_item_id,o.order_number,o.platform,o.dispatch_id,d.departed_at,d.courier_id,u.name courier_name,
        to_char(d.operational_date,'YYYY-MM-DD') payment_date,d.shift_code,
        lg.rule_mode,lg.auto_status,lg.manual_longe,lg.manual_reason,lg.manual_at,mu.name manual_by_name,lg.longe,lg.latitude,lg.longitude,
        p.status payment_status
      FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id JOIN users u ON u.id=d.courier_id
      LEFT JOIN dispatch_order_longe lg ON lg.dispatch_order_id=o.id
      LEFT JOIN users mu ON mu.id=lg.manual_by
      LEFT JOIN courier_payments p ON p.courier_id=d.courier_id AND p.payment_date=d.operational_date AND p.shift_code=d.shift_code
      WHERE d.operational_date=$1::date AND ($2::text IS NULL OR d.shift_code=$2) AND ($3::int IS NULL OR d.courier_id=$3)
      ORDER BY d.departed_at,o.id`, [date, shiftCode, courierId])).rows;
  }

  // longe: true/false força a classificação; null volta ao cálculo automático.
  async function correctOrder({ actorUserId, orderItemId, longe, reason }) {
    const id = Number(orderItemId), why = String(reason || "").trim();
    if (!Number.isInteger(id) || id <= 0) throw fail(400, "Pedido inválido.", "LONGE_ORDER_INVALID");
    if (![true, false, null].includes(longe)) throw fail(400, "Informe se o pedido é LONGE, normal ou automático.", "LONGE_VALUE_INVALID");
    if (why.length < 5 || why.length > 300) throw fail(400, "Informe o motivo da correção (5 a 300 caracteres).", "LONGE_REASON_REQUIRED");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query(`
        SELECT lg.*,o.order_number,o.dispatch_id,d.courier_id,to_char(d.operational_date,'YYYY-MM-DD') payment_date,d.shift_code
        FROM dispatch_order_longe lg JOIN dispatch_orders o ON o.id=lg.dispatch_order_id JOIN dispatches d ON d.id=o.dispatch_id
        WHERE lg.dispatch_order_id=$1 FOR UPDATE OF lg`, [id])).rows[0];
      if (!row || row.rule_mode === "OFF") throw fail(409, "Este pedido não está na regra LONGE (saída anterior à publicação ou com a regra desligada).", "LONGE_ORDER_OUT_OF_RULE");
      const payment = (await client.query(`SELECT status FROM courier_payments WHERE courier_id=$1 AND payment_date=$2::date AND shift_code IS NOT DISTINCT FROM $3 FOR UPDATE`,
        [row.courier_id, row.payment_date, row.shift_code])).rows[0];
      if (payment && payment.status !== "OPEN") throw fail(409, "O pagamento deste turno já foi conferido ou pago. Reabra o turno no Financeiro antes de corrigir.", "LONGE_PAYMENT_LOCKED");
      const before = row.longe === true;
      const updated = (await client.query(`UPDATE dispatch_order_longe SET manual_longe=$2,manual_reason=$3,manual_by=$4,manual_at=NOW(),updated_at=NOW() WHERE dispatch_order_id=$1 RETURNING longe`,
        [id, longe, why, actorUserId || null])).rows[0];
      await client.query("INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,'LONGE_ORDER_CORRECTED','dispatch',$2,$3::jsonb)", [actorUserId || null, row.dispatch_id, JSON.stringify({
        dispatch_order_id: id, order_number: row.order_number, courier_id: row.courier_id, payment_date: row.payment_date, shift_code: row.shift_code,
        rule_mode: row.rule_mode, auto_status: row.auto_status, from: before ? "LONGE" : "NORMAL", to: updated.longe ? "LONGE" : "NORMAL",
        manual: longe === null ? "AUTOMATIC" : longe ? "LONGE" : "NORMAL", reason: why
      })]);
      await client.query("COMMIT");
      emitRealtime("payment:changed", { courier_id: Number(row.courier_id), shift_code: row.shift_code, change: "LONGE_CORRECTED" });
      return { order_item_id: id, order_number: row.order_number, longe: updated.longe, rule_mode: row.rule_mode, from: before, courier_id: Number(row.courier_id) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function updateJob(id, fields) {
    const sets = [], values = [id];
    for (const [key, value] of Object.entries(fields)) {
      values.push(["progress", "result"].includes(key) ? JSON.stringify(value) : value);
      sets.push(`${key}=$${values.length}${["progress", "result"].includes(key) ? "::jsonb" : ""}`);
    }
    await pool.query(`UPDATE longe_jobs SET ${sets.join(",")} WHERE id=$1`, values);
  }

  async function storeOrigin(client) {
    const zone = await getZone();
    if (zone) return { latitude: Number(zone.store_latitude), longitude: Number(zone.store_longitude), source: "ZONE" };
    return { ...(await resolveStoreOrigin(client)), source: "GOOGLE" };
  }

  async function runPreview(job) {
    const routes = routesClientFactory();
    const origin = await storeOrigin(routes);
    const deliveries = (await pool.query(`
      SELECT o.id,to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month,${ORDER_ADDRESS_COLUMNS}
      FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id ${ORDER_ADDRESS_SQL}
      WHERE ${OWN_DELIVERY_SQL}
      ORDER BY o.id`)).rows.map(row => ({ id: row.id, month: row.month, ...destinationOf(row) }));
    const clusters = clusterPoints(deliveries, { cellMeters: 100, anchor: origin });
    const originKey = `${origin.latitude.toFixed(5)},${origin.longitude.toFixed(5)}`;
    const keyOf = cluster => `${cluster.key}@${originKey}`;
    const cached = new Map((await pool.query(`SELECT cell_key,distance_meters FROM longe_route_cache WHERE cell_key=ANY($1::text[])`, [clusters.map(keyOf)])).rows
      .map(row => [row.cell_key, row.distance_meters === null ? null : Number(row.distance_meters)]));
    const missing = clusters.filter(cluster => !cached.has(keyOf(cluster)));
    await updateJob(job.id, { progress: { phase: "ROUTES", clusters: clusters.length, cached: clusters.length - missing.length, requested: missing.length } });
    for (let start = 0; start < missing.length; start += 500) {
      const chunk = missing.slice(start, start + 500);
      const distances = await routes.distancesFrom(origin, chunk);
      for (let i = 0; i < chunk.length; i++) {
        const meters = Number.isFinite(distances[i]) ? Math.round(distances[i]) : null;
        cached.set(keyOf(chunk[i]), meters);
        await pool.query(`INSERT INTO longe_route_cache(cell_key,latitude,longitude,distance_meters) VALUES($1,$2,$3,$4) ON CONFLICT(cell_key) DO UPDATE SET distance_meters=EXCLUDED.distance_meters,computed_at=NOW()`,
          [keyOf(chunk[i]), chunk[i].latitude, chunk[i].longitude, meters]);
      }
      await updateJob(job.id, { progress: { phase: "ROUTES", clusters: clusters.length, cached: clusters.length - missing.length, requested: missing.length, done: Math.min(missing.length, start + chunk.length) } });
    }
    const clusterOf = new Map();
    clusters.forEach(cluster => cluster.members.forEach(index => clusterOf.set(index, cluster)));
    const located = deliveries.map((delivery, index) => ({ ...delivery, cluster: clusterOf.get(index) }));
    const distanceFor = delivery => delivery.cluster ? cached.get(keyOf(delivery.cluster)) : undefined;
    const summary = summarizeLongePreview(located, distanceFor);
    const zone = await getZone();
    let polygon_check = null;
    if (zone) {
      let agree = 0, compared = 0;
      for (const delivery of located) {
        const distance = distanceFor(delivery);
        if (!Number.isFinite(distance)) continue;
        compared++;
        if ((distance > LONGE_RADIUS_METERS) === (classifyLongePoint(delivery, zone.polygon).status === "LONGE")) agree++;
      }
      polygon_check = { compared, agree, agreement_pct: compared ? Math.round(agree * 1000 / compared) / 10 : null };
    }
    return { ...summary, clusters: clusters.length, cell_meters: 100, google_elements: routes.elements, origin, polygon_check, route_settings: LONGE_ROUTE_SETTINGS };
  }

  async function runZone(job, actorUserId) {
    const routes = routesClientFactory();
    const origin = await resolveStoreOrigin(routes);
    const zone = await generateLongeZonePolygon({
      origin,
      distancesFn: points => routes.distancesFrom(origin, points),
      onProgress: progress => updateJob(job.id, { progress }).catch(() => {})
    });
    const method = { ...LONGE_ROUTE_SETTINGS, ...zone.settings, rays: zone.rays, google_elements: routes.elements, store_drift_meters: origin.drift_meters };
    const saved = (await pool.query(`INSERT INTO longe_zones(radius_meters,store_address,store_latitude,store_longitude,polygon,method,generated_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id,generated_at`,
      [LONGE_RADIUS_METERS, LONGE_STORE.address, origin.latitude, origin.longitude, JSON.stringify(zone.polygon), JSON.stringify(method), actorUserId || null])).rows[0];
    await pool.query("INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,'LONGE_ZONE_GENERATED','longe_zone',$2,$3::jsonb)",
      [actorUserId || null, saved.id, JSON.stringify({ vertices: zone.polygon.length, google_elements: routes.elements, store_latitude: origin.latitude, store_longitude: origin.longitude, ...LONGE_ROUTE_SETTINGS })]);
    return { zone_id: saved.id, vertices: zone.polygon.length, google_elements: routes.elements, origin };
  }

  async function startJob({ kind, actorUserId }) {
    const type = String(kind || "").toUpperCase();
    if (!["PREVIEW", "ZONE"].includes(type)) throw fail(400, "Tipo de cálculo inválido.", "LONGE_JOB_INVALID");
    if (!routesApiKey(env)) throw fail(503, "Configure GOOGLE_ROUTES_API_KEY no Render para usar a rota do Google.", "GOOGLE_ROUTES_NOT_CONFIGURED");
    const client = await pool.connect();
    let job;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('longe-jobs'))");
      if (type === "ZONE" && (await getZone(client))) throw fail(409, "A zona de 6,7 km já foi gerada e não é gerada novamente.", "LONGE_ZONE_EXISTS");
      const running = (await client.query(`SELECT id FROM longe_jobs WHERE status='RUNNING' AND started_at > NOW()-INTERVAL '20 minutes' LIMIT 1`)).rows[0];
      if (running) throw fail(409, "Já existe um cálculo LONGE em andamento. Aguarde terminar.", "LONGE_JOB_RUNNING");
      job = (await client.query(`INSERT INTO longe_jobs(kind,status,started_by) VALUES($1,'RUNNING',$2) RETURNING *`, [type, actorUserId || null])).rows[0];
      await client.query("INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,'longe_job',$3,$4::jsonb)",
        [actorUserId || null, type === "ZONE" ? "LONGE_ZONE_REQUESTED" : "LONGE_PREVIEW_REQUESTED", job.id, JSON.stringify({ kind: type })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
    const done = (async () => {
      try {
        const result = type === "ZONE" ? await runZone(job, actorUserId) : await runPreview(job);
        await updateJob(job.id, { status: "DONE", result, finished_at: new Date() });
        if (type === "ZONE") emitRealtime("payment:changed", { all: true, change: "LONGE_ZONE" });
      } catch (error) {
        logger.error(`LONGE ${type}:`, String(error?.message || error));
        await updateJob(job.id, { status: "FAILED", error: String(error?.message || error).slice(0, 1000), finished_at: new Date() }).catch(() => {});
      }
    })();
    return { job, done };
  }

  async function getJob(id) {
    return (await pool.query(`SELECT id,kind,status,started_at,finished_at,progress,result,error FROM longe_jobs WHERE id=$1`, [Number(id)])).rows[0] || null;
  }

  // Um cálculo interrompido por reinício não fica preso como "em andamento".
  async function recoverInterruptedJobs() {
    await pool.query(`UPDATE longe_jobs SET status='FAILED',error='Interrompido por reinício do servidor. Rode novamente.',finished_at=NOW() WHERE status='RUNNING'`);
  }

  // Correção de endereço pelo admin depois da classificação: reavalia o pedido, sem mexer
  // em correção manual nem em turno já conferido/pago. Antes da classificação o worker já
  // usa o endereço corrigido.
  async function applyOperationalLocation({ platform, externalOrderId, latitude, longitude }) {
    const zone = await getZone();
    const point = { latitude, longitude };
    if (!zone || !validCoordinate(point)) return { updated: 0 };
    const result = classifyLongePoint(point, zone.polygon);
    const rows = (await pool.query(`
      UPDATE dispatch_order_longe lg SET latitude=$3,longitude=$4,auto_status=$5,updated_at=NOW()
      FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id
      LEFT JOIN ifood_dispatch_links il ON o.platform='ifood' AND il.dispatch_id=o.dispatch_id AND LOWER(il.local_order_number)=LOWER(o.order_number)
      LEFT JOIN anotaai_dispatch_links al ON o.platform='anotaai' AND al.dispatch_id=o.dispatch_id AND LOWER(al.local_order_number)=LOWER(o.order_number)
      WHERE lg.dispatch_order_id=o.id AND o.platform=$1 AND COALESCE(il.ifood_order_id,al.anotaai_order_id)=$2 AND lg.manual_longe IS NULL
        AND NOT EXISTS (SELECT 1 FROM courier_payments p WHERE p.courier_id=d.courier_id AND p.payment_date=d.operational_date AND p.shift_code=d.shift_code AND p.status<>'OPEN')
      RETURNING d.courier_id`, [platform, externalOrderId, Number(latitude), Number(longitude), result.status])).rows;
    for (const courierId of new Set(rows.map(r => Number(r.courier_id)))) emitRealtime("payment:changed", { courier_id: courierId, change: "LONGE_ADDRESS_CORRECTED" });
    return { updated: rows.length, status: result.status };
  }

  return { getZone, getModeHistory, getState, setMode, classifyPending, listOrders, correctOrder, startJob, getJob, recoverInterruptedJobs, applyOperationalLocation };
}
