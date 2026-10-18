// Regra LONGE ponta a ponta em PostgreSQL isolado (PGlite), com as funções e o SQL
// de produção: zona gerada uma vez, prévia por mês, teste sem mexer no pagamento,
// ativação só após o primeiro fim de semana, pedidos antigos e turnos conferidos/pagos
// intactos, correção manual com motivo no histórico, card do motoboy, CSV e planilha.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { createLongeService } from "../lib/longe-service.js";
import { LONGE_STORE, destinationPoint, haversineMeters, longeUnitAmount, modeAt } from "../lib/longe-zone.js";
import { calculateShiftPayment, defaultShiftPaymentRule } from "../lib/payment-shifts.js";
import { normalizeShiftCode, shiftLabel } from "../lib/operational-shift.js";
import { paymentDayTotalFormula, paymentRowsToDailySheetData } from "../lib/google-sheets.js";

const original = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
// Aplica a transformação real do prestart (contagem LONGE manual) numa cópia.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "longe-"));
fs.mkdirSync(path.join(tmp, "scripts"));
fs.writeFileSync(path.join(tmp, "server.js"), original);
fs.copyFileSync(new URL("./apply-payment-longe-backend.js", import.meta.url), path.join(tmp, "scripts", "apply-payment-longe-backend.js"));
execFileSync(process.execPath, [path.join(tmp, "scripts", "apply-payment-longe-backend.js")], { stdio: "ignore" });
const source = fs.readFileSync(path.join(tmp, "server.js"), "utf8");
fs.rmSync(tmp, { recursive: true, force: true });
assert.ok(source.includes("payment-longe-backend-v1"), "patch do prestart aplicado");

const db = new PGlite();
await db.exec(source.split("await pool.query(`")[1].split("`);")[0]);
let tail = Promise.resolve();
const query = async (sql, args = []) => {
  if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
  const result = await db.query(sql, args);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
const pool = { query, connect: async () => { const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous; return { query, release }; } };

let clock = new Date("2026-10-19T13:00:00Z"); // segunda-feira 10:00 (Brasília)
const events = [];
const handlers = {};
const context = vm.createContext({
  pool, console, Date, Math, JSON, Number, String, Set, Map, Promise, Object, Array, Intl, Error, process, setImmediate,
  calculateShiftPayment, defaultShiftPaymentRule, normalizeShiftCode, shiftLabel, longeUnitAmount,
  normalizeIfoodLifecycleStatus: value => String(value || "").toUpperCase(),
  WORK_SHIFT_CUTOVER_DATE: "2026-09-12",
  getSPDate: async () => clock.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }),
  audit: async (userId, action, entity, entityId, details) => query("INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)", [userId, action, entity, entityId, JSON.stringify(details)]),
  emitRealtime: (event, payload) => events.push({ event, payload }),
  auth() {}, adminOnly() {}, asyncRoute: fn => fn,
  app: { put: (route, ...fns) => { handlers["PUT " + route] = fns.at(-1); }, get: (route, ...fns) => { handlers["GET " + route] = fns.at(-1); } }
});
function include(start, end) {
  const at = source.indexOf(start), to = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, start);
  vm.runInContext(source.slice(at, to), context);
}
include("function parseJsonPayload(", "function normalizeDeliveryCode(");
include("function validDate(v)", 'app.get("/api/public/config"');
include("async function getCourierIfoodDeliveries(", "async function getCourierAnotaAiDeliveries(");
include("const COURIER_LONGE_COLUMNS=", "async function acknowledgeIfoodEvents(");
include("function longeDestinationFromOrder(", "const longeRule = createLongeService");
include('app.put("/api/admin/payments/:date/:courierId"', 'app.get("/api/admin/payments.csv"');
// Funções de exibição do card que dependem só do payload.
for (const name of ["canonicalIfoodOrderStatus", "deliveryConfirmationLabel", "courierDeliveryUiState"]) {
  const at = source.indexOf(`function ${name}(`);
  const next = source.indexOf("\nfunction ", at + 10), nextAsync = source.indexOf("\nasync function ", at + 10);
  vm.runInContext(source.slice(at, Math.min(...[next, nextAsync].filter(x => x > 0))), context);
}

