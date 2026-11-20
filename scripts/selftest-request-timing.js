// Medição por requisição: conta consultas (promise e callback), mede o tempo,
// registra só as ações rastreadas ou lentas, nunca valores da URL, e não
// altera respostas nem consultas.
import fs from "node:fs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { createRequestTiming, TRACKED_ROUTES, safePath } from "../lib/request-timing.js";

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log("PASS", name); };
let clock = 0;
const timing = (logs, opts = {}) => createRequestTiming({ log: m => logs.push(m), now: () => clock, ...opts });

function fakeClient() {
  return {
    calls: 0,
    query(...args) {
      this.calls++;
      const cb = typeof args.at(-1) === "function" ? args.at(-1) : null;
      clock += 180;
      if (cb) { setImmediate(() => cb(null, { rows: [] })); return undefined; }
      return Promise.resolve({ rows: [{ ok: true }] });
    }
  };
}
function fakeReqRes({ method = "POST", path = "/api/courier/depart", url = "/api/courier/depart", status = 201 } = {}) {
  const req = { method, baseUrl: "", originalUrl: url, route: { path } };
  const res = new EventEmitter(); res.statusCode = status;
  return { req, res };
}

await test("conta consultas por promise e por callback, só dentro da requisição", async () => {
  const logs = [], t = timing(logs), client = fakeClient();
  t.instrumentClient(client); t.instrumentClient(client);
  await client.query("fora de requisição");
  const { req, res } = fakeReqRes({ url: "/api/courier/depart?pedido=123" });
  clock = 1000;
  await new Promise(done => t.middleware(req, res, async () => {
    await client.query("SELECT 1");
    await new Promise(r => client.query("SELECT 2", [], () => r()));
    const { rows } = await client.query("SELECT 3");
    assert.equal(rows[0].ok, true, "resultado da consulta intacto");
    done();
  }));
  res.emit("finish");
  assert.equal(logs.length, 1);
  const data = JSON.parse(logs[0].replace(/^REQUEST_TIMING /, ""));
  assert.deepEqual({ route: data.route, status: data.status, db_queries: data.db_queries }, { route: "POST /api/courier/depart", status: 201, db_queries: 3 });
  assert.ok(data.total_ms >= 540 && data.db_ms >= 0);
  assert.doesNotMatch(logs[0], /pedido|123/, "nunca registra valores da URL");
  assert.equal(client.calls, 4, "todas as consultas foram executadas, sem duplicar");
});

await test("rota comum e rápida não gera log; rota /api lenta gera REQUEST_SLOW", async () => {
  const logs = [], t = timing(logs, { slowMs: 1500 });
  let r = fakeReqRes({ method: "GET", path: "/api/admin/payments", url: "/api/admin/payments", status: 200 });
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 300; r.res.emit("finish");
  assert.equal(logs.length, 0);
  r = fakeReqRes({ method: "GET", path: "/api/admin/payments", url: "/api/admin/payments", status: 200 });
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 2000; r.res.emit("finish");
  assert.match(logs[0], /^REQUEST_SLOW \{"route":"GET \/api\/admin\/payments","status":200,"total_ms":2000/);
  r = fakeReqRes({ method: "GET", path: "/{*splat}", url: "/index.html", status: 200 });
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 5000; r.res.emit("finish");
  assert.equal(logs.length, 1, "páginas fora de /api não entram");
});

await test("resume retoma o contexto perdido por callbacks", async () => {
  const logs = [], t = timing(logs), client = fakeClient(); t.instrumentClient(client);
  const { req, res } = fakeReqRes();
  t.middleware(req, res, () => {});
  await new Promise(done => setImmediate(() => t.resume(req, res, async () => { await client.query("SELECT 1"); done(); })));
  res.emit("finish");
  assert.match(logs[0], /"db_queries":1/);
});

await test("ações rastreadas são as do motoboy que mais pesam", async () => {
  for (const key of ["POST /api/courier/depart", "POST /api/courier/route/orders", "POST /api/courier/dispatches/:id/arrive",
    "POST /api/courier/ifood/orders/:orderId/verify-delivery", "GET /api/courier/dashboard"]) assert.ok(TRACKED_ROUTES.has(key), key);
});

await test("toda resposta 5xx gera REQUEST_ERROR com rota e código, sem valores da URL", async () => {
  const logs = [], t = timing(logs);
  let r = fakeReqRes({ method: "GET", path: "/api/admin/payments", url: "/api/admin/payments?dia=2026-11-18", status: 500 });
  r.res.locals = { errorCode: "TypeError" };
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 40; r.res.emit("finish");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^REQUEST_ERROR \{"route":"GET \/api\/admin\/payments","status":500,"code":"TypeError","total_ms":40,"db_queries":0\}$/);
  r = fakeReqRes({ method: "GET", url: "/vendor/qrcode.min.js?v=1", status: 503 }); r.req.route = undefined;
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 5; r.res.emit("finish");
  assert.match(logs[1], /^REQUEST_ERROR \{"route":"GET \/vendor\/qrcode.min.js","status":503,"code":null/);
  r = fakeReqRes({ method: "POST", status: 500 });
  clock = 0; t.middleware(r.req, r.res, () => {}); clock = 9; r.res.emit("finish");
  assert.ok(logs.some(l => l.startsWith("REQUEST_ERROR")) && logs.some(l => l.startsWith("REQUEST_TIMING")), "rota rastreada: as duas linhas");
  r = fakeReqRes({ status: 409 }); t.middleware(r.req, r.res, () => {}); r.res.emit("finish");
  assert.equal(logs.filter(l => l.startsWith("REQUEST_ERROR")).length, 3, "4xx não gera REQUEST_ERROR");
  assert.equal(safePath("/oldman/abc123/x?token=segredo"), "/oldman/:x/x");
  assert.equal(safePath("/api/attendance/qr/eyJhbGciOiJIUzI1NiJ9tokenlongo"), "/api/attendance/qr/:x");
  assert.equal(safePath("/a%20b/ok"), "/:x/ok");
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
await test("servidor: medição antes da sessão, retomada depois dela, conexões instrumentadas", async () => {
  const iMid = server.indexOf("app.use(requestTiming.middleware);");
  const iSession = server.indexOf("app.use(sessionMiddleware);");
  const iResume = server.indexOf("app.use(requestTiming.resume);");
  assert.ok(iMid > 0 && iMid < iSession && iResume > iSession, "ordem: medição → sessão → retomada");
  assert.ok(iResume < server.indexOf('app.post("/api/login"'), "antes de todas as rotas");
  assert.match(server, /pool\.on\("connect", client => requestTiming\.instrumentClient\(client\)\);/);
  assert.equal((server.match(/res\.locals\.errorCode = String\(/g) || []).length, 2, "código do erro guardado no tratador final e no de serviço");
});

console.log(JSON.stringify({ result: "PASS", feature: "request_timing", cases: count }));
