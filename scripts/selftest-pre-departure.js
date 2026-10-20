// Pré-saída, conferência de sacolas, sequência de até 5 entregas e correção de endereço.
// Os 40 cenários obrigatórios rodam contra o SQL e as funções reais do server.js
// (PGlite = PostgreSQL em WASM, uma conexão: transações serializadas), com o despacho
// existente (createDispatchTransaction + POST /api/courier/depart) e um Google falso
// (matriz pelas vias simulada a partir das coordenadas). Cada cenário imprime PASS/FAIL
// com a evidência. Uso: node scripts/selftest-pre-departure.js [--evidence arquivo.json]
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createPreDepartureService, canTransition, PRE_DEPARTURE_OPEN_STATES } from "../lib/pre-departure-service.js";
import { factorial, permutations, planRoute, ROUTE_PLANNER_DEFAULTS } from "../lib/route-planner.js";
import { destinationPoint, haversineMeters, LONGE_STORE } from "../lib/longe-zone.js";
import { SCENARIOS, syntheticMatrix } from "./simulate-route-planner.js";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(source.split("await pool.query(`")[1].split("`);")[0]);
await db.exec("ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS operational_date DATE; ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS shift_code TEXT;");
let tail = Promise.resolve();
const query = async (sql, args = []) => {
  if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
  const result = await db.query(sql, args);
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
};
const pool = { query, connect: async () => {
  const previous = tail; let release;
  tail = new Promise(r => { release = r; }); await previous;
  return { query, release };
} };
const plain = v => JSON.parse(JSON.stringify(v));

const today = (await query("SELECT to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day")).rows[0].day;
let clock = new Date(today + "T12:00:00-03:00").getTime();
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
const minutesAgo = m => new Date(clock - m * 60000).toISOString();

// ------------------------------------------------------------------ Google falso
const STORE = { latitude: -23.62446, longitude: -46.55491 };
const google = { matrix: 0, geocode: 0, resolve: 0, down: false, configured: true, onMatrix: null };
const fakeRoutes = {
  async resolveAddress() { google.resolve++; return { latitude: STORE.latitude + 0.0002, longitude: STORE.longitude }; },
  async geocodeAddress(address) {
    google.geocode++;
    if (google.down) throw Object.assign(new Error("Google indisponível (simulado)"), { status: 503, code: "GOOGLE_ROUTES_FAILED" });
    if (/inexistente/i.test(address)) throw Object.assign(new Error("O Google não localizou esse endereço."), { status: 503, code: "GOOGLE_ROUTES_ADDRESS_NOT_FOUND" });
    if (/campinas/i.test(address)) return destinationPoint(STORE, 300, 80000);
    let h = 0; for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return destinationPoint(STORE, h % 360, 800 + (h % 2500));
  },
  async travelMatrix(points) {
    google.matrix++;
    if (google.onMatrix) { const hook = google.onMatrix; google.onMatrix = null; await hook(); }
    if (google.down) throw Object.assign(new Error("Google indisponível (simulado)"), { status: 503, code: "GOOGLE_ROUTES_FAILED" });
    // 1 min fixo + 1,3 × distância reta a 25 km/h: assimetria pequena por sentido.
    const seconds = points.map((a, i) => points.map((b, j) => i === j ? 0 : Math.round(60 + haversineMeters(a, b) * 1.3 / 6.944 + (i < j ? 5 : 0))));
    return { seconds, meters: points.map((a, i) => points.map((b, j) => Math.round(haversineMeters(a, b) * 1.3))) };
  }
};
const routesClientFactory = () => {
  if (!google.configured) throw Object.assign(new Error("Configure GOOGLE_ROUTES_API_KEY no Render para usar a rota do Google."), { status: 503, code: "GOOGLE_ROUTES_NOT_CONFIGURED" });
  return fakeRoutes;
};

// ------------------------------------------------------------------ server.js real
const emitted = [], audits = [], immediates = [], workerRuns = { ifood: 0, anotaai: 0 };
const registry = {};
const auth = function auth() {}, courierOnly = function courierOnly() {}, adminOnly = function adminOnly() {};
const register = method => (path, ...handlers) => { registry[`${method} ${path}`] = handlers; };
const context = vm.createContext({
  pool, console, Date: TestDate, process: { env: { IFOOD_MERCHANT_ID: "shop" } }, Intl, JSON, Math,
  app: { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE") },
  auth, courierOnly, adminOnly, asyncRoute: fn => fn,
  emitRealtime: (e, p) => emitted.push([e, p]), auditBestEffort: async (...a) => { audits.push(a); },
  logOperationalConflict: async () => {}, touchPresence: async () => {},
  currentUser: async id => ({ id, must_change_password: false }),
  getCurrentOperationalShift: () => ({ operational_date: today, shift_code: "LUNCH", shift_label: "Almoço" }),
  // Depois do prestart (apply-late-shift-dispatch) a saída e a pré-saída usam dispatchShiftAt.
  dispatchShiftAt: () => ({ operational_date: today, shift_code: "LUNCH", shift_label: "Almoço" }),
  getCourierAttendance: async () => ({ checked_out_at: null }),
  resolveDispatchShift: ({ departedAt }) => ({ operational_date: new TestDate(departedAt).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }), shift_code: "LUNCH", shift_label: "Almoço" }),
  getOperationalSlaSettings: async () => ({ route: { 1: 25, 2: 30, 3: 35, 4: 40, 5: 45 }, returnMinutes: 15 }),
  orderArraySql: a => `(SELECT json_agg(order_number ORDER BY id) FROM dispatch_orders WHERE dispatch_id=${a}.id) AS order_numbers`,
  normalizeIfoodLifecycleStatus: v => String(v || "").toUpperCase(),
  operationalStage: v => String(v || "").toUpperCase() === "RETURNING" ? "RETURNING" : "EN_ROUTE",
  normalizeQueuedDepartureTime: v => v, ifoodDispatchEnabled: () => true, ifoodConfigured: () => true,
  upsertIfoodOrderFromDetails: async () => {},
  fetchIfoodOrderDetails: async id => {
    if (context.onIfoodFetch) { const hook = context.onIfoodFetch; context.onIfoodFetch = null; await hook(); }
    const row = (await query("SELECT * FROM ifood_orders WHERE order_id=$1", [id])).rows[0];
    return { id, merchant: { id: row.merchant_id }, orderType: row.order_type, delivery: { deliveredBy: row.delivered_by } };
  },
  setImmediate: fn => { immediates.push(fn); },
  runIfoodDispatchWorkerOnce: async () => { workerRuns.ifood++; }, runAnotaAiDispatchWorkerOnce: async () => { workerRuns.anotaai++; },
  ifoodDispatchErrorText: e => String(e), anotaAiSafeError: e => String(e)
});
function include(start, end) {
  const at = source.indexOf(start); assert.ok(at >= 0, start);
  const stop = source.indexOf(end, at); assert.ok(stop > at, end);
  vm.runInContext(source.slice(at, stop), context);
}
include("function canonicalIfoodOrderStatus", "async function refreshIfoodOrderClassificationForDeparture");
include("function orderDateSP", "async function ifoodOrderAlreadyStored");
include("function parseJsonPayload", "function normalizeDeliveryCode");
include("function normalizeOrders", "const orderArraySql");
include("function normalizeOrderPlatform", "async function inspectAnotaAiOrdersForDeparture");
include("async function inspectAnotaAiOrdersForDeparture", "async function inspectAnotaAiOrdersForAdminAllocation");
include("async function inspectOrders", "async function notificationEnabled");
include("async function createDispatchTransaction", "async function checkTimeNotifications");
include("function operationalRouteSlaMinutes", "function operationalTiming");
include("async function getCourierDeliveryCount", "// LONGE do turno");
include("function platformInspectionEntry", 'app.get("/api/courier/orders/lookup"');
include("function validateDepartureCount", "async function addRouteOrder");
include('app.post("/api/courier/depart"', "function normalizePeriodQuery");
include("function preDepartureOrderDetails", "const preDepartureService = createPreDepartureService");
include("const SERVICE_ERROR_FIELDS", "// Endereço corrigido pelo admin vale");
include("async function applyOperationalAddresses", 'app.get("/api/admin/dashboard"');

