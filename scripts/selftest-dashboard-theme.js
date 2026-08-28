import fs from "node:fs";
import assert from "node:assert/strict";
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const sw=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");
const checks={
  version:server.includes('const VERSION = "2.8.0";')&&html.includes('<title>DespacheFull 2.8.0</title>'),
  darkAdmin:html.includes('#adminApp .admin-side{width:240px;background:#05070a')&&html.includes('#adminApp .dashboard-metric-card'),
  sidebar:html.includes('class="side admin-side"')&&html.includes('class="side-kds-shortcut"'),
  dashboardClock:html.includes('id="dashboardClockTime"')&&html.includes('function renderDashboardClock()'),
  sixMetrics:['mActive','mRoad','mAvailable','mToday','mProgress','mPending'].every(id=>html.includes(`id="${id}"`)),
  livePanel:html.includes('dashboard-live-panel')&&html.includes('id="roadDash"'),
  recentPanel:html.includes('dashboard-recent-panel')&&html.includes('id="recentTable"'),
  emptyRoad:html.includes('dashboard-empty-road')&&html.includes('No momento, não há motoboys em entrega ou retorno.'),
  footer:html.includes('class="dashboard-footer"')&&html.includes('Versão 2.8.0'),
  wallboardPreserved:html.includes('PEDIDOS EM PREPARO')&&html.includes('id="kdsPreparingList"'),
  cache:sw.includes('despachefull-v2.8.0-checkin-required')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"2.8.0",checks},null,2));
