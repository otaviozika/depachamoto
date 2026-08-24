import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const checks = {
  version: server.includes('const VERSION = "2.5.1";') && html.includes('<title>DespachaMoto 2.5.1</title>'),
  endpoint: server.includes('app.get("/api/admin/wallboard"'),
  preparingMetric: server.includes('AS preparing'),
  onRoadMetric: server.includes('AS on_road'),
  confirmedMetric: server.includes('AS confirmed_today'),
  todayScope: server.includes("AT TIME ZONE 'America/Sao_Paulo'"),
  allTodayOrders: server.includes("ORDER BY COALESCE(o.last_event_at,o.order_created_at,o.updated_at) DESC"),
  threeCards: html.includes('PEDIDOS</div>') && html.includes('PEDIDOS NA RUA') && html.includes('PEDIDOS CONFIRMADOS'),
  cleanFeed: html.includes('id="wallIfoodOrders"') && html.includes('Pedidos iFood de hoje'),
  dedicatedLoader: html.includes("api('/api/admin/wallboard')"),
  ifoodRealtime: html.includes("$('wallboard')?.classList.contains('active'))loadWallboard()"),
  periodicRefresh: html.includes('loadWallboard()},15000'),
  cacheBumped: sw.includes('despachamoto-v2.5.1-wallboard-ifood')
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", version: "2.5.1", checks }, null, 2));