const makeService = () => createPreDepartureService({
  pool, describeOrder: context.preDepartureOrderDetails, emitRealtime: context.emitRealtime, audit: context.auditBestEffort,
  routesClientFactory, now: () => new Date(clock), logger: { error() {} }
});
let service = makeService();
context.preDepartureService = service;

async function call(key, { user, body = {}, params = {} }) {
  const handlers = registry[key];
  assert.ok(handlers, key);
  let status = 200, payload;
  const res = { headersSent: false, status(c) { status = c; return this; }, json(b) { payload = b; this.headersSent = true; return this; } };
  try {
    await handlers.at(-1)({ body: plain(body), params, query: {}, session: { user } }, res, e => { throw e; });
  } catch (e) {
    if (!e.status) throw e;
    status = e.status; payload = { error: e.message }; // mesmo formato do handler global
  }
  return { status, body: payload };
}

// ------------------------------------------------------------------ dados sintéticos
await query("INSERT INTO users(id,name,username,password_hash,role,active,approval_status) VALUES(1,'Admin Ana','admin','x','admin',true,'APPROVED'),(90,'Admin Bruno','admin2','x','admin',true,'APPROVED')");
for (let id = 2; id <= 40; id++) await query("INSERT INTO users(id,name,username,password_hash,role,active,approval_status) VALUES($1,$2,$3,'x','courier',true,'APPROVED')", [id, "Motoboy " + id, "m" + id]);
const courier = id => ({ id, role: "courier" });
const admin = { id: 1, role: "admin" };

let seq = 0;
const at = (bearing, meters) => destinationPoint(STORE, bearing, meters);
function addressPayload(point, { street = "Rua Teste", number = String(100 + seq), neighborhood = "Barcelona", city = "São Caetano do Sul", noCoords = false, customer = "Cliente " + seq } = {}) {
  const deliveryAddress = { streetName: street, streetNumber: number, neighborhood, city, state: "SP", postalCode: "09551230", complement: "", reference: "" };
  if (!noCoords && point) deliveryAddress.coordinates = { latitude: point.latitude, longitude: point.longitude };
  return { customer: { name: customer }, delivery: { deliveryAddress }, deliveryAddress };
}
async function ifood(number, point, { age = 20, status = "CONFIRMED", ...opts } = {}) {
  const id = `if-${number}-${++seq}`;
  await query(`INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by,order_created_at,last_event_at,payload)
    VALUES($1,$2,'shop',$3,'DELIVERY','MERCHANT',$4::timestamptz,NOW(),$5::jsonb)`, [id, String(number), status, minutesAgo(age), JSON.stringify(addressPayload(point, opts))]);
  return { platform: "ifood", id, number: "#" + number };
}
async function anota(number, point, { age = 20, status = "READY", ...opts } = {}) {
  const id = `an-${number}-${++seq}`;
  await query(`INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name)
    VALUES($1,'page',$2,$3,'DELIVERY',$4::timestamptz,$4::timestamptz,$5::jsonb,$6)`, [id, String(number), status, minutesAgo(age), JSON.stringify(addressPayload(point, opts)), opts.customer || "Cliente " + seq]);
  return { platform: "anotaai", id, number: "#" + number };
}
const selections = orders => orders.map(o => ({ order_number: o.number, platform: o.platform }));
async function setFlags(flags) {
  for (const [key, value] of Object.entries({ pre_departure_enabled: flags.pre_departure, route_planner_enabled: flags.route_planner, address_correction_enabled: flags.address_correction })) {
    if (value === undefined) continue;
    await query(`INSERT INTO app_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`, [key, String(value)]);
  }
}
async function createPd(courierId, orders) {
  const r = await call("POST /api/courier/pre-departures", { user: courier(courierId), body: { order_numbers: orders.map(o => o.number), order_count: orders.length, platform_selections: selections(orders) } });
  return r;
}
async function checkAll(courierId, pd) {
  let v = pd;
  for (const o of pd.orders) {
    const r = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(courierId), params: { id: String(pd.id), orderId: String(o.id) }, body: { composition_version: v.composition_version } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    v = r.body.pre_departure;
  }
  return v;
}
const route = async (courierId, pd) => call("POST /api/courier/pre-departures/:id/route", { user: courier(courierId), params: { id: String(pd.id) } });
const depart = async (courierId, pd, extra = {}) => call("POST /api/courier/depart", { user: courier(courierId), body: { pre_departure_id: pd.id, composition_version: pd.composition_version, ...extra } });
const getState = async courierId => (await call("GET /api/courier/pre-departure", { user: courier(courierId) })).body;
async function fullFlow(courierId, orders) {
  const created = await createPd(courierId, orders);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let pd = created.body.pre_departure;
  assert.equal(pd.counts.total, orders.length);
  assert.equal(pd.counts.checked, 0);
  assert.equal(pd.can_dispatch, false);
  const steps = [];
  for (const [i, o] of pd.orders.entries()) {
    const r = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(courierId), params: { id: String(pd.id), orderId: String(o.id) }, body: { composition_version: pd.composition_version } });
    pd = r.body.pre_departure;
    steps.push(`${pd.counts.checked}/${pd.counts.total} ${pd.status}`);
    assert.equal(pd.counts.checked, i + 1);
    assert.equal(pd.status, i + 1 < orders.length ? "PARTIALLY_CHECKED" : "CHECKED");
    assert.equal(pd.can_dispatch, false);
  }
  const routed = await route(courierId, pd);
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  pd = routed.body.pre_departure;
  assert.equal(pd.status, "ROUTE_READY");
  assert.equal(pd.can_dispatch, true);
  assert.equal(pd.route.evaluated, factorial(orders.length));
  const sent = await depart(courierId, pd);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return { pd, dispatch: sent.body.dispatch, steps };
}
const stopsOf = async dispatchId => (await query("SELECT * FROM dispatch_route_stops WHERE dispatch_id=$1 ORDER BY sequence", [dispatchId])).rows;
const count = async (sql, args = []) => Number((await query(sql, args)).rows[0].c);

// ------------------------------------------------------------------ execução
const results = [];
async function scenario(id, name, fn) {
  try {
    const evidence = await fn();
    results.push({ id, name, result: "PASS", evidence });
    console.log(`PASS ${id}. ${name} — ${evidence}`);
  } catch (e) {
    results.push({ id, name, result: "FAIL", evidence: String(e?.stack || e) });
    console.log(`FAIL ${id}. ${name}\n${e?.stack || e}`);
  }
}

await setFlags({ pre_departure: true, route_planner: true, address_correction: true });

// Conferência ----------------------------------------------------------------
for (const n of [1, 2, 3, 4, 5]) {
  await scenario(n, `Saída com ${n} pedido(s) e ${n} confirmação(ões)`, async () => {
    const orders = [];
    for (let i = 0; i < n; i++) orders.push(i % 2 ? await anota(1000 + n * 10 + i, at(40 + i * 70, 900 + i * 400), { age: 10 + i * 5 }) : await ifood(1000 + n * 10 + i, at(40 + i * 70, 900 + i * 400), { age: 10 + i * 5 }));
    const { pd, dispatch, steps } = await fullFlow(n + 1, orders);
    const stops = await stopsOf(dispatch.id);
    assert.equal(stops.length, n);
    assert.equal((await query("SELECT COUNT(*)::int c FROM pre_departure_events WHERE pre_departure_id=$1 AND event='BAG_CHECKED'", [pd.id])).rows[0].c, n);
    const checks = (await query("SELECT checked_by,checked_at FROM pre_departure_orders WHERE pre_departure_id=$1", [pd.id])).rows;
    assert.ok(checks.every(c => Number(c.checked_by) === n + 1 && c.checked_at));
    return `${steps.join(" → ")} → ROUTE_READY (${pd.route.evaluated} sequência(s)) → saída ${dispatch.id} com ${stops.length} parada(s)`;
  });
}

