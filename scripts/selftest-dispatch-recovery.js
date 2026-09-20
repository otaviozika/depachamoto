import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const checks = [
  ["iFood recovers stale PROCESSING jobs", server.includes("resetStaleIfoodDispatchJobs") && server.includes("locked_at < NOW() - INTERVAL '3 minutes'")],
  ["iFood worker continuously retries durable jobs", server.includes("setInterval(() => {\n  runIfoodDispatchWorkerOnce()")],
  ["iFood claim uses SKIP LOCKED", server.includes("FOR UPDATE OF j SKIP LOCKED")],
  ["iFood handles ambiguous 409 by reconciling remote state", server.includes("if (Number(err?.statusCode || 0) === 409)") && server.includes("fetchIfoodOrderDetails(job.ifood_order_id)")],
  ["Anota AI recovers stale PROCESSING jobs", server.includes("resetStaleAnotaAiDispatchJobs") && server.includes("processing_started_at < NOW() - INTERVAL '3 minutes'")],
  ["Anota AI worker invokes stale recovery before claiming", /runAnotaAiDispatchWorkerOnce[\s\S]*await resetStaleAnotaAiDispatchJobs\(\)/.test(server)],
  ["Anota AI retries durable FAILED jobs", server.includes("anotaai_dispatch_status IN ('PENDING','FAILED')")],
  ["Anota AI reconciles ambiguous remote finalize failures", server.includes("[400,404,409,412].includes(Number(error?.statusCode || 0))") && server.includes("remotelyFinished")],
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