const ratio = 1.3; // rota ≈ 1,3 × linha reta, nos dois lados (zona e prévia)
let googleCalls = 0;
const fakeRoutes = () => {
  let elements = 0;
  return {
    get elements() { return elements; },
    async distancesFrom(origin, points) { googleCalls++; elements += points.length; return points.map(p => haversineMeters(origin, p) * ratio); },
    async resolveAddress() { elements++; return { ...LONGE_STORE.approx }; }
  };
};
const service = createLongeService({ pool, describeDestination: context.longeDestinationFromOrder, emitRealtime: context.emitRealtime, routesClientFactory: fakeRoutes, now: () => clock, env: { GOOGLE_ROUTES_API_KEY: "fake" }, logger: { error() {} } });

let tests = 0;
const plain = value => JSON.parse(JSON.stringify(value)); // objetos do contexto vm
async function test(name, fn) { await fn(); tests++; console.log("PASS " + name); }
await query("INSERT INTO users(id,name,username,password_hash,role,pix_key,pix_type,pix_holder_name,pix_status) VALUES(1,'Admin','admin','x','admin',NULL,NULL,NULL,'NONE'),(2,'Ana','ana','x','courier','k','CPF','Ana','VERIFIED'),(3,'Bia','bia','x','courier','k','CPF','Bia','VERIFIED')");

const store = LONGE_STORE.approx;
const at = (meters, bearing = 30) => destinationPoint(store, bearing, meters);
let seq = 0;
async function delivery({ courier = 2, departedAt, date, shift = "LUNCH", point, neighborhood = "Barcelona", city = "São Caetano do Sul", platform = "ifood" }) {
  const n = ++seq;
  const d = (await query("INSERT INTO dispatches(dispatch_code,order_number,courier_id,departed_at,status,operational_date,shift_code) VALUES($1,$2,$3,$4,'RELEASED',$5,$6) RETURNING id", ["T" + n, "#" + n, courier, departedAt, date, shift])).rows[0];
  const o = (await query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,$3) RETURNING id", [d.id, "#" + n, platform])).rows[0];
  if (platform === "ifood") {
    const payload = { delivery: { deliveryAddress: { streetName: "Rua Teste", streetNumber: String(n), neighborhood, city, state: "SP", coordinates: point ? { latitude: point.latitude, longitude: point.longitude } : undefined } } };
    await query("INSERT INTO ifood_orders(order_id,display_id,status,order_type,delivered_by,payload) VALUES($1,$2,'CONCLUDED','DELIVERY','MERCHANT',$3)", ["if-" + n, String(n), JSON.stringify(payload)]);
    await query("INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number) VALUES($1,$2,$3)", ["if-" + n, d.id, "#" + n]);
  }
  return { dispatchId: d.id, orderItemId: o.id, n };
}
const rows = async (date, shift = "LUNCH") => (await context.getPaymentRows(date, shift)).rows;
const rowOf = async (date, courier = 2, shift = "LUNCH") => (await rows(date, shift)).find(r => Number(r.courier_id) === courier);
const put = async (date, courierId, body) => {
  let status = 200, payload;
  await handlers["PUT /api/admin/payments/:date/:courierId"]({ params: { date, courierId: String(courierId) }, query: {}, body, session: { user: { id: 1 } } },
    { status(code) { status = code; return this; }, json(data) { payload = data; return this; } });
  return { status, payload };
};

// Histórico anterior à publicação (setembro e outubro).
await delivery({ departedAt: "2026-09-15T15:00:00Z", date: "2026-09-15", point: at(3000), neighborhood: "Barcelona" });
await delivery({ departedAt: "2026-09-15T15:10:00Z", date: "2026-09-15", point: at(5000, 200), neighborhood: "Ipiranga", city: "São Paulo" });
await delivery({ departedAt: "2026-09-15T15:20:00Z", date: "2026-09-15", point: at(5300, 200), neighborhood: "Ipiranga", city: "São Paulo" });
await delivery({ departedAt: "2026-10-10T15:00:00Z", date: "2026-10-10", point: at(7000, 120), neighborhood: "Sacomã", city: "São Paulo" });
const legacyOld = await delivery({ departedAt: "2026-10-17T15:00:00Z", date: "2026-10-17", point: at(7000, 120), neighborhood: "Sacomã", city: "São Paulo" });
await delivery({ departedAt: "2026-10-17T15:05:00Z", date: "2026-10-17", platform: "manual" });

