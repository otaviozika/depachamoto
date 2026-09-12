import assert from "node:assert/strict";
import { resolveDispatchShift } from "../lib/operational-shift.js";

const sp = local => `${local}-03:00`;

const lunch = resolveDispatchShift({ departedAt: sp("2026-09-18T12:35:00") });
assert.equal(lunch.operational_date, "2026-09-18");
assert.equal(lunch.shift_code, "LUNCH");
assert.equal(lunch.source, "DEPARTED_AT");

const dinner = resolveDispatchShift({ departedAt: sp("2026-09-18T19:10:00") });
assert.equal(dinner.shift_code, "DINNER");

const inherited = resolveDispatchShift({
  departedAt: sp("2026-09-18T19:10:00"),
  existingOperationalDate: "2026-09-18",
  existingShiftCode: "LUNCH"
});
assert.equal(inherited.shift_code, "LUNCH", "append deve herdar o turno congelado da rota");
assert.equal(inherited.source, "EXISTING_ROUTE");

const recoveredLunchAtNight = resolveDispatchShift({
  departedAt: sp("2026-09-18T12:35:00"),
  recovery: true
});
assert.equal(recoveredLunchAtNight.shift_code, "LUNCH", "recuperação usa departedAt original, não horário da correção");

assert.throws(
  () => resolveDispatchShift({ departedAt: sp("2026-09-20T12:00:00") }),
  error => error?.code === "OUTSIDE_OPERATIONAL_SHIFT",
  "domingo no almoço deve continuar inválido"
);

assert.throws(
  () => resolveDispatchShift({ departedAt: sp("2026-09-18T16:00:00") }),
  error => error?.code === "OUTSIDE_OPERATIONAL_SHIFT",
  "despacho normal entre turnos deve ser bloqueado"
);

assert.throws(
  () => resolveDispatchShift({ departedAt: sp("2026-09-18T16:00:00"), recovery: true }),
  error => error?.code === "RECOVERY_SHIFT_REQUIRED",
  "recuperação fora da janela exige turno explícito"
);

const recoveredOverride = resolveDispatchShift({
  departedAt: sp("2026-09-18T16:00:00"),
  recovery: true,
  recoveryShiftCode: "LUNCH"
});
assert.equal(recoveredOverride.shift_code, "LUNCH");
assert.equal(recoveredOverride.source, "ADMIN_OVERRIDE");

console.log(JSON.stringify({ result: "PASS", feature: "dispatch_shift_freeze", cases: 8 }, null, 2));
