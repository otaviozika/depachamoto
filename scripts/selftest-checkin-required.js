import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');

const closeCalls = (server.match(/closeActiveDispatch\s*\(/g) || []).length;

const checks = {
  version_280: /const VERSION = "2\.8\.0"/.test(server),
  package_gate_code: /RETURN_CHECKIN_REQUIRED/.test(server),
  transaction_advisory_lock: /pg_advisory_xact_lock/.test(server),
  database_one_active_index: /dispatches_one_active_per_courier_idx/.test(server),
  transaction_checks_active_courier: /WHERE courier_id=\$1 AND status='ON_ROAD'[\s\S]{0,300}FOR UPDATE/.test(server),
  no_auto_close_on_new_departure: closeCalls === 0,
  old_confirm_override_removed_server: !/confirm_new_departure/.test(server),
  arrival_audit_columns: /arrival_source TEXT/.test(server) && /arrival_reason TEXT/.test(server),
  admin_arrival_reason_required: /ADMIN_ARRIVAL_REASON_REQUIRED/.test(server),
  courier_ui_locked: /Confirme sua chegada para nova saída/.test(ui),
  courier_ui_no_auto_close_copy: !/saída anterior será encerrada automaticamente/.test(ui),
  courier_payload_no_override: !/confirm_new_departure/.test(ui),
  admin_manual_blocked: /Nova saída bloqueada: confirme a chegada deste motoboy/.test(ui),
  offline_queue_respects_gate: /saída sem check-in de chegada/.test(ui),
  pwa_cache_280: /despachefull-v2\.8\.0-checkin-required/.test(sw),
  only_admin_courier: !/role=['"]operator['"]|role IN \([^)]*operator/i.test(server)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', version: '2.8.0', checks }, null, 2));
