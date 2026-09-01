import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const checks={
  fiveMainGroups:['dashboard','operations','ifood','management','system'].every(g=>html.includes(`data-admin-group="${g}"`)),
  noOldSidebarItems:!html.includes('data-page="road"')&&!html.includes('<span>Quem está na rua</span>')&&!html.includes('<span>Pedidos iFood</span>'),
  operationsTabs:["['operations','Agora']","['attendance','Presença']","['wallboard','Telão']","['history','Histórico']","['conflicts','Conflitos']"].every(x=>html.includes(x)),
  managementTabs:["['management','Desempenho']","['report','Relatórios']","['payments','Financeiro']","['couriers','Motoboys']"].every(x=>html.includes(x)),
  systemTabs:["['alerts','Alertas']","['notifications','Notificações']","['security','Segurança']","['audit','Auditoria']"].every(x=>html.includes(x)),
  plainMainLabels:['Dashboard','Operação','iFood','Gestão','Sistema'].every(label=>html.includes(`<span>${label}</span>`)),
  subnav:html.includes('id="adminSubnav"')&&html.includes('function renderAdminSubnav')&&html.includes('async function activateAdminPage'),
  historyShortcut:html.includes("onclick=\"activateAdminPage('history')\""),
  mobileConsolidated:html.includes('class="mobile-nav admin-mobile-nav"')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`FAIL: ${name}`);
console.log(JSON.stringify({result:'PASS',version:'3.3.0',checks},null,2));
