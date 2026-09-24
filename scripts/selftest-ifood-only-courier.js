import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');

const courierDepart = server.match(/app\.post\("\/api\/courier\/depart"[\s\S]*?\n\}\)\);/)?.[0] || '';
const adminManual = server.match(/app\.post\("\/api\/admin\/dispatches\/manual"[\s\S]*?\n\}\)\);/)?.[0] || '';
const uiDepart = ui.match(/async function depart\(e\)\{[\s\S]*?\n\}/)?.[0] || '';

const checks = {
  version: /const VERSION = "3\\.7\\.0"/.test(server),
  courier_online_required: /COURIER_OFFLINE_DEPARTURE_BLOCKED/.test(courierDepart) && /IFOOD_ONLINE_VALIDATION_REQUIRED/.test(courierDepart),
  courier_requires_external_platform: /resolveCourierOrderPlatforms\(orders, req\.body\)/.test(courierDepart) &&
    /ifoodLinks\.length \+ anotaAiLinks\.length !== orders\.length/.test(courierDepart),
  mandatory_choice_if_number_collides: /platformResolution\.ambiguities\.length/.test(courierDepart) && /ORDER_PLATFORM_REQUIRED/.test(courierDepart),
  blocks_invalid_platform: /platformResolution\.errors\.length/.test(courierDepart) && /COURIER_PLATFORM_ORDER_BLOCKED/.test(courierDepart),
  courier_ui_requires_platform_validation: ui.includes('allCourierOrdersPlatformValidated()') && ui.includes('escolha iFood ou Anota AI'),
  courier_ui_cannot_dispatch_offline: ui.includes('Conexão obrigatória: o pedido precisa ser validado no iFood ou Anota AI'),
  admin_manual_still_admin_only: /auth, adminOnly/.test(adminManual),
  admin_manual_still_allows_manual: /inspectIfoodOrdersForDeparture\(orders\)/.test(adminManual) && !/ifoodInspection\.accepted\.length !== orders\.length/.test(adminManual),
  admin_manual_requires_no_store_arrival: /PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE/.test(adminManual) && !/RETURN_CHECKIN_REQUIRED/.test(adminManual),
  pwa_cache_current: /despachefull-v3\\.7\\.0-/.test(sw),
  only_admin_courier: !/role=['"]operator['"]|role IN \([^)]*operator/i.test(server)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', version: '3.7.0', checks }, null, 2));