await scenario(6, "Tentativa de adicionar um sexto pedido", async () => {
  const orders = []; for (let i = 0; i < 6; i++) orders.push(await ifood(1100 + i, at(i * 50, 1200)));
  const six = await createPd(7, orders);
  assert.equal(six.status, 400);
  const created = await createPd(7, orders.slice(0, 5));
  assert.equal(created.status, 201);
  const pd = created.body.pre_departure;
  const add = await call("POST /api/courier/pre-departures/:id/orders", { user: courier(7), params: { id: String(pd.id) }, body: { composition_version: pd.composition_version, order_number: orders[5].number, platform: "ifood" } });
  assert.equal(add.status, 409); assert.equal(add.body.code, "PRE_DEPARTURE_LIMIT");
  await assert.rejects(query("INSERT INTO pre_departure_orders(pre_departure_id,position,order_number,platform,external_order_id) VALUES($1,6,'#x','ifood','x')", [pd.id]), e => e.code === "23514");
  await assert.rejects(query("INSERT INTO pre_departure_orders(pre_departure_id,position,order_number,platform,external_order_id) VALUES($1,5,'#x','ifood','x')", [pd.id]), e => e.code === "23505");
  await service.cancel({ actorUserId: 7, courierId: 7, id: pd.id });
  return `6 pedidos na criação → HTTP ${six.status}; 6º na pré-saída → 409 ${add.body.code}; banco recusa posição 6 (CHECK) e 6ª linha ativa (índice único)`;
});

await scenario(7, "Tentativa de saída com nenhuma sacola conferida", async () => {
  const orders = [await ifood(1200, at(10, 1500)), await ifood(1201, at(80, 1500))];
  const pd = (await createPd(8, orders)).body.pre_departure;
  const r = await depart(8, pd);
  assert.equal(r.status, 409); assert.equal(r.body.code, "PRE_DEPARTURE_CHECK_PENDING");
  const all = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(8), params: { id: String(pd.id), orderId: "all" }, body: { composition_version: pd.composition_version } });
  assert.equal(all.status, 400);
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=8"), 0);
  const routeTry = await route(8, pd);
  assert.equal(routeTry.body.code, "PRE_DEPARTURE_CHECK_PENDING");
  await service.cancel({ actorUserId: 8, courierId: 8, id: pd.id });
  return `saída → 409 ${r.body.code}; "conferir todas" → HTTP ${all.status} (sem confirmação coletiva); rota → ${routeTry.body.code}; 0 saídas no banco`;
});

await scenario(8, "Tentativa de saída com apenas 4 das 5 sacolas conferidas", async () => {
  const orders = []; for (let i = 0; i < 5; i++) orders.push(await ifood(1300 + i, at(i * 60, 1000 + i * 300)));
  let pd = (await createPd(9, orders)).body.pre_departure;
  for (const o of pd.orders.slice(0, 4)) pd = (await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(9), params: { id: String(pd.id), orderId: String(o.id) }, body: { composition_version: pd.composition_version } })).body.pre_departure;
  assert.equal(pd.status, "PARTIALLY_CHECKED"); assert.equal(pd.counts.checked, 4);
  const r = await depart(9, pd);
  assert.equal(r.status, 409); assert.equal(r.body.code, "PRE_DEPARTURE_CHECK_PENDING");
  // Mesmo forçando o vínculo direto na transação, o banco travado recusa.
  await assert.rejects(context.createDispatchTransaction({ actorUserId: 9, courierId: 9, orders: orders.map(o => o.number), source: "COURIER",
    ifoodLinks: orders.map(o => ({ order_id: o.id, order_number: o.number })), preDepartureId: pd.id, preDepartureCompositionVersion: pd.composition_version }), e => e.code === "PRE_DEPARTURE_NOT_READY");
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=9"), 0);
  await service.cancel({ actorUserId: 9, courierId: 9, id: pd.id });
  return `4/5 PARTIALLY_CHECKED → saída 409 ${r.body.code}; vínculo forçado na transação → PRE_DEPARTURE_NOT_READY (rollback, 0 saídas)`;
});

await scenario(9, "Substituição de um pedido após a conferência", async () => {
  const orders = [await ifood(1400, at(0, 1000)), await ifood(1401, at(90, 1200)), await anota(1402, at(180, 1400))];
  let pd = (await createPd(10, orders)).body.pre_departure;
  pd = await checkAll(10, pd);
  pd = (await route(10, pd)).body.pre_departure;
  assert.equal(pd.status, "ROUTE_READY");
  const replacement = await ifood(1403, at(270, 1100));
  const target = pd.orders.find(o => o.order_number === "#1401");
  const r = await call("POST /api/courier/pre-departures/:id/orders/:orderId/replace", { user: courier(10), params: { id: String(pd.id), orderId: String(target.id) }, body: { composition_version: pd.composition_version, order_number: replacement.number, platform: "ifood" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = r.body.pre_departure;
  assert.equal(after.composition_version, pd.composition_version + 1);
  assert.equal(after.route_valid, false); assert.equal(after.route_status, "PENDING");
  assert.equal(after.status, "PARTIALLY_CHECKED");
  assert.deepEqual(plain(after.orders.map(o => [o.order_number, o.checked])), [["#1400", true], ["#1403", false], ["#1402", true]]);
  const old = (await query("SELECT active,release_reason,checked_at FROM pre_departure_orders WHERE id=$1", [target.id])).rows[0];
  assert.equal(old.active, false); assert.equal(old.release_reason, "REPLACED");
  const stale = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(10), params: { id: String(pd.id), orderId: String(after.orders[1].id) }, body: { composition_version: pd.composition_version } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "PRE_DEPARTURE_VERSION_CONFLICT");
  // O pedido trocado fica livre para outro motoboy.
  const other = await createPd(11, [{ platform: "ifood", id: target.external_order_id, number: "#1401" }]);
  assert.equal(other.status, 201);
  await service.cancel({ actorUserId: 11, courierId: 11, id: other.body.pre_departure.id });
  await service.cancel({ actorUserId: 10, courierId: 10, id: pd.id });
  return `troca #1401→#1403: só a nova sacola volta a pendente, rota invalidada (composição ${pd.composition_version}→${after.composition_version}); conferência na versão antiga → 409 ${stale.body.code}; #1401 liberado`;
});

await scenario(10, "Dois motoboys tentando reservar o mesmo pedido", async () => {
  const o = await ifood(1500, at(30, 1700));
  const [a, b] = await Promise.all([createPd(12, [o]), createPd(13, [o])]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.code, "ORDER_RESERVED");
  assert.equal(await count("SELECT COUNT(*)::int c FROM pre_departure_orders WHERE external_order_id=$1 AND active", [o.id]), 1);
  // A saída manual do admin (fluxo existente) também respeita a reserva.
  await assert.rejects(context.createDispatchTransaction({ actorUserId: 1, courierId: 14, orders: [o.number], source: "ADMIN", ifoodLinks: [{ order_id: o.id, order_number: o.number }] }), e => e.code === "ORDER_RESERVED");
  const winner = a.status === 201 ? a : b;
  await service.cancel({ actorUserId: 1, id: winner.body.pre_departure.id, reason: "teste concorrência", byAdmin: true });
  return `criações simultâneas → HTTP ${statuses.join(" e ")} (${loser.body.code}); 1 reserva ativa; saída manual de outro motoboy → ORDER_RESERVED`;
});

await scenario(11, "Números iguais em plataformas diferentes", async () => {
  const i = await ifood(1600, at(120, 1300)), a = await anota(1600, at(220, 1300));
  const ambiguous = await call("POST /api/courier/pre-departures", { user: courier(15), body: { order_numbers: ["#1600"], order_count: 1 } });
  assert.equal(ambiguous.status, 409); assert.equal(ambiguous.body.code, "ORDER_PLATFORM_REQUIRED");
  const pi = await createPd(15, [i]);
  const pa = await createPd(16, [a]);
  assert.equal(pi.status, 201); assert.equal(pa.status, 201);
  assert.equal(pi.body.pre_departure.orders[0].external_order_id, i.id);
  assert.equal(pa.body.pre_departure.orders[0].external_order_id, a.id);
  const third = await createPd(17, [i]);
  assert.equal(third.body.code, "ORDER_RESERVED");
  await service.cancel({ actorUserId: 15, courierId: 15, id: pi.body.pre_departure.id });
  await service.cancel({ actorUserId: 16, courierId: 16, id: pa.body.pre_departure.id });
  return `#1600 sem escolha → 409 ${ambiguous.body.code}; iFood ${i.id} e Anota AI ${a.id} reservados por motoboys diferentes; 3º motoboy no iFood → ${third.body.code}`;
});

// Roteirização -----------------------------------------------------------------
function oracle(stops, minutes, p = ROUTE_PLANNER_DEFAULTS) {
  let best = null;
  for (const order of permutations(stops.length)) {
    let t = 0, prev = 0, sumW = 0, pen = 0, maxW = 0;
    order.forEach((s, k) => { t += (k ? p.stop_minutes : 0) + minutes[prev][s + 1]; const w = stops[s].age_minutes + t; sumW += w; maxW = Math.max(maxW, w); pen += Math.max(0, w - p.wait_limit_minutes) ** 2; prev = s + 1; });
    const cost = p.alpha * (t + p.stop_minutes) + p.beta * sumW + p.gamma * pen;
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && maxW < best.maxW - 1e-9)) best = { order, cost, maxW };
  }
  return best;
}
const sim = id => SCENARIOS.find(s => s.id === id);
const planOf = scenarioDef => {
  const stops = scenarioDef.stops.map(s => ({ key: s.key, age_minutes: s.age }));
  const minutes = syntheticMatrix(scenarioDef.stops);
  return { stops, minutes, plan: planRoute({ stops, minutes, keepCandidates: true }) };
};
for (const [id, n] of [[12, 1], [13, 2], [14, 3], [15, 4], [16, 5]]) {
  await scenario(id, n === 1 ? "Cálculo com um destino" : `Comparação das ${factorial(n)} sequências para ${n} destinos`, async () => {
    const def = { stops: sim("S4").stops.slice(0, n) };
    const { stops, minutes, plan } = planOf(def);
    assert.equal(plan.evaluated, factorial(n));
    assert.equal(new Set(plan.candidates.map(c => c.order.join(""))).size, factorial(n), "todas distintas");
    const o = oracle(stops, minutes);
    assert.deepEqual(plain(plan.best.order), plain(o.order));
    assert.ok(Math.abs(plan.best.cost - o.cost) < 1e-9);
    assert.ok(plan.candidates.every(c => c.cost >= plan.best.cost - 1e-9));
    if (n === 1) assert.equal(plan.best.stops[0].arrival_minutes, minutes[0][1]);
    const worst = plan.candidates.at(-1);
    return `${plan.evaluated} sequência(s) avaliadas; melhor ${plan.best.sequence.join("→")} custo ${plan.best.cost.toFixed(1)} (oráculo independente igual); pior ${worst.sequence.join("→")} custo ${worst.cost.toFixed(1)}`;
  });
}

