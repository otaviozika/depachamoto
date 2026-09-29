const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const ADMIN_USERNAME = String(process.env.STAGING_ADMIN_USERNAME || process.env.ADMIN_USERNAME || "");
const ADMIN_PASSWORD = String(process.env.STAGING_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, options = {}) {
  const res = await fetch(TARGET + path, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

const health = await json("/api/health");
assert(health.res.ok, `/api/health HTTP ${health.res.status}`);
assert(health.body?.ok === true, "health não retornou ok=true");
assert(health.body?.database === "connected", "banco não está conectado");
assert(health.body?.environment === "staging", `ambiente inesperado: ${health.body?.environment}`);
assert(health.body?.stagingSafeMode === true, "STAGING_SAFE_MODE não está ativo");
assert(health.body?.externalIntegrationsBlocked === true, "integrações externas não estão bloqueadas");
assert(health.body?.ifood?.configured === false, "iFood apareceu configurado no staging seguro");
assert(health.body?.anotaai?.configured === false, "Anota AI apareceu configurado no staging seguro");

assert(ADMIN_USERNAME && ADMIN_PASSWORD, "Credenciais admin de staging ausentes");
const login = await json("/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
});
assert(login.res.ok, `login admin falhou: HTTP ${login.res.status} ${JSON.stringify(login.body)}`);
const cookie = String(login.res.headers.get("set-cookie") || "").split(";")[0];
assert(cookie, "cookie de sessão não recebido");

const center = await json("/api/admin/health-center", { headers: { cookie } });
assert(center.res.ok, `health center falhou: HTTP ${center.res.status}`);
assert(center.body?.components?.server, "health center sem componente servidor");

const ifoodSync = await json("/api/admin/ifood/sync-now", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: "{}"
});
assert(ifoodSync.res.status === 503, `iFood sync deveria ser bloqueado no staging, recebeu HTTP ${ifoodSync.res.status}`);

const anotaSync = await json("/api/admin/anotaai/sync-now", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: "{}"
});
assert(anotaSync.res.status === 503, `Anota AI sync deveria ser bloqueado no staging, recebeu HTTP ${anotaSync.res.status}`);

const sheetsClose = await json("/api/admin/payments/close-day", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ date: "2026-09-28", shift_code: "DINNER" })
});
assert(sheetsClose.res.status === 503, `Google Sheets deveria ser bloqueado no staging, recebeu HTTP ${sheetsClose.res.status}`);

console.log(JSON.stringify({
  result: "PASS",
  target: TARGET,
  environment: health.body.environment,
  stagingSafeMode: health.body.stagingSafeMode,
  database: health.body.database,
  dbLatencyMs: health.body.dbLatencyMs,
  healthCenter: center.body?.overall?.status || null,
  ifoodMutationBlocked: ifoodSync.res.status === 503,
  anotaAiMutationBlocked: anotaSync.res.status === 503,
  sheetsMutationBlocked: sheetsClose.res.status === 503
}, null, 2));
