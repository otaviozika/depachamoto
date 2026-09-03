import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');

const courierDepart = server.match(/app\.post\("\/api\/courier\/depart"[\s\S]*?\n\}\)\);/)?.[0] || '';
const adminManual = server.match(/app\.post\("\/api\/admin\/dispatches\/manual"[\s\S]*?\n\}\)\);/)?.[0] || '';
const uiDepart = ui.match(/async function depart\(e\)\{[\s\S]*?\n\}/)?.[0] || '';

const checks = {
  version_290: /const VERSION = "3\.5\.6"/.test(server),
  courier_non_ifood_backend_block: /COURIER_NON_IFOOD_ORDER_BLOCKED/.test(courierDepart),
  courier_requires_ifood_code: /IFOOD_ORDER_REQUIRED/.test(courierDepart),
  courier_all_orders_must_match: /ifoodInspection\.accepted\.length !== orders\.length/.test(courierDepart),
  courier_offline_backend_block: /COURIER_OFFLINE_DEPARTURE_BLOCKED/.test(courierDepart) && /IFOOD_ONLINE_VALIDATION_REQUIRED/.test(courierDepart),
  courier_lookup_not_manual: /found: false,[\s\S]{0,120}valid: false,[\s\S]{0,120}manual: false,[\s\S]{0,120}IFOOD_ORDER_REQUIRED/.test(server),
  courier_ui_requires_validation: /allCourierOrdersIfoodValidated/.test(ui) && /Valide os pedidos iFood/.test(ui),
  courier_ui_manual_block_copy: /Pedido manual é exclusivo do Admin/.test(ui),
  courier_ui_no_new_offline_queue: !/async function depart\(e\)\{[\s\S]*?enqueueDeparture\(orders\)[\s\S]*?\n\}/.test(ui),
  courier_ui_offline_block: /Conexão obrigatória: o pedido precisa ser validado no iFood/.test(uiDepart),
  admin_manual_still_admin_only: /auth, adminOnly/.test(adminManual),
  admin_manual_still_allows_non_ifood: /inspectIfoodOrdersForDeparture\(orders\)/.test(adminManual) && !/accepted\.length !== orders\.length/.test(adminManual),
  admin_manual_source: /source: "ADMIN"/.test(adminManual),
  pwa_cache_290: /despachefull-v3\.5\.6-/.test(sw),
  only_admin_courier: !/role=['"]operator['"]|role IN \([^)]*operator/i.test(server)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', version: '3.5.6', checks }, null, 2));