await scenario(17, "Pedido muito antigo disputando prioridade com um pedido mais próximo", async () => {
  const { plan, minutes, stops } = planOf(sim("S1"));
  const shortest = planRoute({ stops, minutes, params: { alpha: 1, beta: 0, gamma: 0 } });
  const posA = plan.best.sequence.indexOf("A");
  assert.ok(posA > 0 && posA < 3, "antigo nem primeiro automático nem último");
  assert.equal(shortest.best.sequence.at(-1), "A", "trajeto mais curto deixaria o antigo por último");
  const waitA = c => c.stops.find(s => s.key === "A").wait_minutes;
  assert.ok(waitA(plan.best) < waitA(shortest.best) - 5);
  return `escolhida ${plan.best.sequence.join("→")} (A, 52 min de espera, em ${posA + 1}º); A chega com ${waitA(plan.best).toFixed(1)} min contra ${waitA(shortest.best).toFixed(1)} min no trajeto mais curto ${shortest.best.sequence.join("→")}`;
});

await scenario(18, "Pedido muito distante alterando a sequência ótima", async () => {
  const near = [{ key: "A", x: 1.0, y: 0.1, age: 15 }, { key: "B", x: -1.0, y: 0.2, age: 15 }, { key: "C", x: 0.1, y: 1.1, age: 15 }];
  const without = planOf({ stops: near }).plan.best.sequence;
  const withFar = planOf({ stops: [...near, { key: "D", x: 8.0, y: 0.4, age: 15 }] }).plan.best.sequence;
  assert.equal(withFar.at(-1), "D", "o distante fica no fim");
  assert.equal(withFar.at(-2), "A", "a parada a caminho do distante vem logo antes dele");
  assert.notDeepEqual(plain(withFar.slice(0, 3)), plain(without));
  return `sem o distante: ${without.join("→")}; com D a 8 km: ${withFar.join("→")} (A, no caminho de D, passa para antes dele)`;
});

await scenario(19, "Cinco pedidos próximos entre si", async () => {
  const { plan, stops, minutes } = planOf(sim("S5"));
  assert.equal(plan.evaluated, 120);
  assert.deepEqual(plain(plan.best.order), plain(oracle(stops, minutes).order));
  assert.ok(plan.best.duration_minutes < 15);
  return `120 sequências; ${plan.best.sequence.join("→")} em ${plan.best.duration_minutes.toFixed(1)} min, maior espera ${plan.best.max_wait_minutes.toFixed(1)} min`;
});

await scenario(20, "Cinco pedidos distribuídos por bairros diferentes", async () => {
  const { plan, stops, minutes } = planOf(sim("S4"));
  assert.deepEqual(plain(plan.best.order), plain(oracle(stops, minutes).order));
  assert.ok(plan.best.cost <= plan.typed_order.cost);
  return `${plan.best.sequence.join("→")} custo ${plan.best.cost.toFixed(1)} × ordem digitada ${plan.typed_order.sequence.join("→")} custo ${plan.typed_order.cost.toFixed(1)}`;
});

await scenario(21, "Falha no serviço de roteirização", async () => {
  const orders = [await ifood(1700, at(10, 2000)), await ifood(1701, at(200, 2000))];
  let pd = await checkAll(18, (await createPd(18, orders)).body.pre_departure);
  google.down = true;
  const r = await route(18, pd);
  google.down = false;
  pd = r.body.pre_departure;
  assert.equal(pd.status, "BLOCKED"); assert.equal(pd.route_status, "NEEDS_ADMIN"); assert.equal(pd.route, null);
  assert.equal((await depart(18, pd)).status, 409);
  // Chave ausente: um processo novo (a chave é lida ao subir o servidor).
  google.configured = false;
  const notConfigured = await makeService().computeRoute(pd.id, { force: true });
  google.configured = true;
  assert.equal(notConfigured.route_error.code, "GOOGLE_ROUTES_NOT_CONFIGURED");
  const ex = await call("POST /api/admin/pre-departures/:id/sequence", { user: admin, params: { id: String(pd.id) }, body: { reason: "Google fora do ar no pico" } });
  pd = ex.body.pre_departure;
  assert.equal(pd.route_status, "ADMIN"); assert.equal(pd.ack_required, true); assert.equal(pd.can_dispatch, false);
  pd = (await call("POST /api/courier/pre-departures/:id/ack", { user: courier(18), params: { id: String(pd.id) }, body: { version: pd.version } })).body.pre_departure;
  const sent = await depart(18, pd);
  assert.equal(sent.status, 201);
  assert.ok(audits.some(a => a[1] === "PRE_DEPARTURE_ADMIN_SEQUENCE"));
  return `Google indisponível → BLOCKED/NEEDS_ADMIN sem tempos inventados e saída bloqueada; sem chave → ${notConfigured.route_error.code}; exceção do admin com motivo (auditada) + Ciente do motoboy → saída ${sent.body.dispatch.id}`;
});