await test("sem chave do Google, nada é calculado", async () => {
  const noKey = createLongeService({ pool, describeDestination: context.longeDestinationFromOrder, env: {}, now: () => clock });
  await assert.rejects(noKey.startJob({ kind: "PREVIEW", actorUserId: 1 }), e => e.code === "GOOGLE_ROUTES_NOT_CONFIGURED" && e.status === 503);
});

await test("prévia: LONGE por mês e bairros na borda, agrupando endereços próximos", async () => {
  const { job, done } = await service.startJob({ kind: "PREVIEW", actorUserId: 1 });
  await done;
  const saved = await service.getJob(job.id);
  assert.equal(saved.status, "DONE", saved.error);
  const months = Object.fromEntries(saved.result.months.map(m => [m.month, m]));
  assert.deepEqual([months["2026-09"].longe, months["2026-09"].normal], [1, 2]);
  assert.deepEqual([months["2026-10"].longe, months["2026-10"].normal, months["2026-10"].deliveries], [2, 0, 3]);
  assert.equal(saved.result.border_neighborhoods[0].neighborhood, "Ipiranga");
  assert.equal(saved.result.clusters, 4, "dois pedidos no mesmo endereço = 1 consulta");
  const elements = saved.result.google_elements;
  const second = await service.startJob({ kind: "PREVIEW", actorUserId: 1 });
  await second.done;
  assert.equal((await service.getJob(second.job.id)).result.google_elements, 1, "segunda prévia usa o cache (só localiza a loja)");
  assert.ok(elements > 1);
});

