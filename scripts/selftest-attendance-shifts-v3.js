import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const checks = {
  shift_module_imported: /from "\.\/lib\/operational-shift\.js"/.test(server),
  attendance_has_shift_column: /ADD COLUMN IF NOT EXISTS shift_code TEXT/.test(server),
  old_daily_unique_dropped: /DROP CONSTRAINT IF EXISTS courier_attendance_courier_id_attendance_date_key/.test(server),
  shift_unique_index: /courier_attendance_date_shift_unique_idx/.test(server) && /courier_id,attendance_date,shift_code/.test(server),
  qr_payload_v2: /v: 2/.test(server) && /s: normalizedShift/.test(server),
  qr_wrong_shift_blocked: /ATTENDANCE_QR_WRONG_SHIFT/.test(server),
  attendance_lookup_by_shift: /a\.shift_code=\$3/.test(server),
  qr_checkin_writes_shift: /courier_id,attendance_date,shift_code,checked_in_at,checkin_method/.test(server),
  manual_checkin_writes_shift: /ADMIN_MANUAL/.test(server) && /shift\.shift_code/.test(server),
  admin_list_shift_filter: /attendanceView\.shift_code/.test(server),
  checkout_has_shift: /shift_code: attendanceView\.shift_code/.test(server),
  courier_dashboard_has_shift: /shift_label: attendanceView\.shift_label/.test(server),
  courier_departure_shift_gate: /departureShift = getCurrentOperationalShift\(\)/.test(server) && /getCourierAttendance\(req\.session\.user\.id, attendanceDate, departureShift\.shift_code\)/.test(server),
  admin_departure_shift_gate: /getCourierAttendance\(courierId, attendanceDate, departureShift\.shift_code\)/.test(server),
  route_add_shift_gate: /routeShift = getCurrentOperationalShift\(\)/.test(server),
  between_shifts_blocked: /OUTSIDE_OPERATIONAL_SHIFT/.test(server),
  legacy_history_preserved: /WORK_SHIFT_CUTOVER_DATE = "2026-09-12"/.test(server) && /a\.shift_code IS NULL/.test(server)
};

for (const [name, ok] of Object.entries(checks)) {
  assert.ok(ok, `FAIL: ${name}`);
}

console.log(JSON.stringify({ result: "PASS", step: 3, checks }, null, 2));