await scenario(22, "Endereço incompleto ou ambíguo", async () => {
  const incomplete = await ifood(1800, null, { noCoords: true, number: "" });
  const far = await ifood(1801, null, { noCoords: true, city: "Campinas", street: "Av. Brasil", number: "10" });
  const missing = await anota(1802, null, { noCoords: true, street: "Rua Inexistente", number: "5" });
  const codes = [];
  for (const [c, o] of [[19, incomplete], [20, far], [21, missing]]) {
    const pd = await checkAll(c, (await createPd(c, [o])).body.pre_departure);
    const v = (await route(c, pd)).body.pre_departure;
    assert.equal(v.route_status, "NEEDS_ADMIN"); assert.equal(v.status, "BLOCKED"); assert.equal(v.route, null);
    codes.push(v.route_error.code);
    await service.cancel({ actorUserId: c, courierId: c, id: pd.id });
  }
  assert.deepEqual(codes, ["ADDRESS_INCOMPLETE", "ADDRESS_OUT_OF_REGION", "ADDRESS_NOT_FOUND"]);
  return `sem número e sem pino → ${codes[0]}; localizado a 80 km → ${codes[1]}; não localizado → ${codes[2]}; todos vão para o admin, sem rota fictícia`;
});

await scenario(23, "Recuperação de uma rota após perda de conexão", async () => {
  const orders = [await ifood(1900, at(15, 1000)), await ifood(1901, at(100, 1800)), await anota(1902, at(250, 1500))];
  let pd = (await createPd(22, orders)).body.pre_departure;
  for (const o of pd.orders.slice(0, 2)) pd = (await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(22), params: { id: String(pd.id), orderId: String(o.id) }, body: { composition_version: pd.composition_version } })).body.pre_departure;
  const again = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(22), params: { id: String(pd.id), orderId: String(pd.orders[1].id) }, body: { composition_version: pd.composition_version } });
  assert.equal(again.status, 200); assert.equal(again.body.pre_departure.counts.checked, 2, "reenvio idempotente");
  const reopened = (await getState(22)).pre_departure;
  assert.equal(reopened.id, pd.id); assert.equal(reopened.counts.checked, 2);
  // Cálculo interrompido (queda/reinício): volta para PENDING e recalcula.
  pd = await checkAll(22, reopened);
  await query("UPDATE pre_departures SET route_status='CALCULATING' WHERE id=$1", [pd.id]);
  assert.equal(await service.recoverInterrupted(), 1);
  pd = (await route(22, (await getState(22)).pre_departure)).body.pre_departure;
  assert.equal(pd.status, "ROUTE_READY");
  // Política de expiração: só a parada além do prazo expira; abrir a tela renova.
  await query("UPDATE pre_departures SET last_activity_at=NOW()-INTERVAL '44 minutes' WHERE id=$1", [pd.id]);
  await getState(22);
  assert.equal(await service.expireStale(), 0);
  const sent = await depart(22, pd);
  const routeAfter = (await getState(22)).route;
  assert.equal(routeAfter.dispatch_id, sent.body.dispatch.id); assert.equal(routeAfter.stops.length, 3);
  return `2 conferências preservadas após reabrir; reenvio da mesma conferência não duplica; cálculo interrompido → recuperado e recalculado; tela aberta renova o prazo; após a saída a Minha Rota volta com ${routeAfter.stops.length} paradas`;
});

// Correção de endereço -------------------------------------------------------------
const addressBody = (fields, point, expected, reason = "Cliente informou o endereço errado") => ({ fields, latitude: point.latitude, longitude: point.longitude, location_source: "ADMIN_PIN", reason, expected_version: expected });
const newFields = n => ({ street: "Rua Corrigida", number: String(n), neighborhood: "Santa Paula", city: "São Caetano do Sul", state: "SP", postal_code: "09541-000", complement: "Apto 12", reference: "Portão azul" });
const correct = (o, point, expected = 0, user = admin) => call("PUT /api/admin/orders/:platform/:externalId/address", { user, params: { platform: o.platform, externalId: o.id }, body: addressBody(newFields(77), point, expected) });

await scenario(24, "Admin altera endereço antes da conferência", async () => {
  const orders = [await ifood(2000, at(20, 1200)), await anota(2001, at(160, 1600))];
  let pd = (await createPd(23, orders)).body.pre_departure;
  const target = at(60, 2600);
  const r = await correct(orders[0], target);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.address.version, 1); assert.equal(r.body.address.stage, "PRE_DEPARTURE_UNCHECKED");
  const payload = (await query("SELECT payload FROM ifood_orders WHERE order_id=$1", [orders[0].id])).rows[0].payload;
  assert.equal(payload.delivery.deliveryAddress.streetName, "Rua Teste", "original da plataforma intacto");
  pd = (await getState(23)).pre_departure;
  assert.equal(pd.counts.checked, 0); assert.equal(pd.ack_required, true);
  assert.equal(pd.orders[0].address.text.startsWith("Rua Corrigida, 77"), true);
  assert.equal(pd.orders[0].address_override.original.startsWith("Rua Teste"), true);
  pd = await checkAll(23, pd);
  pd = (await route(23, pd)).body.pre_departure;
  const stored = (await query("SELECT route FROM pre_departures WHERE id=$1", [pd.id])).rows[0].route;
  const stop = stored.stops.find(s => s.external_order_id === orders[0].id);
  assert.equal(stop.location_source, "ADMIN_ADMIN_PIN"); assert.ok(Math.abs(stop.latitude - target.latitude) < 1e-9);
  await service.cancel({ actorUserId: 23, courierId: 23, id: pd.id });
  return `versão 1 gravada (original da plataforma preservado no payload e no histórico); motoboy vê o novo endereço e precisa dar Ciente; rota usa o ponto corrigido`;
});

await scenario(25, "Admin altera endereço depois da conferência, mas antes da saída", async () => {
  const orders = [await ifood(2100, at(30, 900)), await ifood(2101, at(150, 2500)), await anota(2102, at(260, 1700))];
  let pd = await checkAll(24, (await createPd(24, orders)).body.pre_departure);
  pd = (await route(24, pd)).body.pre_departure;
  const before = pd.route_version;
  const r = await correct(orders[1], at(330, 3000));
  assert.equal(r.status, 200);
  pd = (await getState(24)).pre_departure;
  assert.equal(pd.counts.checked, 3, "sem nova conferência física");
  assert.equal(pd.status, "ROUTE_READY"); assert.ok(pd.route_version > before, "rota recalculada");
  assert.equal(pd.ack_required, true);
  const blocked = await depart(24, pd);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "ACK_REQUIRED");
  pd = (await call("POST /api/courier/pre-departures/:id/ack", { user: courier(24), params: { id: String(pd.id) }, body: { version: pd.version } })).body.pre_departure;
  const sent = await depart(24, pd);
  assert.equal(sent.status, 201);
  return `3/3 conferências mantidas; rota recalculada (versão ${before}→${pd.route_version}); saída bloqueada até o Ciente (${blocked.body.code}); depois do Ciente → saída ${sent.body.dispatch.id}`;
});

const fiveOrders = async base => [
  await ifood(base, at(10, 900), { age: 25 }), await anota(base + 1, at(80, 1900), { age: 18 }), await ifood(base + 2, at(150, 1400), { age: 30 }),
  await ifood(base + 3, at(220, 2600), { age: 12 }), await anota(base + 4, at(300, 1100), { age: 22 })
];
const deliver = async (dispatchId, stop) => stop.platform === "ifood"
  ? query("INSERT INTO ifood_delivery_confirmations(ifood_order_id,dispatch_id,courier_id,status,verified_at) SELECT $1,$2,courier_id,'VERIFIED',NOW() FROM dispatches WHERE id=$2", [stop.external_order_id, dispatchId])
  : query("INSERT INTO anotaai_delivery_confirmations(anotaai_order_id,dispatch_id,courier_id) SELECT $1,$2,courier_id FROM dispatches WHERE id=$2", [stop.external_order_id, dispatchId]);

