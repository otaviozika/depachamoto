import assert from "node:assert/strict";
import {
  SHIFT_LUNCH,
  SHIFT_DINNER,
  operationalShiftAt,
  requireOperationalShift,
  normalizeShiftCode,
  shiftLabel
} from "../lib/operational-shift.js";

function atSP(localIso) {
  // São Paulo está em UTC-03:00 nas datas operacionais atuais.
  return new Date(`${localIso}-03:00`);
}

const cases = [
  ["2026-09-14T11:29:59", null, "segunda antes do almoço"],
  ["2026-09-14T11:30:00", SHIFT_LUNCH, "segunda início almoço"],
  ["2026-09-14T14:30:00", SHIFT_LUNCH, "segunda fim almoço"],
  ["2026-09-14T14:31:00", null, "segunda intervalo"],
  ["2026-09-14T18:00:00", SHIFT_DINNER, "segunda início janta"],
  ["2026-09-14T23:32:00", SHIFT_DINNER, "segunda fim janta"],
  ["2026-09-14T23:33:00", null, "segunda após janta"],

  ["2026-09-18T10:59:00", null, "sexta antes do almoço"],
  ["2026-09-18T11:00:00", SHIFT_LUNCH, "sexta início almoço"],
  ["2026-09-18T15:00:00", SHIFT_LUNCH, "sexta fim almoço"],
  ["2026-09-18T15:01:00", null, "sexta intervalo"],
  ["2026-09-18T18:00:00", SHIFT_DINNER, "sexta início janta"],
  ["2026-09-18T23:30:00", SHIFT_DINNER, "sexta fim janta"],

  ["2026-09-19T11:00:00", SHIFT_LUNCH, "sábado início almoço"],
  ["2026-09-19T15:00:00", SHIFT_LUNCH, "sábado fim almoço"],
  ["2026-09-19T18:00:00", SHIFT_DINNER, "sábado início janta"],

  ["2026-09-20T12:00:00", null, "domingo sem almoço"],
  ["2026-09-20T17:59:00", null, "domingo antes da janta"],
  ["2026-09-20T18:00:00", SHIFT_DINNER, "domingo início janta"],
  ["2026-09-20T23:30:00", SHIFT_DINNER, "domingo fim janta"],
  ["2026-09-20T23:31:00", null, "domingo após janta"]
];

for (const [iso, expected, label] of cases) {
  const result = operationalShiftAt(atSP(iso));
  assert.equal(result?.shift_code || null, expected, label);
  if (result) {
    assert.equal(result.time_zone, "America/Sao_Paulo", `${label}: timezone`);
    assert.match(result.operational_date, /^\d{4}-\d{2}-\d{2}$/, `${label}: data operacional`);
  }
}

assert.equal(normalizeShiftCode(" lunch "), SHIFT_LUNCH);
assert.equal(normalizeShiftCode("DINNER"), SHIFT_DINNER);
assert.equal(normalizeShiftCode("x"), null);
assert.equal(shiftLabel(SHIFT_LUNCH), "Almoço");
assert.equal(shiftLabel(SHIFT_DINNER), "Janta");

assert.throws(
  () => requireOperationalShift(atSP("2026-09-18T16:00:00")),
  error => error?.code === "OUTSIDE_OPERATIONAL_SHIFT" && error?.statusCode === 409,
  "requireOperationalShift deve bloquear o intervalo entre almoço e janta"
);

console.log(JSON.stringify({
  result: "PASS",
  tested_cases: cases.length,
  rules: {
    mon_thu: { lunch: "11:30-14:30", dinner: "18:00-23:32" },
    fri_sat: { lunch: "11:00-15:00", dinner: "18:00-23:30" },
    sunday: { lunch: null, dinner: "18:00-23:30" }
  }
}, null, 2));
