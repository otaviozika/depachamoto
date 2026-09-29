import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = [
  ["Staging runtime identity exists", server.includes("const APP_ENV") && server.includes('APP_ENV === "staging"')],
  ["Staging safe mode is forced by APP_ENV", server.includes("const STAGING_SAFE_MODE") && server.includes('APP_ENV === "staging"')],
  ["iFood auto sync is disabled in staging", /function ifoodAutoEnabled\(\)[\s\S]{0,180}STAGING_SAFE_MODE[\s\S]{0,180}return false/.test(server)],
  ["iFood dispatch is disabled in staging", /function ifoodDispatchEnabled\(\)[\s\S]{0,180}STAGING_SAFE_MODE[\s\S]{0,180}return false/.test(server)],
  ["Anota AI auto sync is disabled in staging", /function anotaAiAutoEnabled\(\)[\s\S]{0,180}STAGING_SAFE_MODE[\s\S]{0,180}return false/.test(server)],
  ["iFood worker cannot run in staging", /runIfoodDispatchWorkerOnce\(\)[\s\S]{0,220}STAGING_SAFE_MODE/.test(server)],
  ["Anota AI worker cannot run in staging", /runAnotaAiDispatchWorkerOnce\(\)[\s\S]{0,220}STAGING_SAFE_MODE/.test(server)],
  ["Manual iFood sync is blocked from remote access", /syncIfoodOnce\([\s\S]{0,260}STAGING_SAFE_MODE/.test(server)],
  ["Manual Anota AI sync is blocked from remote access", /syncAnotaAiOnce\([\s\S]{0,260}STAGING_SAFE_MODE/.test(server)],
  ["iFood dispatch mutation has a staging guard", server.includes('assertExternalMutationAllowed("despacho de pedido no iFood")')],
  ["iFood delivery-code mutation has a staging guard", server.includes('assertExternalMutationAllowed("verificação de código de entrega no iFood")')],
  ["iFood confirm and cancellation mutations have staging guards", server.includes('assertExternalMutationAllowed("confirmação de pedido de teste no iFood")') && server.includes('assertExternalMutationAllowed("cancelamento de pedido no iFood")')],
  ["Anota AI finalization and linking have staging guards", server.includes('assertExternalMutationAllowed("finalização de pedido no Anota AI")') && server.includes('assertExternalMutationAllowed("vinculação de loja no Anota AI")')],
  ["Google Sheets writes have staging guards", server.includes('assertExternalMutationAllowed("envio de fechamento ao Google Planilhas")') && server.includes('assertExternalMutationAllowed("sincronização com Google Planilhas")')],
  ["Public config exposes staging identity", server.includes("stagingSafeMode: STAGING_SAFE_MODE") && server.includes("environment: APP_ENV")],
  ["Health endpoint exposes external-mutation gate", server.includes("externalMutationsAllowed: !STAGING_SAFE_MODE")],
  ["Staging environment is visually identified", html.includes('id="stagingBanner"') && html.includes("staging-mode") && html.includes("HOMOLOGAÇÃO SEGURA")]
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failed++;
}

if (failed) {
  console.error(`Staging safety self-test failed: ${failed} check(s).`);
  process.exit(1);
}

console.log(`Staging safety self-test passed: ${checks.length}/${checks.length}.`);