let route26 = null;
await scenario(26, "Admin altera endereço durante uma saída com cinco pedidos", async () => {
  const orders = await fiveOrders(2200);
  const { dispatch } = await fullFlow(25, orders);
  route26 = { dispatch, orders };
  const view = (await getState(25)).route;
  const pending = view.stops[2];
  const o = orders.find(x => x.id === pending.external_order_id);
  const r = await correct(o, at(45, 3200));
  assert.equal(r.status, 200); assert.equal(r.body.address.stage, "ON_ROUTE");
  const after = (await getState(25)).route;
  assert.equal(after.route_version, 2); assert.equal(after.ack_required, true);
  const changed = after.stops.find(s => s.external_order_id === o.id);
  assert.equal(changed.address.source, "ADMIN"); assert.ok(changed.address.text.startsWith("Rua Corrigida"));
  const list = await call(o.platform === "ifood" ? "GET /api/courier/ifood/deliveries" : "GET /api/courier/anotaai/deliveries", { user: courier(25) }).catch(() => null);
  const deliveries = await context.applyOperationalAddresses({ current: [{ order_id: o.id, navigation: { address: "antigo" } }] }, o.platform);
  assert.ok(deliveries.current[0].navigation.address.startsWith("Rua Corrigida"), "Waze/Maps usam o endereço vigente");
  assert.ok(emitted.some(([e, p]) => e === "dispatch:changed" && Number(p.courier_id) === 25 && p.change === "ROUTE_UPDATED"));
  void list;
  return `pedido ${o.number} corrigido em rota: rota versão 2, Ciente pendente, Minha Rota e navegação (Waze/Google Maps) usam "${changed.address.text.slice(0, 40)}…"`;
});

await scenario(27, "Dois pedidos já entregues e a rota dos três restantes recalculada", async () => {
  const { dispatch } = route26;
  let view = (await getState(25)).route;
  await call("POST /api/courier/routes/:dispatchId/ack", { user: courier(25), params: { dispatchId: String(dispatch.id) }, body: { route_version: view.route_version } });
  view = (await getState(25)).route;
  await deliver(dispatch.id, view.stops[0]);
  clock += 4 * 60000;
  await deliver(dispatch.id, view.stops[1]);
  const delivered = view.stops.slice(0, 2).map(s => s.order_number);
  const pending = view.stops.slice(2);
  const target = route26.orders.find(o => o.id === pending[1].external_order_id);
  const r = await correct(target, at(200, 3500), 0);
  assert.equal(r.status, 200);
  const after = (await getState(25)).route;
  assert.deepEqual(plain(after.stops.slice(0, 2).map(s => [s.order_number, s.state])), plain(delivered.map(n => [n, "DELIVERED"])));
  assert.equal(after.stops.filter(s => s.state === "PENDING").length, 3);
  const routeRow = (await query("SELECT route FROM dispatch_routes WHERE dispatch_id=$1", [dispatch.id])).rows[0].route;
  const last = routeRow.history.at(-1);
  assert.equal(routeRow.pending_plan.evaluated, 6, "3! sequências dos pendentes");
  assert.ok(last.origin.startsWith("ENTREGA"), "origem confiável = última entrega confirmada");
  assert.equal(after.stops.find(s => s.is_next).state, "PENDING");
  return `entregues mantidos (${delivered.join(", ")}); 3 pendentes recalculados com ${routeRow.pending_plan.evaluated} sequências a partir de "${last.origin}"; nova ordem pendente ${last.pending_sequence.join(" → ")}`;
});

await scenario(28, "Admin tenta alterar operacionalmente um pedido já entregue", async () => {
  const view = (await getState(25)).route;
  const done = view.stops.find(s => s.state === "DELIVERED");
  const o = route26.orders.find(x => x.id === done.external_order_id);
  const r = await correct(o, at(10, 1000));
  assert.equal(r.status, 409); assert.equal(r.body.code, "ORDER_ALREADY_DELIVERED");
  const occ = await call("POST /api/admin/orders/:platform/:externalId/occurrence", { user: admin, params: { platform: o.platform, externalId: o.id }, body: { note: "Cliente disse que o endereço tinha bloco errado" } });
  assert.equal(occ.status, 200); assert.equal(occ.body.stage, "DELIVERED");
  assert.ok(audits.some(a => a[1] === "ORDER_ADMIN_OCCURRENCE"));
  assert.equal(await count("SELECT COUNT(*)::int c FROM order_address_overrides WHERE external_order_id=$1", [o.id]), 0);
  return `correção de ${o.number} entregue → 409 ${r.body.code}; ocorrência registrada (auditoria), destino intacto`;
});

