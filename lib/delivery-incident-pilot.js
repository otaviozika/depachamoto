import { PRE_DEPARTURE_SETTINGS, PRE_DEPARTURE_SETTINGS_LOCK } from "./pre-departure-service.js";

// Fail-closed gate for delivery incidents. Independent of route-planner flags.
// Values live in app_settings so disabling takes effect without a deploy.
export const INCIDENT_PILOT_KEYS = Object.freeze({
  enabled: "delivery_incidents_enabled",
  courierId: "delivery_incidents_pilot_courier_id",
  preDeparture: PRE_DEPARTURE_SETTINGS.pre_departure,
  scope: PRE_DEPARTURE_SETTINGS.scope
});

export function validCourierId(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (String(value).trim() === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function incidentEnabledForCourier(settings, courierId, { allCouriers = false } = {}) {
  const id = validCourierId(courierId);
  return settings?.enabled === true && settings?.pre_departure_enabled === true &&
    id !== null && (allCouriers || validCourierId(settings?.courier_id) === id);
}

export async function readIncidentPilotSettings(pool) {
  const result = await pool.query(
    "SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [Object.values(INCIDENT_PILOT_KEYS)]
  );
  const values = new Map(result.rows.map(row => [row.setting_key, row.setting_value]));
  return {
    enabled: values.get(INCIDENT_PILOT_KEYS.enabled) === "true",
    pre_departure_enabled: values.get(INCIDENT_PILOT_KEYS.preDeparture) === "true",
    courier_id: validCourierId(values.get(INCIDENT_PILOT_KEYS.courierId))
  };
}

export async function saveIncidentPilotSettings({
  pool, adminId, enabled, courierId, reason, matchesConfiguredPilot = () => true,
  audit = async () => {}, emitRealtime = () => {}
}) {
  const by = validCourierId(adminId);
  const pilot = validCourierId(courierId);
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!by) throw Object.assign(new Error("Administrador inválido."), {status: 403, code: "INCIDENT_ADMIN_INVALID"});
  if (typeof enabled !== "boolean") throw Object.assign(new Error("Informe se o recurso deve estar ligado ou desligado."), {status: 400, code: "INCIDENT_FLAG_INVALID"});
  if (why.length < 5 || why.length > 250) throw Object.assign(new Error("Informe um motivo entre 5 e 250 caracteres."), {status: 400, code: "INCIDENT_SETTINGS_REASON_REQUIRED"});
  const client = await pool.connect();
  let previous, selectedCourier;
  try {
    await client.query("BEGIN");
    // One-at-a-time updates even when two admin sessions submit together.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PRE_DEPARTURE_SETTINGS_LOCK]);
    const rows = (await client.query(
      "SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
      [Object.values(INCIDENT_PILOT_KEYS)]
    )).rows;
    const map = new Map(rows.map(row => [row.setting_key, row.setting_value]));
    const allCouriers = map.get(INCIDENT_PILOT_KEYS.scope) === "all";
    previous = {
      enabled: map.get(INCIDENT_PILOT_KEYS.enabled) === "true",
      courier_id: validCourierId(map.get(INCIDENT_PILOT_KEYS.courierId)),
      pre_departure_enabled: map.get(INCIDENT_PILOT_KEYS.preDeparture) === "true"
    };

    if (enabled && !allCouriers && !pilot) {
      throw Object.assign(new Error("Escolha um motoboy válido para o piloto antes de habilitar."), {status: 400, code: "INCIDENT_PILOT_REQUIRED"});
    }
    if (enabled && !previous.pre_departure_enabled) {
      throw Object.assign(new Error("Ative a conferência de sacolas antes de iniciar o piloto de ocorrências."), {status: 409, code: "INCIDENT_PRE_DEPARTURE_REQUIRED"});
    }
    if (enabled && !allCouriers) {
      if (!matchesConfiguredPilot(pilot)) {
        throw Object.assign(new Error("Escolha o motoboy autorizado para o piloto de conferência."), {status: 409, code: "INCIDENT_PILOT_OUTSIDE_PRE_DEPARTURE_SCOPE"});
      }
      const eligible = await client.query(
        "SELECT id FROM users WHERE id=$1 AND role='courier' AND active=TRUE AND approval_status='APPROVED'",
        [pilot]
      );
      if (!eligible.rowCount) throw Object.assign(new Error("Motoboy não está ativo e aprovado."), {status: 409, code: "INCIDENT_PILOT_NOT_ELIGIBLE"});
    }

    selectedCourier = allCouriers ? previous.courier_id : (pilot || previous.courier_id);
    for (const [key, value] of [
      [INCIDENT_PILOT_KEYS.enabled, enabled ? "true" : "false"],
      [INCIDENT_PILOT_KEYS.courierId, String(selectedCourier || "")]
    ]) {
      await client.query(
        "INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()",
        [key, value]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
  const current = {enabled, pre_departure_enabled: previous.pre_departure_enabled, courier_id: selectedCourier};
  try {
    await audit(by, "DELIVERY_INCIDENT_PILOT_CHANGED", "setting", null, {previous,current,reason:why});
  } catch (error) {
    // The safety setting is durable even if ancillary audit infrastructure fails.
    console.error("Delivery incident pilot audit failed:", error?.message || error);
  }
  emitRealtime("settings:changed", {scope: "delivery_incidents"});
  emitRealtime("dispatch:changed", {all: true, change: "DELIVERY_INCIDENT_PILOT_SETTINGS"});
  return current;
}
