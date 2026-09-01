import fs from "node:fs";
import assert from "node:assert/strict";
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const checks={
  version:server.includes('const VERSION = "3.4.0";')&&html.includes('Versão 3.4.0'),
  soberCss:html.includes('interface administrativa sóbria')&&html.includes('--admin-red:#e11d2e')&&html.includes('background:#0d1218!important'),
  neutralMetrics:html.includes('metric-neutral')&&html.includes('metric-positive')&&html.includes('metric-attention')&&!html.includes('class="card dashboard-metric-card metric-yellow"'),
  noMetricGlow:html.includes('.dashboard-metric-card:after{display:none!important}'),
  redActiveBar:html.includes('.admin-nav button.active:before')&&html.includes('background:var(--admin-red)'),
  navIcons:html.includes('admin-nav-icon')&&html.includes('admin-nav-ifood')&&html.includes('<span>Dashboard</span>')&&html.includes('<span>Operação</span>')&&html.includes('<span>Gestão</span>')&&html.includes('<span>Sistema</span>'),
  topClean:html.includes('manual-dispatch-top')&&html.includes('bell-btn')&&!html.includes('id="adminName"')&&!html.includes('class="btn outline logout-top"'),
  profileMenu:html.includes('id="adminProfileMenu"')&&html.includes('Minha conta')&&html.includes('Alterar minha senha')&&html.includes('Instalar aplicativo')&&html.includes('onclick="logout()"'),
  accountModal:html.includes('id="adminAccountModal"')&&html.includes('id="adminAccountName"')&&html.includes('id="adminAccountUsername"'),
  statusNoEmoji:html.includes("el.innerHTML=`<i class=\"status-dot\"></i>${state==='online'?'Online'"),
  darkSubnav:html.includes('#adminApp .admin-subnav{background:#0b1015'),
  oldYellowNavOverridden:html.includes('#adminApp .admin-nav button.active{background:#151a20')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"3.4.0",checks},null,2));