await scenario(29, "Dois administradores modificando o mesmo endereço simultaneamente", async () => {
  const o = await ifood(2300, at(100, 1500));
  const pd = (await createPd(26, [o])).body.pre_departure;
  const [a, b] = await Promise.all([correct(o, at(10, 2000), 0, admin), correct(o, at(20, 2100), 0, { id: 90, role: "admin" })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.code, "ADDRESS_VERSION_CONFLICT");
  assert.equal(await count("SELECT COUNT(*)::int c FROM order_address_overrides WHERE external_order_id=$1", [o.id]), 1);
  const third = await correct(o, at(30, 2200), 1);
  assert.equal(third.status, 200); assert.equal(third.body.address.version, 2);
  await service.cancel({ actorUserId: 26, courierId: 26, id: pd.id });
  return `duas gravações da versão 0 → HTTP ${statuses.join(" e ")} (ADDRESS_VERSION_CONFLICT); 1 linha; nova edição sobre a versão 1 → versão 2`;
});

await scenario(30, "Motoboy recebe e reconhece a notificação de alteração", async () => {
  const { dispatch } = route26;
  const view = (await getState(25)).route;
  assert.equal(view.ack_required, true);
  const stale = await call("POST /api/courier/routes/:dispatchId/ack", { user: courier(25), params: { dispatchId: String(dispatch.id) }, body: { route_version: view.route_version - 1 } });
  assert.equal(stale.status, 409);
  const ok = await call("POST /api/courier/routes/:dispatchId/ack", { user: courier(25), params: { dispatchId: String(dispatch.id) }, body: { route_version: view.route_version } });
  assert.equal(ok.status, 200); assert.equal(ok.body.route.ack_required, false); assert.equal(ok.body.route.acked_version, view.route_version);
  assert.ok(ok.body.route.stops.every(s => !s.changed_unacked));
  const otherCourier = await call("POST /api/courier/routes/:dispatchId/ack", { user: courier(26), params: { dispatchId: String(dispatch.id) }, body: { route_version: view.route_version } });
  assert.equal(otherCourier.status, 404);
  assert.equal(await count("SELECT COUNT(*)::int c FROM pre_departure_events WHERE dispatch_id=$1 AND event='ROUTE_ACKNOWLEDGED'", [dispatch.id]), 2);
  return `evento dispatch:changed/ROUTE_UPDATED enviado ao motoboy; Ciente com versão antiga → 409; Ciente atual → versão ${ok.body.route.acked_version} reconhecida; outro motoboy → 404`;
});

// Integrações e estabilidade ------------------------------------------------------
await scenario(31, "Despacho definitivo de cinco pedidos", async () => {
  const orders = await fiveOrders(2400);
  const jobsBefore = await count("SELECT COUNT(*)::int c FROM ifood_dispatch_jobs");
  const { pd, dispatch } = await fullFlow(27, orders);
  const ifoodCount = orders.filter(o => o.platform === "ifood").length;
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatch_orders WHERE dispatch_id=$1", [dispatch.id]), 5);
  assert.equal(await count("SELECT COUNT(*)::int c FROM active_order_locks WHERE dispatch_id=$1", [dispatch.id]), 5);
  assert.equal(await count("SELECT COUNT(*)::int c FROM ifood_dispatch_jobs") - jobsBefore, ifoodCount);
  assert.equal(await count("SELECT COUNT(*)::int c FROM anotaai_dispatch_links WHERE dispatch_id=$1", [dispatch.id]), 5 - ifoodCount);
  const row = (await query("SELECT status,dispatch_id FROM pre_departures WHERE id=$1", [pd.id])).rows[0];
  assert.equal(row.status, "DISPATCHED"); assert.equal(Number(row.dispatch_id), Number(dispatch.id));
  assert.equal(await count("SELECT COUNT(*)::int c FROM pre_departure_orders WHERE pre_departure_id=$1 AND active", [pd.id]), 0);
  const stops = await stopsOf(dispatch.id);
  assert.deepEqual(stops.map(s => s.order_number), pd.route.stops.map(s => s.order_number));
  assert.equal(Number((await query("SELECT route_sla_minutes FROM dispatches WHERE id=$1", [dispatch.id])).rows[0].route_sla_minutes), 45);
  return `5 pedidos: 5 dispatch_orders, 5 travas ativas, ${ifoodCount} job(s) iFood, ${5 - ifoodCount} vínculo(s) Anota AI, sequência ${stops.map(s => s.order_number).join("→")}, meta de 45 min`;
});

await scenario(32, "Duplo clique no botão de saída", async () => {
  const orders = [await ifood(2500, at(40, 1300)), await anota(2501, at(140, 1600)), await ifood(2502, at(240, 1900))];
  let pd = await checkAll(28, (await createPd(28, orders)).body.pre_departure);
  pd = (await route(28, pd)).body.pre_departure;
  const jobsBefore = await count("SELECT COUNT(*)::int c FROM ifood_dispatch_jobs");
  const [a, b] = await Promise.all([depart(28, pd), depart(28, pd)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.dispatch.id, b.body.dispatch.id);
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=28"), 1);
  assert.equal(await count("SELECT COUNT(*)::int c FROM ifood_dispatch_jobs") - jobsBefore, 2);
  return `dois envios simultâneos → HTTP 201 e 200 (duplicate) com a mesma saída ${a.body.dispatch.id}; 1 saída e 2 jobs iFood (sem reprocessar)`;
});

await scenario(33, "Falha de conexão durante o despacho", async () => {
  const orders = [await ifood(2600, at(60, 1100)), await ifood(2601, at(200, 2000))];
  let pd = await checkAll(29, (await createPd(29, orders)).body.pre_departure);
  pd = (await route(29, pd)).body.pre_departure;
  const first = await depart(29, pd); // resposta "perdida" no celular
  assert.equal(first.status, 201);
  const retry = await depart(29, pd);
  assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true); assert.equal(retry.body.dispatch.id, first.body.dispatch.id);
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=29"), 1);
  return `o app reenviou após perder a resposta: mesma saída ${retry.body.dispatch.id} (duplicate=true), nada duplicado`;
});

await scenario(34, "Recuperação após reinício do servidor", async () => {
  const orders = [await ifood(2700, at(70, 1500)), await anota(2701, at(170, 1500))];
  let pd = (await createPd(30, orders)).body.pre_departure;
  pd = (await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(30), params: { id: String(pd.id), orderId: String(pd.orders[0].id) }, body: { composition_version: pd.composition_version } })).body.pre_departure;
  await query("UPDATE pre_departures SET route_status='CALCULATING' WHERE id=$1", [pd.id]);
  service = makeService(); context.preDepartureService = service; // novo processo, mesmo banco
  assert.equal(await service.recoverInterrupted(), 1);
  const back = (await getState(30)).pre_departure;
  assert.equal(back.id, pd.id); assert.equal(back.counts.checked, 1); assert.equal(back.route_status, "PENDING");
  const routeOnRoad = (await getState(25)).route;
  assert.equal(routeOnRoad.dispatch_id, route26.dispatch.id);
  pd = await checkAll(30, back);
  pd = (await route(30, pd)).body.pre_departure;
  assert.equal(pd.status, "ROUTE_READY");
  await service.cancel({ actorUserId: 30, courierId: 30, id: pd.id });
  return `após reiniciar: pré-saída ${back.id} com 1/2 conferências, cálculo interrompido volta a PENDING e recalcula; rota em andamento (saída ${routeOnRoad.dispatch_id}) continua disponível`;
});

await scenario(35, "Confirmação de entrega iFood com código", async () => {
  const orders = [await ifood(2800, at(20, 800)), await ifood(2801, at(30, 1600))];
  const { dispatch } = await fullFlow(31, orders);
  let view = (await getState(31)).route;
  const [first, second] = view.stops;
  assert.equal(first.is_next, true);
  await deliver(dispatch.id, first); // efeito do POST /verify-delivery após o iFood aceitar o código
  view = (await getState(31)).route;
  assert.equal(view.stops[0].state, "DELIVERED"); assert.equal(view.stops[1].is_next, true); assert.equal(view.stops[1].state, "PENDING");
  assert.equal(await count("SELECT COUNT(*)::int c FROM ifood_delivery_confirmations WHERE ifood_order_id=$1", [second.external_order_id]), 0, "a próxima não é confirmada sozinha");
  return `após o código do 1º pedido, a navegação passa ao ${second.order_number}; ele continua PENDENTE (nada confirmado automaticamente). Endpoint com código: selftest-delivery-confirmation`;
});

await scenario(36, "Confirmação de entrega Anota AI sem código", async () => {
  const orders = [await anota(2900, at(250, 900)), await anota(2901, at(260, 1700))];
  const { dispatch } = await fullFlow(32, orders);
  let view = (await getState(32)).route;
  await deliver(dispatch.id, view.stops[0]);
  view = (await getState(32)).route;
  assert.equal(view.stops[0].state, "DELIVERED"); assert.equal(view.stops[1].is_next, true);
  // Entregar fora da ordem é permitido (cada plataforma decide), mas fica registrado.
  return `confirmação sem código marca a parada e libera a próxima (${view.stops[1].order_number}). Endpoint: selftest-anotaai-delivery-stages`;
});

await scenario(37, "Bloqueio de nova saída quando ainda houver entregas pendentes", async () => {
  const o = await ifood(3000, at(90, 1000));
  const r = await createPd(32, [o]);
  assert.equal(r.status, 409); assert.equal(r.body.code, "PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE");
  await assert.rejects(context.createDispatchTransaction({ actorUserId: 32, courierId: 32, orders: [o.number], source: "COURIER", ifoodLinks: [{ order_id: o.id, order_number: o.number }] }), e => e.code === "PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE");
  return `motoboy com saída em rua → pré-saída 409 ${r.body.code}; transação de saída também bloqueia (regra existente preservada)`;
});

await scenario(38, "Preservação dos relatórios e pagamentos", async () => {
  const orders = [await ifood(3100, at(100, 1300)), await ifood(3101, at(190, 1300)), await anota(3102, at(280, 1300))];
  let pd = await checkAll(33, (await createPd(33, orders)).body.pre_departure);
  pd = (await route(33, pd)).body.pre_departure;
  const before = await context.getCourierDeliveryCount(33, today);
  assert.equal(before, 0, "pré-saída não conta entrega");
  await depart(33, pd);
  const after = await context.getCourierDeliveryCount(33, today);
  assert.equal(after, 3);
  return `contagem de pagamento: ${before} durante a pré-saída, ${after} após a saída definitiva (mesma consulta de pagamento existente)`;
});

await scenario(39, "Contador começa somente na saída definitiva", async () => {
  const orders = [await ifood(3200, at(110, 1000)), await anota(3201, at(10, 2000))];
  const createdAt = clock;
  let pd = await checkAll(34, (await createPd(34, orders)).body.pre_departure);
  pd = (await route(34, pd)).body.pre_departure;
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=34"), 0);
  assert.equal(await count("SELECT COUNT(*)::int c FROM ifood_dispatch_jobs j JOIN ifood_orders o ON o.order_id=j.ifood_order_id WHERE o.display_id='3200'"), 0);
  assert.equal(await count("SELECT COUNT(*)::int c FROM anotaai_dispatch_links WHERE anotaai_order_id=$1", [orders[1].id]), 0);
  clock += 9 * 60000;
  const sent = await depart(34, pd);
  const departed = new Date((await query("SELECT departed_at FROM dispatches WHERE id=$1", [sent.body.dispatch.id])).rows[0].departed_at).getTime();
  assert.equal(departed, clock); assert.equal(departed - createdAt, 9 * 60000);
  return `durante a pré-saída: 0 saídas, 0 jobs iFood, 0 vínculos Anota AI; saída às +9 min → departed_at = momento da saída definitiva`;
});

