import fs from "node:fs";
import assert from "node:assert/strict";
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const sw=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");
const checks={
  version:server.includes('const VERSION = "2.5.3";')&&html.includes('<title>DespachaMoto 2.5.3</title>'),
  darkAdmin:html.includes('v2.5.3 — Dashboard administrativo no padrão visual KDS'),
  sidebar:html.includes('class="side admin-side"')&&html.includes('class="side-kds-shortcut"'),
  dashboardClock:html.includes('id="dashboardClockTime"')&&html.includes('function renderDashboardClock()'),
  sixMetrics:['mActive','mRoad','mAvailable','mToday','mProgress','mPending'].every(id=>html.includes(`id="${id}"`)),
  livePanel:html.includes('dashboard-live-panel')&&html.includes('id="roadDash"'),
  recentPanel:html.includes('dashboard-recent-panel')&&html.includes('id="recentTable"'),
  emptyRoad:html.includes('dashboard-empty-road')&&html.includes('No momento, não há motoboys em entrega.'),
  footer:html.includes('class="dashboard-footer"')&&html.includes('Versão 2.5.3'),
  wallboardPreserved:html.includes('PEDIDOS EM PREPARO')&&html.includes('id="kdsPreparingList"'),
  cache:sw.includes('despachamoto-v2.5.3-dark-dashboard')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"2.5.3",checks},null,2));
