import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const checkoutEndpoint = server.match(/app\.post\("\/api\/admin\/attendance\/:courierId\/checkout"[\s\S]*?\n\}\)\);/)?.[0] || '';
const courierDepart = server.match(/app\.post\("\/api\/courier\/depart"[\s\S]*?\n\}\)\);/)?.[0] || '';
const adminManual = server.match(/app\.post\("\/api\/admin\/dispatches\/manual"[\s\S]*?\n\}\)\);/)?.[0] || '';
const dashboard = server.match(/app\.get\("\/api\/admin\/dashboard"[\s\S]*?\n\}\)\);/)?.[0] || '';
const dailyReport = server.match(/app\.get\("\/api\/admin\/reports\/daily"[\s\S]*?\n\}\)\);/)?.[0] || '';

const checks = {
  version_320: server.includes('const VERSION = "3.5.6";') && pkg.version === '3.5.6',
  attendance_checkout_columns: /checked_out_at TIMESTAMPTZ/.test(server) && /checked_out_by INTEGER/.test(server) && /checkout_reason TEXT/.test(server),
  migration_safe_columns: /ADD COLUMN IF NOT EXISTS checked_out_at/.test(server) && /ADD COLUMN IF NOT EXISTS checked_out_by/.test(server),
  admin_only_checkout_endpoint: /auth, adminOnly/.test(checkoutEndpoint) && !/\/api\/courier\/attendance\/checkout/.test(server),
  checkout_reason_required: /motivo do encerramento do expediente/i.test(checkoutEndpoint) && /reason\.length < 3/.test(checkoutEndpoint),
  cannot_checkout_while_on_road: /SHIFT_HAS_ACTIVE_DISPATCH/.test(checkoutEndpoint) && /status='ON_ROAD'/.test(checkoutEndpoint),
  checkout_is_audited: /ATTENDANCE_ADMIN_CHECKOUT/.test(checkoutEndpoint),
  qr_cannot_reopen: /O QR não pode reativar seu turno/.test(server) && /SHIFT_ENDED/.test(server),
  courier_depart_blocked_after_checkout: /SHIFT_ENDED/.test(courierDepart) && /attendance\.checked_out_at/.test(courierDepart),
  admin_manual_depart_blocked_after_checkout: /SHIFT_ENDED/.test(adminManual) && /attendance\.checked_out_at/.test(adminManual),
  dashboard_active_excludes_ended: /a\.checked_out_at IS NULL/.test(dashboard) && /AS active_couriers/.test(dashboard),
  dashboard_has_ended_status: /'ENCERRADO'/.test(dashboard) && /present_today/.test(dashboard),
  ui_admin_checkout_action: /checkoutCourier\(/.test(ui) && /Encerrar expediente/.test(ui),
  ui_courier_no_checkout_action: !/api\/courier\/attendance\/.*checkout/.test(ui),
  ui_shift_ended_lock: /Expediente encerrado pelo Admin/.test(ui) && /courierShiftEnded/.test(ui),
  report_checkout_fields: /checked_out_at/.test(dailyReport) && /shift_minutes/.test(dailyReport) && /checkout_reason/.test(dailyReport),
  csv_checkout_fields: /Tempo de expediente \(min\)/.test(server) && /Admin encerramento/.test(server),
  pwa_cache_bumped: /despachefull-v3\.5\.6-takeout-filter/.test(sw)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', version: '3.5.6', checks }, null, 2));
