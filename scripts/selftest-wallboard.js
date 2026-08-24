import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const checks = {
  version: server.includes('const VERSION = "2.5.2";') && html.includes('<title>DespachaMoto 2.5.2</title>'),
  endpoint: server.includes('app.get("/api/admin/wallboard"'),
  saoPauloDay: server.includes("America/Sao_Paulo"),
  confirmationJoin: server.includes("LEFT JOIN ifood_delivery_confirmations dc"),
  verifiedMovesToConfirmed: server.includes("IN ('VERIFIED','CONCLUDED')"),
  concludedMovesToConfirmed: server.includes("IN ('CONCLUDED','DELIVERED')"),
  roadStage: server.includes("THEN 'ON_ROAD'"),
  receivedGoesPreparing: server.includes("ELSE 'PREPARING'"),
  cancelledLeavesKds: server.includes("operational_status !== 'CANCELLED'"),
  threeColumns: html.includes('PEDIDOS EM PREPARO') && html.includes('PEDIDOS NA RUA') && html.includes('PEDIDOS CONFIRMADOS'),
  kdsLists: html.includes('id="kdsPreparingList"') && html.includes('id="kdsRoadList"') && html.includes('id="kdsConfirmedList"'),
  countsInHeaders: html.includes('id="kdsPreparingCount"') && html.includes('id="kdsRoadCount"') && html.includes('id="kdsConfirmedCount"'),
  independentScroll: html.includes('.kds-list{overflow-y:auto'),
  oldestPreparingFirst: html.includes("kdsSortTime(a,'PREPARING')-kdsSortTime(b,'PREPARING')"),
  newestConfirmedFirst: html.includes("kdsSortTime(b,'CONFIRMED')-kdsSortTime(a,'CONFIRMED')"),
  realtimeIfood: html.includes("$('wallboard')?.classList.contains('active'))loadWallboard()"),
  periodicRefresh: html.includes('loadWallboard()},15000'),
  clock: html.includes('id="kdsClockTime"') && html.includes('renderKdsClock()'),
  fullscreen: html.includes('#wallboard:fullscreen'),
  cacheBumped: sw.includes('despachamoto-v2.5.2-kds-ifood')
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", version: "2.5.2", checks }, null, 2));
