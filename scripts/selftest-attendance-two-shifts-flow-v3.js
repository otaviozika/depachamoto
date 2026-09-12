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
      id: this.nextId++,
      courier_id: courierId,
      attendance_date: shift.operational_date,
      shift_code: shift.shift_code,
      checked_in_at: at.toISOString(),
      checked_out_at: null
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
const DATE = "2026-09-18"; // sexta-feira
const store = new AttendanceStore();

// 1) 11:45 -> LUNCH
const lunchCheckinAt = atSP("2026-09-18T11:45:00");
const lunchShift = operationalShiftAt(lunchCheckinAt, { required: true });
assert.equal(lunchShift.shift_code, SHIFT_LUNCH, "11:45 de sexta deve pertencer ao LUNCH");
assert.equal(lunchShift.operational_date, DATE);

const lunchCheckin = store.checkin({ courierId: COURIER_ID, at: lunchCheckinAt });
assert.equal(lunchCheckin.duplicate, false, "primeiro check-in do almoço não pode ser duplicado");
assert.equal(lunchCheckin.row.courier_id, COURIER_ID);
assert.equal(lunchCheckin.row.attendance_date, DATE);
assert.equal(lunchCheckin.row.shift_code, SHIFT_LUNCH);
assert.equal(lunchCheckin.row.checked_out_at, null);
assert.equal(store.rows.length, 1, "deve existir exatamente um registro após o check-in do almoço");

// 2) Duplicar LUNCH deve reutilizar o mesmo registro, não criar outro.
const lunchDuplicate = store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T12:10:00") });
assert.equal(lunchDuplicate.duplicate, true);
assert.equal(lunchDuplicate.row.id, lunchCheckin.row.id);
assert.equal(store.rows.length, 1, "duplicidade dentro do mesmo turno deve ser bloqueada");

// 3) Checkout do almoço.
const lunchCheckoutAt = atSP("2026-09-18T14:30:00");
const lunchClosed = store.checkout({
  courierId: COURIER_ID,
  attendanceDate: DATE,
  shiftCode: SHIFT_LUNCH,
  at: lunchCheckoutAt
});
assert.equal(lunchClosed.shift_code, SHIFT_LUNCH);
assert.ok(lunchClosed.checked_out_at, "checkout do almoço deve preencher checked_out_at");

// 4) Depois do checkout, o LUNCH não pode reabrir.
assert.throws(
  () => store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T14:20:00") }),
  error => error?.code === "SHIFT_ENDED",
  "QR/check-in do almoço não pode reabrir um turno já encerrado"
);

// 5) 18:10 -> DINNER no mesmo courier e mesma data.
const dinnerCheckinAt = atSP("2026-09-18T18:10:00");
const dinnerShift = operationalShiftAt(dinnerCheckinAt, { required: true });
assert.equal(dinnerShift.shift_code, SHIFT_DINNER, "18:10 de sexta deve pertencer ao DINNER");
assert.equal(dinnerShift.operational_date, DATE, "almoço e janta devem compartilhar a mesma operational_date");

const dinnerCheckin = store.checkin({ courierId: COURIER_ID, at: dinnerCheckinAt });
assert.equal(dinnerCheckin.duplicate, false, "janta deve criar novo registro mesmo após almoço no mesmo dia");
assert.equal(dinnerCheckin.row.courier_id, COURIER_ID);
assert.equal(dinnerCheckin.row.attendance_date, DATE);
assert.equal(dinnerCheckin.row.shift_code, SHIFT_DINNER);
assert.equal(dinnerCheckin.row.checked_out_at, null);
assert.notEqual(dinnerCheckin.row.id, lunchCheckin.row.id, "almoço e janta precisam ter IDs de presença diferentes");
assert.equal(store.rows.length, 2, "mesmo courier + mesma data deve aceitar LUNCH e DINNER simultaneamente");

// 6) Isolamento: criar a janta não pode modificar o almoço encerrado.
const lunchAfterDinnerOpen = store.find(COURIER_ID, DATE, SHIFT_LUNCH);
const dinnerOpen = store.find(COURIER_ID, DATE, SHIFT_DINNER);
assert.ok(lunchAfterDinnerOpen.checked_out_at, "almoço deve continuar encerrado");
assert.equal(dinnerOpen.checked_out_at, null, "janta deve permanecer aberta");
assert.equal(lunchAfterDinnerOpen.shift_code, SHIFT_LUNCH);
assert.equal(dinnerOpen.shift_code, SHIFT_DINNER);

// 7) Duplicar DINNER não pode criar terceiro registro.
const dinnerDuplicate = store.checkin({ courierId: COURIER_ID, at: atSP("2026-09-18T19:00:00") });
assert.equal(dinnerDuplicate.duplicate, true);
assert.equal(dinnerDuplicate.row.id, dinnerCheckin.row.id);
assert.equal(store.rows.length, 2);

// 8) Checkout da janta.
const dinnerCheckoutAt = atSP("2026-09-18T23:30:00");
const dinnerClosed = store.checkout({
  courierId: COURIER_ID,
  attendanceDate: DATE,
  shiftCode: SHIFT_DINNER,
  at: dinnerCheckoutAt
});
assert.ok(dinnerClosed.checked_out_at, "checkout da janta deve preencher checked_out_at");

// 9) Isolamento final: ambos encerrados, mas cada turno mantém seu próprio checkout.
const finalLunch = store.find(COURIER_ID, DATE, SHIFT_LUNCH);
const finalDinner = store.find(COURIER_ID, DATE, SHIFT_DINNER);
assert.ok(finalLunch.checked_out_at);
assert.ok(finalDinner.checked_out_at);
assert.notEqual(finalLunch.checked_out_at, finalDinner.checked_out_at, "cada turno deve preservar seu próprio horário de checkout");
assert.equal(store.rows.length, 2, "fluxo completo deve terminar com exatamente dois registros de presença");

// 10) A chave lógica dos dois registros só difere pelo shift_code.
assert.equal(finalLunch.courier_id, finalDinner.courier_id);
assert.equal(finalLunch.attendance_date, finalDinner.attendance_date);
assert.notEqual(finalLunch.shift_code, finalDinner.shift_code);
assert.equal(store.key(COURIER_ID, DATE, SHIFT_LUNCH), `${COURIER_ID}|${DATE}|LUNCH`);
assert.equal(store.key(COURIER_ID, DATE, SHIFT_DINNER), `${COURIER_ID}|${DATE}|DINNER`);

console.log(JSON.stringify({
  result: "PASS",
  step: 3,
  scenario: "same courier, same date, lunch + dinner isolation",
  courier_id: COURIER_ID,
  attendance_date: DATE,
  rows: store.rows.map(row => ({
    id: row.id,
    courier_id: row.courier_id,
    attendance_date: row.attendance_date,
    shift_code: row.shift_code,
    checked_in_at: row.checked_in_at,
    checked_out_at: row.checked_out_at
  })),
  assertions: {
    lunch_checkin_1145: true,
    lunch_duplicate_blocked: true,
    lunch_checkout: true,
    lunch_reopen_blocked: true,
    dinner_checkin_1810_same_date: true,
    lunch_dinner_isolated: true,
    dinner_duplicate_blocked: true,
    dinner_checkout: true,
    independent_checkout_timestamps: true,
    exactly_two_attendance_rows: true
  }
}, null, 2));
