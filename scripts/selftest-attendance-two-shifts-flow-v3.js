import assert from "node:assert/strict";
import { operationalShiftAt, SHIFT_LUNCH, SHIFT_DINNER } from "../lib/operational-shift.js";

function atSP(localIso) {
  return new Date(`${localIso}-03:00`);
}

class AttendanceStore {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }

  key(courierId, attendanceDate, shiftCode) {
    return `${courierId}|${attendanceDate}|${shiftCode}`;
  }

  find(courierId, attendanceDate, shiftCode) {
    return this.rows.find(row =>
      row.courier_id === courierId &&
      row.attendance_date === attendanceDate &&
      row.shift_code === shiftCode
    ) || null;
  }

  checkin({ courierId, at }) {
    const shift = operationalShiftAt(at, { required: true });
    const existing = this.find(courierId, shift.operational_date, shift.shift_code);
    if (existing) {
      if (existing.checked_out_at) {
        const error = new Error("Turno já encerrado.");
        error.code = "SHIFT_ENDED";
        throw error;
      }
      return { row: existing, duplicate: true };
    }
    const row = {
      id: this.nextId++, courier_id: courierId,
      attendance_date: shift.operational_date, shift_code: shift.shift_code,
      checked_in_at: at.toISOString(), checked_out_at: null
    };
    this.rows.push(row);
    return { row, duplicate: false };
  }

  checkout({ courierId, attendanceDate, shiftCode, at }) {
    const row = this.find(courierId, attendanceDate, shiftCode);
    if (!row) {
      const error = new Error("Presença não encontrada.");
      error.code = "ATTENDANCE_NOT_FOUND";
      throw error;
    }
    if (row.checked_out_at) {
      const error = new Error("Turno já encerrado.");
      error.code = "SHIFT_ALREADY_ENDED";
      throw error;
    }
    row.checked_out_at = at.toISOString();
    return row;
  }
}

const COURIER_ID = 25;
const DATE = "2026-09-18";
const store = new AttendanceStore();

const lunchCheckinAt = atSP("2026-09-18T11:45:00");
const lunchShift = operationalShiftAt(lunchCheckinAt, { required: true });
assert.equal(lunchShift.shift_code, SHIFT_LUNCH);
assert.equal(lunchShift.operational_date, DATE);
const lunchCheckin = store.checkin({ courierId: COURIER_ID, at: lunchCheckinAt });
assert.equal(lunchCheckin.duplicate, false);
assert.equal(lunchCheckin.row.shift_code, SHIFT_LUNCH);
assert.equal(store.rows.length, 1);

const lunchDuplicate = store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T12:10:00") });
assert.equal(lunchDuplicate.duplicate, true);
assert.equal(lunchDuplicate.row.id, lunchCheckin.row.id);
assert.equal(store.rows.length, 1);

const lunchClosed = store.checkout({ courierId: COURIER_ID, attendanceDate: DATE, shiftCode: SHIFT_LUNCH, at: atSP("2026-09-18T14:30:00") });
assert.ok(lunchClosed.checked_out_at);
assert.throws(() => store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T14:20:00") }), error => error?.code === "SHIFT_ENDED");

const dinnerCheckinAt = atSP("2026-09-18T18:10:00");
const dinnerShift = operationalShiftAt(dinnerCheckinAt, { required: true });
assert.equal(dinnerShift.shift_code, SHIFT_DINNER);
assert.equal(dinnerShift.operational_date, DATE);
const dinnerCheckin = store.checkin({ courierId: COURIER_ID, at: dinnerCheckinAt });
assert.equal(dinnerCheckin.duplicate, false);
assert.equal(dinnerCheckin.row.shift_code, SHIFT_DINNER);
assert.notEqual(dinnerCheckin.row.id, lunchCheckin.row.id);
assert.equal(store.rows.length, 2);

const lunchAfterDinnerOpen = store.find(COURIER_ID, DATE, SHIFT_LUNCH);
const dinnerOpen = store.find(COURIER_ID, DATE, SHIFT_DINNER);
assert.ok(lunchAfterDinnerOpen.checked_out_at);
assert.equal(dinnerOpen.checked_out_at, null);

const dinnerDuplicate = store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T19:00:00") });
assert.equal(dinnerDuplicate.duplicate, true);
assert.equal(store.rows.length, 2);

const dinnerClosed = store.checkout({ courierId: COURIER_ID, attendanceDate: DATE, shiftCode: SHIFT_DINNER, at: atSP("2026-09-18T23:30:00") });
assert.ok(dinnerClosed.checked_out_at);
const finalLunch = store.find(COURIER_ID, DATE, SHIFT_LUNCH);
const finalDinner = store.find(COURIER_ID, DATE, SHIFT_DINNER);
assert.ok(finalLunch.checked_out_at);
assert.ok(finalDinner.checked_out_at);
assert.notEqual(finalLunch.checked_out_at, finalDinner.checked_out_at);
assert.equal(store.rows.length, 2);
assert.equal(finalLunch.courier_id, finalDinner.courier_id);
assert.equal(finalLunch.attendance_date, finalDinner.attendance_date);
assert.notEqual(finalLunch.shift_code, finalDinner.shift_code);
assert.equal(store.key(COURIER_ID, DATE, SHIFT_LUNCH), `${COURIER_ID}|${DATE}|LUNCH`);
assert.equal(store.key(COURIER_ID, DATE, SHIFT_DINNER), `${COURIER_ID}|${DATE}|DINNER`);

console.log(JSON.stringify({ result: "PASS", step: 3, scenario: "same courier, same date, lunch + dinner isolation", assertions: { lunch_checkin_1145: true, lunch_checkout: true, dinner_checkin_1810_same_date: true, lunch_dinner_isolated: true, dinner_checkout: true, exactly_two_attendance_rows: true } }, null, 2));
