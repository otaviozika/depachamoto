import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');

const checks = {
  version_280: /const VERSION = "2\.8\.0"/.test(server),
  stage_column: /operational_stage TEXT NOT NULL DEFAULT 'EN_ROUTE'/.test(server),
  returning_timestamp: /returning_at TIMESTAMPTZ/.test(server),
  returned_timestamp: /returned_at TIMESTAMPTZ/.test(server),
  sla_snapshots: /route_sla_minutes INTEGER/.test(server) && /return_sla_minutes INTEGER/.test(server),
  dynamic_sla_defaults: /route_sla_1_minutes','25'/.test(server) && /route_sla_5_minutes','45'/.test(server),
  return_sla_default: /return_sla_minutes','15'/.test(server),
  courier_start_return: /\/api\/courier\/dispatches\/:id\/start-return/.test(server),
  courier_arrive: /\/api\/courier\/dispatches\/:id\/arrive/.test(server),
  admin_start_return: /\/api\/admin\/dispatches\/:id\/start-return/.test(server),
  auto_ifood_return: /maybeAutoMarkDispatchReturning\(row\.dispatch_id/.test(server),
  locks_released_on_arrival: /DELETE FROM active_order_locks WHERE dispatch_id=\$1/.test(server),
  exception_panel: /id="operationalExceptions"/.test(ui),
  courier_arrival_button: /Cheguei na loja/.test(ui),
  courier_return_button: /Todos entregues — iniciar retorno/.test(ui),
  sla_admin_fields: /id="slaRoute1"/.test(ui) && /id="slaRoute5"/.test(ui) && /id="slaReturn"/.test(ui),
  returning_ui: /RETORNANDO/.test(ui),
  pwa_cache_280: /despachefull-v2\.8\.0-checkin-required/.test(sw),
  only_admin_courier: !/role=['"]operator['"]|role IN \([^)]*operator/i.test(server)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', checks }, null, 2));