await scenario(40, "Fluxo legado com as novas funcionalidades desativadas", async () => {
  await setFlags({ pre_departure: false, route_planner: false, address_correction: false });
  const o = await ifood(3300, at(130, 1200));
  const state = await getState(35);
  assert.equal(state.enabled.pre_departure, false); assert.equal(state.pre_departure, null);
  const r = await call("POST /api/courier/depart", { user: courier(35), body: { order_numbers: [o.number], order_count: 1, platform_selections: selections([o]), client_token: "legacy-1" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatch_routes WHERE dispatch_id=$1", [r.body.dispatch.id]), 0);
  const create = await createPd(36, [await ifood(3301, at(140, 1200))]);
  assert.equal(create.body.code, "FEATURE_DISABLED");
  const fix = await correct(o, at(10, 1000));
  assert.equal(fix.body.code, "FEATURE_DISABLED");
  await setFlags({ pre_departure: true });
  const blocked = await call("POST /api/courier/depart", { user: courier(37), body: { order_numbers: ["#1"], order_count: 1, client_token: "legacy-2" } });
  assert.equal(blocked.body.code, "PRE_DEPARTURE_REQUIRED");
  await setFlags({ pre_departure: false });
  return `flags desligadas: saída direta HTTP ${r.status} sem rota nova; criar pré-saída e corrigir endereço → FEATURE_DISABLED; com a conferência ligada a saída direta pede a pré-saída`;
});

// Verificações adicionais de segurança ---------------------------------------------
await scenario("S1", "Alteração de endereço durante o cálculo da rota", async () => {
  await setFlags({ pre_departure: true, route_planner: true, address_correction: true });
  const orders = [await ifood(3400, at(150, 1000)), await ifood(3401, at(250, 2200))];
  let pd = await checkAll(38, (await createPd(38, orders)).body.pre_departure);
  const moved = at(20, 2800);
  google.onMatrix = async () => { await service.correctAddress({ adminId: 1, platform: "ifood", externalOrderId: orders[1].id, fields: newFields(9), latitude: moved.latitude, longitude: moved.longitude, locationSource: "ADMIN_PIN", reason: "Cliente ligou durante o cálculo", expectedVersion: 0 }); };
  pd = (await route(38, pd)).body.pre_departure;
  const stored = (await query("SELECT route FROM pre_departures WHERE id=$1", [pd.id])).rows[0].route;
  const stop = stored.stops.find(s => s.external_order_id === orders[1].id);
  assert.ok(Math.abs(stop.latitude - moved.latitude) < 1e-9, "rota final usa o endereço novo");
  assert.equal(pd.route_valid, true);
  await service.cancel({ actorUserId: 38, courierId: 38, id: pd.id });
  return `endereço trocado no meio do cálculo: o resultado antigo foi descartado e a rota gravada usa o novo ponto`;
});

await scenario("S2", "Alteração de pedido durante a confirmação definitiva", async () => {
  const orders = [await ifood(3500, at(160, 1000)), await ifood(3501, at(260, 1500))];
  let pd = await checkAll(39, (await createPd(39, orders)).body.pre_departure);
  pd = (await route(39, pd)).body.pre_departure;
  const extra = await ifood(3502, at(300, 900));
  context.onIfoodFetch = async () => { await service.replaceOrder({ courierId: 39, id: pd.id, orderId: pd.orders[1].id, link: { platform: "ifood", order_id: extra.id, order_number: extra.number }, compositionVersion: pd.composition_version }); };
  const r = await depart(39, pd);
  assert.equal(r.status, 409); assert.ok(["PRE_DEPARTURE_VERSION_CONFLICT", "PRE_DEPARTURE_NOT_READY", "PRE_DEPARTURE_ORDERS_CHANGED"].includes(r.body.code), r.body.code);
  assert.equal(await count("SELECT COUNT(*)::int c FROM dispatches WHERE courier_id=39"), 0);
  await service.cancel({ actorUserId: 39, courierId: 39, id: pd.id });
  return `troca de pedido no meio da saída → 409 ${r.body.code}; nenhuma saída criada`;
});

await scenario("S3", "Permissões e transições validadas no backend", async () => {
  const adminRoutes = Object.entries(registry).filter(([k]) => k.includes("/api/admin/"));
  const courierRoutes = Object.entries(registry).filter(([k]) => k.includes("/api/courier/pre-departure") || k.includes("/api/courier/routes"));
  assert.ok(adminRoutes.length >= 12 && adminRoutes.every(([, h]) => h.includes(auth) && h.includes(adminOnly)), "toda rota de admin exige adminOnly");
  assert.ok(courierRoutes.every(([, h]) => h.includes(auth) && h.includes(courierOnly)));
  assert.equal(canTransition("DISPATCHED", "AWAITING_CHECK"), false);
  assert.equal(canTransition("CANCELLED", "ROUTE_READY"), false);
  assert.equal(canTransition("CHECKED", "DISPATCHED"), false, "só ROUTE_READY despacha");
  const o = await ifood(3600, at(170, 1000));
  const pd = (await createPd(40, [o])).body.pre_departure;
  await service.cancel({ actorUserId: 40, courierId: 40, id: pd.id });
  const late = await call("POST /api/courier/pre-departures/:id/orders/:orderId/check", { user: courier(40), params: { id: String(pd.id), orderId: String(pd.orders[0].id) }, body: { composition_version: pd.composition_version } });
  assert.equal(late.status, 409); assert.equal(late.body.code, "PRE_DEPARTURE_CLOSED");
  const foreign = await call("POST /api/courier/pre-departures/:id/route", { user: courier(2), params: { id: String(pd.id) } });
  assert.equal(foreign.status, 404);
  return `${adminRoutes.length} rotas de admin com adminOnly, ${courierRoutes.length} de motoboy com courierOnly; transições inválidas recusadas; conferência em pré-saída cancelada → ${late.body.code}; pré-saída de outro motoboy → 404`;
});

await scenario("S4", "Rollback em um toque: desligar a conferência libera os pedidos", async () => {
  await setFlags({ pre_departure: true, route_planner: true, address_correction: true });
  const o = await ifood(3700, at(180, 1200));
  const pd = (await createPd(36, [o])).body.pre_departure;
  const off = await call("PUT /api/admin/pre-departure/settings", { user: admin, body: { flags: { pre_departure: false }, reason: "Rollback durante o pico" } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.settings.pre_departure, false); assert.equal(off.body.settings.route_planner, false, "sequência desliga junto");
  assert.equal((await query("SELECT status,close_reason FROM pre_departures WHERE id=$1", [pd.id])).rows[0].close_reason, "FEATURE_DISABLED");
  const legacy = await call("POST /api/courier/depart", { user: courier(37), body: { order_numbers: [o.number], order_count: 1, platform_selections: selections([o]), client_token: "rollback-1" } });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  const turnOn = await call("PUT /api/admin/pre-departure/settings", { user: admin, body: { flags: { route_planner: true }, reason: "Tentativa sem a conferência" } });
  assert.equal(turnOn.body.code, "ROUTE_PLANNER_REQUIRES_PRE_DEPARTURE");
  return `um PUT desliga conferência e sequência, cancela a pré-saída aberta e libera o pedido; outro motoboy sai direto (HTTP ${legacy.status}); sequência sem conferência é recusada`;
});

const failed = results.filter(r => r.result === "FAIL");
const at40 = results.filter(r => typeof r.id === "number");
console.log(`\n${at40.filter(r => r.result === "PASS").length}/40 cenários obrigatórios PASS; ${results.length - at40.length} verificações extras; ${failed.length} FAIL.`);
const evidenceAt = process.argv.indexOf("--evidence");
if (evidenceAt > 0) fs.writeFileSync(process.argv[evidenceAt + 1], JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
if (failed.length) process.exit(1);
