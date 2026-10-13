// Regressão de segurança: rotas públicas não expõem detalhes internos.
// - /api/health: visitante anônimo recebe só {ok, database, time}; detalhes de
//   integrações apenas para admin logado ou homologação segura (STAGING_SAFE_MODE),
//   cujo gate de CI valida esses campos.
// - Erros inesperados (sem status): mensagem original só para admin; demais
//   recebem texto genérico + request_id.
// Validado de ponta a ponta (servidor real + PostgreSQL) no PR que criou este teste.
import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const healthStart = server.indexOf('app.get("/api/health"');
const health = server.slice(healthStart, server.indexOf('app.get("/{*splat}"', healthStart));
const handler = server.slice(server.lastIndexOf("app.use((err, req, res, next) => {"));
const handlerBody = handler.slice(0, handler.indexOf("\n});") + 4);

const checks = {
  healthGateUsesSafeModeOrAdmin: health.includes('const showDetails = STAGING_SAFE_MODE || req.session?.user?.role === "admin";'),
  healthMinimalForAnonymous: health.includes('return res.json({ ok: true, database: "connected", time: new Date().toISOString() });'),
  healthGateBeforeDetails: health.indexOf("if (!showDetails)") > -1 && health.indexOf("if (!showDetails)") < health.indexOf("ifood: {"),
  health503HasNoVersion: !/status\(503\)\.json\(\{[^}]*version/.test(health),
  stagingContractFieldsKept: ["environment: APP_ENV", "stagingSafeMode: STAGING_SAFE_MODE", "externalMutationsAllowed: !STAGING_SAFE_MODE",
    "eventSyncEnabled: ifoodAutoEnabled()", "dispatchFlagEnabled: ifoodDispatchEnabled()", "automaticSyncEnabled: anotaAiAutoEnabled()"].every(f => health.includes(f)),
  errorHandlerDeliberateKeepsMessage: handlerBody.includes("const deliberate = Boolean(err.status);"),
  errorHandlerAdminKeepsMessage: handlerBody.includes('const isAdmin = req.session?.user?.role === "admin";') && handlerBody.includes("deliberate || isAdmin"),
  errorHandlerGenericOtherwise: handlerBody.includes('"Erro interno do servidor. Se persistir, informe o código ao administrador."'),
  errorHandlerKeepsRequestId: handlerBody.includes("request_id: req.requestId || null"),
  noRawMessageForEveryone: !handlerBody.includes('error: err.message || "Erro interno do servidor."')
};
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