await test("zona de 6,7 km gerada uma única vez e salva no app", async () => {
  await assert.rejects(service.setMode({ actorUserId: 1, mode: "TEST", reason: "antes da zona" }), e => e.code === "LONGE_ZONE_REQUIRED");
  const { done } = await service.startJob({ kind: "ZONE", actorUserId: 1 });
  await done;
  const zone = await service.getZone();
  assert.equal(zone.polygon.length, 96);
  assert.equal(zone.method.routingPreference, "TRAFFIC_UNAWARE");
  await assert.rejects(service.startJob({ kind: "ZONE", actorUserId: 1 }), e => e.code === "LONGE_ZONE_EXISTS");
  await assert.rejects(query("INSERT INTO longe_zones(radius_meters,store_address,store_latitude,store_longitude,polygon) VALUES(1,'x',1,1,'[]')"), /longe_zones_single_idx/);
  assert.equal((await query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='LONGE_ZONE_GENERATED'")).rows[0].n, 1);
  const check = await service.startJob({ kind: "PREVIEW", actorUserId: 1 });
  await check.done;
  assert.equal((await service.getJob(check.job.id)).result.polygon_check.agreement_pct, 100, "polígono concorda com a distância direta");
});

let testStart;
await test("teste: classifica só saídas a partir da publicação, sem mexer no pagamento", async () => {
  const before = await rowOf("2026-10-17");
  testStart = clock;
  await service.setMode({ actorUserId: 1, mode: "TEST", reason: "Primeiro fim de semana em teste" });
  await assert.rejects(service.setMode({ actorUserId: 1, mode: "ACTIVE", reason: "cedo demais" }), e => e.code === "LONGE_TEST_WEEKEND_PENDING");
  clock = new Date("2026-10-24T16:00:00Z"); // sábado almoço
  const far = await delivery({ departedAt: "2026-10-24T15:30:00Z", date: "2026-10-24", point: at(7000, 300) });
  const near = await delivery({ departedAt: "2026-10-24T15:40:00Z", date: "2026-10-24", point: at(2000, 300) });
  const manual = await delivery({ departedAt: "2026-10-24T15:50:00Z", date: "2026-10-24", platform: "manual" });
  await service.classifyPending();
  const classified = (await query("SELECT dispatch_order_id,rule_mode,auto_status FROM dispatch_order_longe ORDER BY dispatch_order_id")).rows;
  assert.deepEqual(classified.map(r => [Number(r.dispatch_order_id), r.rule_mode, r.auto_status]),
    [[far.orderItemId, "TEST", "LONGE"], [near.orderItemId, "TEST", "NORMAL"], [manual.orderItemId, "TEST", "NO_LOCATION"]]);
  assert.equal((await query("SELECT 1 FROM dispatch_order_longe WHERE dispatch_order_id=$1", [legacyOld.orderItemId])).rowCount, 0, "pedido anterior à publicação não entra");
  const row = await rowOf("2026-10-24");
  assert.equal(row.delivery_count, 3);
  assert.equal(row.longe_count, 0, "em teste a longa não é paga");
  assert.equal(row.longe_test_count, 1);
  assert.equal(row.longe_unknown_count, 1);
  assert.equal(row.total_amount, 3 * 6 + 55);
  assert.deepEqual(await rowOf("2026-10-17"), before, "turno anterior idêntico");
  const card = (await context.getCourierIfoodDeliveries(2)).completed.find(x => x.order_id === "if-" + far.n);
  assert.deepEqual(plain(card.longe), { status: "LONGE", mode: "TEST", amount: 12, corrected: false }, "card mostra LONGE em teste");
});

await test("ativação liberada só depois do primeiro fim de semana completo", async () => {
  clock = new Date("2026-10-26T04:59:00Z");
  await assert.rejects(service.setMode({ actorUserId: 1, mode: "ACTIVE", reason: "domingo à noite" }), e => e.code === "LONGE_TEST_WEEKEND_PENDING");
  clock = new Date("2026-10-26T13:00:00Z");
  await service.setMode({ actorUserId: 1, mode: "ACTIVE", reason: "Teste do fim de semana aprovado" });
  const history = await service.getModeHistory();
  assert.equal(modeAt(history, "2026-10-24T15:30:00Z"), "TEST");
  assert.equal(modeAt(history, clock), "ACTIVE");
  assert.equal((await query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='LONGE_MODE_CHANGED'")).rows[0].n, 2);
});

let farActive, nearActive;
await test("ativa: LONGE = 2x o valor por entrega e só para saídas depois da ativação", async () => {
  clock = new Date("2026-10-27T15:30:00Z");
  farActive = await delivery({ departedAt: "2026-10-27T15:00:00Z", date: "2026-10-27", point: at(6000, 90) });
  nearActive = await delivery({ departedAt: "2026-10-27T15:05:00Z", date: "2026-10-27", point: at(4000, 90) });
  await delivery({ courier: 3, departedAt: "2026-10-26T15:00:00Z", date: "2026-10-26", point: at(6500, 10) });
  await service.classifyPending();
  const row = await rowOf("2026-10-27");
  assert.equal(row.normal_count, 1); assert.equal(row.longe_count, 1);
  assert.equal(row.longe_unit_amount, 12);
  assert.equal(row.total_amount, 6 + 12 + 45, "1 normal + 1 LONGE + base almoço seg-qui");
  const testWeekend = await rowOf("2026-10-24");
  assert.equal(testWeekend.longe_count, 0, "pedidos do teste continuam sem pagamento LONGE");
  const monday = await rowOf("2026-10-26", 3);
  assert.equal(monday.longe_count, 1, "saída após a ativação no mesmo dia");
  const card = (await context.getCourierIfoodDeliveries(2)).completed.find(x => x.order_id === "if-" + farActive.n);
  assert.deepEqual(plain(card.longe), { status: "LONGE", mode: "ACTIVE", amount: 12, corrected: false });
  const normalCard = (await context.getCourierIfoodDeliveries(2)).completed.find(x => x.order_id === "if-" + nearActive.n);
  assert.equal(normalCard.longe.status, "NORMAL");
  assert.ok(events.some(e => e.event === "delivery:changed" && e.payload.courier_ids?.includes(2)));
});

await test("contagem LONGE manual antiga não soma de novo num turno com a regra ativa", async () => {
  const blocked = await put("2026-10-27", 2, { shift_code: "LUNCH", longe_count: 1, status: "OPEN" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.payload.code, "LONGE_MANUAL_COUNT_BLOCKED");
  const allowed = await put("2026-10-27", 2, { shift_code: "LUNCH", longe_count: 0, tip_amount: 5, status: "OPEN" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.payload.payment.total_amount, 6 + 12 + 45 + 5);
  const testShift = await put("2026-10-24", 2, { shift_code: "LUNCH", longe_count: 1, status: "OPEN" });
  assert.equal(testShift.status, 200, "no fim de semana de teste o pagamento segue como hoje");
  assert.equal(testShift.payload.payment.total_amount, 3 * 6 + 55 + 6);
});

await test("correção manual com motivo no histórico; turno conferido/pago não muda", async () => {
  await assert.rejects(service.correctOrder({ actorUserId: 1, orderItemId: nearActive.orderItemId, longe: true, reason: "" }), e => e.code === "LONGE_REASON_REQUIRED");
  await assert.rejects(service.correctOrder({ actorUserId: 1, orderItemId: legacyOld.orderItemId, longe: true, reason: "pedido antigo" }), e => e.code === "LONGE_ORDER_OUT_OF_RULE");
  const reviewed = await put("2026-10-27", 2, { shift_code: "LUNCH", longe_count: 0, tip_amount: 5, status: "REVIEWED" });
  assert.equal(reviewed.payload.payment.longe_count, 1);
  const frozen = (await query("SELECT longe_count_snapshot,longe_unit_snapshot,total_snapshot FROM courier_payments WHERE payment_date='2026-10-27' AND courier_id=2")).rows[0];
  assert.deepEqual([frozen.longe_count_snapshot, Number(frozen.longe_unit_snapshot), Number(frozen.total_snapshot)], [1, 12, 68]);
  await assert.rejects(service.correctOrder({ actorUserId: 1, orderItemId: nearActive.orderItemId, longe: true, reason: "Cliente em condomínio afastado" }), e => e.code === "LONGE_PAYMENT_LOCKED");
  await query("UPDATE dispatch_order_longe SET manual_longe=TRUE WHERE dispatch_order_id=$1", [nearActive.orderItemId]);
  const still = await rowOf("2026-10-27");
  assert.equal(still.longe_count, 1, "turno conferido mantém as longas do fechamento");
  assert.equal(still.total_amount, 68);
  await query("UPDATE dispatch_order_longe SET manual_longe=NULL WHERE dispatch_order_id=$1", [nearActive.orderItemId]);
  const reopened = await put("2026-10-27", 2, { shift_code: "LUNCH", longe_count: 0, tip_amount: 5, status: "OPEN", confirm_reopen_reviewed: true });
  assert.equal(reopened.status, 200);
  const fixed = await service.correctOrder({ actorUserId: 1, orderItemId: nearActive.orderItemId, longe: true, reason: "Cliente em condomínio afastado" });
  assert.equal(fixed.longe, true);
  const after = await rowOf("2026-10-27");
  assert.deepEqual([after.normal_count, after.longe_count, after.total_amount], [0, 2, 12 + 12 + 45 + 5]);
  const auditRow = (await query("SELECT details FROM audit_logs WHERE action='LONGE_ORDER_CORRECTED' ORDER BY id DESC LIMIT 1")).rows[0].details;
  assert.equal(auditRow.reason, "Cliente em condomínio afastado");
  assert.deepEqual([auditRow.from, auditRow.to, auditRow.auto_status], ["NORMAL", "LONGE", "NORMAL"]);
  const backToAuto = await service.correctOrder({ actorUserId: 1, orderItemId: nearActive.orderItemId, longe: null, reason: "Conferido no mapa: dentro da zona" });
  assert.equal(backToAuto.longe, false);
  const orders = await service.listOrders({ date: "2026-10-27", shiftCode: "LUNCH", courierId: 2 });
  assert.equal(orders.length, 2);
  assert.equal(orders.find(o => Number(o.order_item_id) === nearActive.orderItemId).manual_reason, "Conferido no mapa: dentro da zona");
});

await test("pedido pago antes da ativação continua igual depois dela", async () => {
  const paidBefore = await put("2026-10-17", 2, { shift_code: "LUNCH", status: "PAID", payment_method: "Dinheiro" });
  assert.equal(paidBefore.payload.payment.longe_count, 0);
  const snapshot = (await rowOf("2026-10-17")).total_amount;
  await service.classifyPending();
  assert.equal((await rowOf("2026-10-17")).total_amount, snapshot);
});

await test("planilha diária e CSV separam Normais, Longas e Valor longa", async () => {
  const data = paymentRowsToDailySheetData(await rows("2026-10-27"));
  assert.deepEqual(plain(data.longe), [[1, 1, 12]]);
  assert.equal(data.hasLonge, true);
  assert.equal(paymentDayTotalFormula(4), "=N(E4)*N(P4)/2+N(O4)*N(P4)/2+N(F4)+N(G4)-N(H4)");
  const [e, o, p, f, g, h] = [2, 1, 12, 45, 5, 0];
  assert.equal(e * p / 2 + o * p / 2 + f + g - h, (await rowOf("2026-10-27")).total_amount, "fórmula da planilha = total do app");
  assert.ok(source.includes("'Nº Entregas','Normais','Longas','Valor longa'"), "colunas no CSV");
});

console.log(`PASS: ${tests} cenários da regra LONGE com SQL de produção.`);
