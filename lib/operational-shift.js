const SP_TIME_ZONE = "America/Sao_Paulo";

export const SHIFT_LUNCH = "LUNCH";
export const SHIFT_DINNER = "DINNER";

export const SHIFT_RULES = Object.freeze({
  MON_THU: Object.freeze({
    LUNCH: Object.freeze({ start: "11:30", end: "14:30" }),
    DINNER: Object.freeze({ start: "18:00", end: "23:32" })
  }),
  FRI_SAT: Object.freeze({
    LUNCH: Object.freeze({ start: "11:00", end: "15:00" }),
    DINNER: Object.freeze({ start: "18:00", end: "23:30" })
  }),
  SUN: Object.freeze({
    DINNER: Object.freeze({ start: "18:00", end: "23:30" })
  })
});

function asValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Data/hora inválida para cálculo do turno.");
  }
  return date;
}

function spParts(value) {
  const date = asValidDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    second: Number(map.second || 0),
    weekday: weekdayMap[map.weekday],
    timestamp: date
  };
}

function minutesOfDay(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!match) throw new TypeError(`Horário inválido: ${hhmm}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function inWindow(time, start, end) {
  const current = minutesOfDay(time);
  return current >= minutesOfDay(start) && current <= minutesOfDay(end);
}

function ruleGroupForWeekday(weekday) {
  if (weekday >= 1 && weekday <= 4) return SHIFT_RULES.MON_THU;
  if (weekday === 5 || weekday === 6) return SHIFT_RULES.FRI_SAT;
  if (weekday === 7) return SHIFT_RULES.SUN;
  return null;
}

export function normalizeShiftCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === SHIFT_LUNCH) return SHIFT_LUNCH;
  if (normalized === SHIFT_DINNER) return SHIFT_DINNER;
  return null;
}

export function shiftLabel(shiftCode) {
  const normalized = normalizeShiftCode(shiftCode);
  if (normalized === SHIFT_LUNCH) return "Almoço";
  if (normalized === SHIFT_DINNER) return "Janta";
  return null;
}

export function getSPDateTime(value = new Date()) {
  return spParts(value);
}

export function operationalShiftAt(value = new Date(), { required = false } = {}) {
  const sp = spParts(value);
  const group = ruleGroupForWeekday(sp.weekday);

  let code = null;
  let rule = null;

  if (group?.LUNCH && inWindow(sp.time, group.LUNCH.start, group.LUNCH.end)) {
    code = SHIFT_LUNCH;
    rule = group.LUNCH;
  } else if (group?.DINNER && inWindow(sp.time, group.DINNER.start, group.DINNER.end)) {
    code = SHIFT_DINNER;
    rule = group.DINNER;
  }

  if (!code) {
    if (required) {
      const error = new Error("Este horário não pertence a um turno de operação.");
      error.code = "OUTSIDE_OPERATIONAL_SHIFT";
      error.statusCode = 409;
      error.operational_date = sp.date;
      throw error;
    }
    return null;
  }

  return {
    date: sp.date,
    operational_date: sp.date,
    shift_code: code,
    shift_label: shiftLabel(code),
    weekday: sp.weekday,
    starts_at: rule.start,
    ends_at: rule.end,
    time_zone: SP_TIME_ZONE
  };
}

export function resolveDispatchShift({
  departedAt = new Date(),
  existingOperationalDate = null,
  existingShiftCode = null,
  recoveryShiftCode = null,
  recovery = false
} = {}) {
  const inheritedCode = normalizeShiftCode(existingShiftCode);
  if (inheritedCode) {
    return {
      operational_date: existingOperationalDate || operationalDateSP(departedAt),
      shift_code: inheritedCode,
      shift_label: shiftLabel(inheritedCode),
      source: "EXISTING_ROUTE"
    };
  }

  const derived = operationalShiftAt(departedAt);
  if (derived) {
    return {
      operational_date: derived.operational_date,
      shift_code: derived.shift_code,
      shift_label: derived.shift_label,
      source: "DEPARTED_AT"
    };
  }

  if (recovery) {
    const overrideCode = normalizeShiftCode(recoveryShiftCode);
    if (overrideCode) {
      return {
        operational_date: operationalDateSP(departedAt),
        shift_code: overrideCode,
        shift_label: shiftLabel(overrideCode),
        source: "ADMIN_OVERRIDE"
      };
    }
  }

  const error = new Error(
    recovery
      ? "O horário original não pertence a um turno. Informe o turno correto para recuperar este pedido."
      : "Este horário não pertence a um turno de operação."
  );
  error.code = recovery ? "RECOVERY_SHIFT_REQUIRED" : "OUTSIDE_OPERATIONAL_SHIFT";
  error.statusCode = 409;
  error.operational_date = operationalDateSP(departedAt);
  throw error;
}

export function getCurrentOperationalShift(now = new Date()) {
  return operationalShiftAt(now);
}

export function requireOperationalShift(value = new Date()) {
  return operationalShiftAt(value, { required: true });
}

export function operationalDateSP(value = new Date()) {
  return spParts(value).date;
}

export { SP_TIME_ZONE };
