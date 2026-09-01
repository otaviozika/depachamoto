import fs from 'fs';
import assert from 'assert';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const courierDepart = server.match(/app\.post\("\/api\/courier\/depart"[\s\S]*?\n\}\)\);/)?.[0] || '';
const adminManual = server.match(/app\.post\("\/api\/admin\/dispatches\/manual"[\s\S]*?\n\}\)\);/)?.[0] || '';
const dashboard = server.match(/app\.get\("\/api\/admin\/dashboard"[\s\S]*?\n\}\)\);/)?.[0] || '';
const dailyReport = server.match(/app\.get\("\/api\/admin\/reports\/daily"[\s\S]*?\n\}\)\);/)?.[0] || '';

const checks = {
  version_300: /const VERSION = "3\.4\.0"/.test(server) && pkg.version === '3.4.0',
  attendance_table: /CREATE TABLE IF NOT EXISTS courier_attendance/.test(server),
  attendance_unique_day: /UNIQUE\(courier_id,attendance_date\)/.test(server),
  legacy_backfill_once: /attendance_legacy_backfill_v3/.test(server) && /LEGACY_INFERRED/.test(server),
  qr_hmac_signed: /createHmac\("sha256", attendanceQrSecret\(\)\)/.test(server),
  qr_expiry: /ATTENDANCE_QR_TTL_MS/.test(server) && /ATTENDANCE_QR_EXPIRED/.test(server),
  admin_qr_endpoint: /\/api\/admin\/attendance\/qr/.test(server) && /auth, adminOnly/.test(server),
  courier_qr_checkin_endpoint: /\/api\/courier\/attendance\/checkin/.test(server) && /ATTENDANCE_QR_CHECKIN/.test(server),
  admin_manual_attendance_endpoint: /\/api\/admin\/attendance\/checkin/.test(server) && /ATTENDANCE_MANUAL_CHECKIN/.test(server),
  courier_departure_requires_attendance: /ATTENDANCE_REQUIRED/.test(courierDepart) && /getCourierAttendance/.test(courierDepart),
  admin_departure_requires_attendance: /ATTENDANCE_REQUIRED/.test(adminManual) && /getCourierAttendance/.test(adminManual),
  dashboard_active_is_attendance: /courier_attendance/.test(dashboard) && /AS active_couriers/.test(dashboard),
  dashboard_orders_are_ifood_received: /FROM ifood_orders o/.test(dashboard) && /AS today_orders/.test(dashboard),
  dashboard_available_present_minus_road: /available: Math\.max\(0, metrics\.active_couriers - metrics\.on_road\)/.test(dashboard),
  daily_report_attendance: /FROM courier_attendance a/.test(dailyReport) && /checked_in_at/.test(dailyReport),
  daily_report_received_orders: /FROM ifood_orders o/.test(dailyReport),
  ui_attendance_nav: /\['attendance','Presença'\]/.test(ui) && /Presença do dia/.test(ui),
  ui_dynamic_qr: /qrcodejs\/1\.0\.0\/qrcode\.min\.js/.test(ui) && /refreshAttendanceQr/.test(ui),
  ui_qr_login_survival: /ATTENDANCE_TOKEN_KEY/.test(ui) && /captureAttendanceTokenFromUrl/.test(ui) && /processPendingAttendanceToken/.test(ui),
  ui_courier_attendance_lock: /Confirme presença pelo QR/.test(ui) && /courierAttendancePresent/.test(ui),
  ui_report_presence_columns: /Presença e operação por motoboy/.test(ui) && /rDispatchedOrders/.test(ui),
  cache_300: /despachefull-v3\.4\.0-sober-ui/.test(sw),
  only_admin_courier: !/role=['"]operator['"]|role IN \([^)]*operator/i.test(server)
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: 'PASS', version: '3.4.0', checks }, null, 2));
