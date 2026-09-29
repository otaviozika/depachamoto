import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const checks = [
  ["iFood recovers stale PROCESSING jobs", server.includes("resetStaleIfoodDispatchJobs") && server.includes("locked_at < NOW() - INTERVAL '3 minutes'")],
  ["iFood stale recovery terminalizes jobs at the retry ceiling", server.includes("const IFOOD_DISPATCH_MAX_ATTEMPTS = 8") && /resetStaleIfoodDispatchJobs[\s\S]{0,1800}WHEN attempts >= \$1 THEN 'FAILED'/.test(server)],
  ["iFood claim refuses jobs at or above the retry ceiling", /claimIfoodDispatchJob[\s\S]{0,1200}const maxAttemptsParam = orderId \? "\$2" : "\$1";[\s\S]{0,800}j\.attempts < \$\{maxAttemptsParam\}/.test(server)],
  ["iFood retry path uses the shared retry ceiling", server.includes("attempts < IFOOD_DISPATCH_MAX_ATTEMPTS")],
  ["iFood worker continuously retries durable jobs", server.includes("setInterval(() => {\n  runIfoodDispatchWorkerOnce()")],
  ["iFood claim uses SKIP LOCKED", server.includes("FOR UPDATE OF j SKIP LOCKED")],
  ["iFood handles ambiguous 409 by reconciling remote state", server.includes("if (Number(err?.statusCode || 0) === 409)") && server.includes("fetchIfoodOrderDetails(job.ifood_order_id)")],
  ["Anota AI recovers stale PROCESSING jobs", server.includes("resetStaleAnotaAiDispatchJobs") && server.includes("processing_started_at < NOW() - INTERVAL '3 minutes'")],
  ["Anota AI stale recovery terminalizes jobs at the retry ceiling", /resetStaleAnotaAiDispatchJobs[\s\S]{0,1800}WHEN attempts >= \$1 THEN 'DEAD'/.test(server)],
  ["Anota AI selection and claim both refuse exhausted jobs", /runAnotaAiDispatchWorkerOnce[\s\S]{0,1800}l\.attempts < \$1[\s\S]{0,1800}AND attempts < \$2/.test(server)],
  ["Anota AI worker invokes stale recovery before claiming", /runAnotaAiDispatchWorkerOnce[\s\S]*await resetStaleAnotaAiDispatchJobs\(\)/.test(server)],
  ["Anota AI retries durable FAILED jobs", server.includes("anotaai_dispatch_status IN ('PENDING','FAILED')")],
  ["Anota AI caps automatic retries", server.includes("const ANOTAAI_DISPATCH_MAX_ATTEMPTS = 8") && server.includes('const nextStatus = retryAllowed ? "FAILED" : "DEAD"')],
  ["Anota AI retry cycles persist in the dispatch link", server.includes("retry_cycle INTEGER NOT NULL DEFAULT 1") && server.includes("ADD COLUMN IF NOT EXISTS retry_cycle INTEGER NOT NULL DEFAULT 1")],
  ["Anota AI DEAD alert key is unique per retry cycle", server.includes('uniqueKey: `anotaai-dispatch-dead:${orderId}:cycle:${cycle}`') && server.includes("unique_key TEXT UNIQUE")],
  ["Anota AI both terminal paths use the cycle-aware notifier", (server.match(/notifyAnotaAiDispatchDead\(\{/g)||[]).length >= 2],
  ["Anota AI manual replay opens exactly one new DEAD cycle", /UPDATE anotaai_dispatch_links[\s\S]{0,500}retry_cycle=retry_cycle\+1[\s\S]{0,500}AND anotaai_dispatch_status='DEAD'[\s\S]{0,120}RETURNING retry_cycle/.test(server)],
  ["Anota AI replay is rejected outside DEAD", server.includes('if (row.anotaai_dispatch_status !== "DEAD")')],
  ["Anota AI dead-letter jobs are terminal until manual replay", server.includes('anotaai_dispatch_status=$2') && server.includes('"ANOTAAI_DISPATCH_DEAD"') && !server.includes("anotaai_dispatch_status IN ('PENDING','FAILED','DEAD')")],
  ["Anota AI reconciles ambiguous remote finalize failures", server.includes("[400,404,409,412].includes(Number(error?.statusCode || 0))") && server.includes("remotelyFinished")],
  ["Anota AI admin replay resets retry budget", /app\.post\("\/api\/admin\/anotaai\/orders\/:id\/retry-dispatch"[\s\S]{0,2200}attempts=0/.test(server) && server.includes('"ANOTAAI_DISPATCH_RETRY_REQUESTED"')],
  ["iFood admin replay resets retry budget", /app\.post\("\/api\/admin\/ifood\/orders\/:id\/retry-dispatch"[\s\S]{0,1800}attempts=0/.test(server)],
  ["External workers run on intervals after restart", server.includes("Anota AI dispatch worker:") && server.includes("iFood dispatch interval:")]
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failures++;
}

if (failures) {
  console.error(`Dispatch recovery self-test failed: ${failures} check(s).`);
  process.exit(1);
}

console.log(`Dispatch recovery self-test passed: ${checks.length}/${checks.length}.`);
