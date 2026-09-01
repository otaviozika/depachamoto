import fs from "node:fs";
import assert from "node:assert/strict";
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const sw=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");
const checks={
  version:server.includes('const VERSION = "3.5.0";')&&html.includes('<title>DespacheFull 3.5.0</title>'),
  darkAdmin:html.includes('/* v3.5.0 — interface administrativa sóbria */')&&html.includes('#adminApp .admin-nav button.active:before')&&html.includes('#adminApp .dashboard-metric-card:after{display:none!important}'),
  sidebar:html.includes('class="side admin-side"')&&['dashboard','operations','ifood','management','system'].every(g=>html.includes(`data-admin-group="${g}"`))&& !html.includes('data-page="road"'),
  dashboardClock:html.includes('id="dashboardClockTime"')&&html.includes('function renderDashboardClock()'),
  sixMetrics:['mActive','mRoad','mAvailable','mToday','mWaiting','mProgress'].every(id=>html.includes(`id="${id}"`)),
  livePanel:html.includes('dashboard-live-panel')&&html.includes('id="roadDash"'),
  recentPanel:html.includes('dashboard-recent-panel')&&html.includes('id="recentTable"'),
  emptyRoad:html.includes('dashboard-empty-road')&&html.includes('No momento, não há motoboys em entrega ou retorno.'),
  footer:html.includes('class="dashboard-footer"')&&html.includes('Versão 3.5.0'),
  wallboardPreserved:html.includes('PEDIDOS EM PREPARO')&&html.includes('id="kdsPreparingList"'),
  cache:sw.includes('despachefull-v3.5.0-preparation-time')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"3.5.0",checks},null,2));
