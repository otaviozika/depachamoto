import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const env = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const checks = {
  version_355:
    pkg.version === "3.5.6" &&
    server.includes('const VERSION = "3.5.6";') &&
    html.includes("<title>DespacheFull 3.5.6</title>"),

  merchant_env:
    server.includes("function ifoodPrimaryMerchantId()") &&
    env.includes("IFOOD_MERCHANT_ID="),

  primary_merchant_is_allowed:
    /function ifoodAllowedMerchantIds\(\)[\s\S]*ifoodPrimaryMerchantId\(\)/.test(server),

  merchant_resolution_without_merchant_api:
    server.includes("async function resolveIfoodMerchantsForSync()") &&
    server.includes('source: "environment"') &&
    server.includes("return fetchAndStoreIfoodMerchants();"),

  polling_uses_resolved_merchant:
    server.includes("const merchants = await resolveIfoodMerchantsForSync();") &&
    server.includes('"x-polling-merchants": merchantIds.join(",")'),

  no_logistics_heartbeat_exclusion:
    !server.includes('url.searchParams.set("excludeHeartbeat", "true")'),

  connection_test_forces_new_token:
    /if \(configuredMerchantId\)[\s\S]*await getIfoodAccessToken\(true\)/.test(server),

  production_ui_exposes_target:
    html.includes("Loja em operação (Merchant ID)") &&
    html.includes("Merchant ID de produção configurado e protegido") &&
    html.includes("ORDER + EVENTS"),

  cache_bumped:
    sw.includes("despachefull-v3.5.6-")
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(JSON.stringify({ result: "FAIL", version: "3.5.6", failed, checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ result: "PASS", version: "3.5.6", checks }, null, 2));
