import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = [
  ["Health Center API exists", server.includes('app.get("/api/admin/health-center"')],
  ["Health Center checks iFood terminal and stale jobs", server.includes("COUNT(*) FILTER (WHERE status='FAILED')") && server.includes("locked_at < NOW()-INTERVAL '3 minutes'")],
  ["Health Center checks Anota AI DEAD and stale jobs", server.includes("COUNT(*) FILTER (WHERE anotaai_dispatch_status='DEAD')") && server.includes("processing_started_at < NOW()-INTERVAL '3 minutes'")],
  ["Health Center checks sync freshness", server.includes("ifoodSyncStale") && server.includes("anotaSyncStale") && server.includes("> 120")],
  ["Health Center checks system errors and database pressure", server.includes("errors.last1h") && server.includes("pool.waitingCount") && server.includes("dbLatencyMs > 250")],
  ["Health Center checks conflicts", server.includes("critical_open") && server.includes("warning_open")],
  ["Health Center excludes historical locks from active alerts", server.includes("ADMIN_PENDING_DELIVERIES_OVERRIDE") && server.includes("NOT IN ('ADMIN_PENDING_DELIVERIES_OVERRIDE','LEGACY')")],
  ["Health Center exposes direct recovery actions", server.includes('action: terminal ? "RETRY_IFOOD"') && server.includes('action: terminal ? "RETRY_ANOTAAI"')],
  ["Health Center UI replaces the old safety-only card", html.includes("Central de Saúde e Exceções") && html.includes('id="healthCenterOverall"') && html.includes('id="healthExceptions"')],
  ["Health Center keeps iFood production protections", html.includes('id="ifoodSafetyChecklist"') && html.includes('id="ifoodMerchantSafety"')],
  ["Health Center can retry both integrations", html.includes("retryIfoodFromHealth") && html.includes("retryAnotaAiFromHealth")],
  ["Health Center can resolve operational conflicts", html.includes("resolveConflictFromHealth")],
  ["Health Center refreshes from realtime integration events", html.includes("queueRealtimeRefresh('health-center'") && html.includes("socket.on('anotaai:changed'")],
  ["Health Center active polling is scoped to the open page", html.includes("loadHealthCenter({silent:true})") && html.includes("!$('ifood')?.classList.contains('active')") && html.includes("},30000);")]
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failures++;
}

if (failures) {
  console.error(`Health Center self-test failed: ${failures} check(s).`);
  process.exit(1);
}

console.log(`Health Center self-test passed: ${checks.length}/${checks.length}.`);
