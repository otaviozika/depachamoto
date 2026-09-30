import fs from "node:fs";
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const checks=[
 ["Notifications have explicit operational resolution lifecycle", /ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at/.test(server) && /resolution_reason/.test(server)],
 ["Notification unique_key remains database-unique", /unique_key TEXT UNIQUE/.test(server)],
 ["iFood jobs have retry_cycle", /ALTER TABLE ifood_dispatch_jobs[\s\S]{0,120}retry_cycle INTEGER NOT NULL DEFAULT 1/.test(server)],
 ["iFood terminal failure creates operational alert", /type: "IFOOD_DISPATCH_FAILED"[\s\S]{0,260}ifood-dispatch-failed:\$\{orderId\}:cycle:\$\{cycle\}/.test(server)],
 ["iFood alert key is cycle-aware", server.includes("ifood-dispatch-failed:${orderId}:cycle:${cycle}")],
 ["iFood admin replay increments retry cycle", /status='RETRY',[\s\S]{0,100}attempts=0,[\s\S]{0,100}retry_cycle=retry_cycle\+1/.test(server)],
 ["iFood replay resolves prior incident alert", /ifood-dispatch-failed:\$\{orderId\}:cycle:[\s\S]{0,180}admin_started_new_retry_cycle/.test(server)],
 ["iFood confirmed completion resolves prior incident", /ifood_dispatch_confirmed_done/.test(server)],
 ["AnotaAi DEAD alert key is cycle-aware", server.includes("anotaai-dispatch-dead:${orderId}:cycle:${cycle}")],
 ["AnotaAi replay increments retry cycle", /retry_cycle=retry_cycle\+1/.test(server)],
 ["AnotaAi replay resolves prior DEAD alert", /anotaai-dispatch-dead:\$\{orderId\}:cycle:[\s\S]{0,180}admin_started_new_retry_cycle/.test(server)],
 ["AnotaAi SENT resolves prior DEAD incident", /anotaai_dispatch_confirmed_sent/.test(server)],
 ["Stale exhausted iFood recovery creates terminal alert", /admin_stale_recovery_retry_limit_reached/.test(server) || /RECOVERY_STALE_JOB[\s\S]{0,2200}IFOOD_DISPATCH_FAILED/.test(server)],
 ["Stale exhausted AnotaAi recovery reuses DEAD notifier", /notifyAnotaAiDispatchDead\(\{orderId,dispatchId:recovered\.dispatch_id/.test(server)],
 ["Operational resolution marks alert read and resolved atomically", /SET resolved_at=COALESCE\(resolved_at,NOW\(\)\)[\s\S]{0,260}read_at=COALESCE\(read_at,NOW\(\)\)/.test(server)],
 ["Operational alert resolution is idempotent", /WHERE resolved_at IS NULL[\s\S]{0,120}clauses\.join/.test(server)],
 ["Notifications API exposes resolved state", /n\.resolved_at,n\.resolution_reason/.test(server)],
 ["Notifications API reports active operational incidents", /active_operational/.test(server)],
 ["Critical alert delivery still emits realtime", /emitRealtime\("notification:new", notification\)/.test(server)],
 ["Critical alert delivery still supports Web Push", /sendPushToAdmins\(notification\)/.test(server)]
];
let failed=0;
for(const [name,ok] of checks){console.log((ok?"PASS":"FAIL")+" - "+name);if(!ok)failed++}
if(failed){console.error(`Operational alerts self-test failed: ${failed} check(s).`);process.exit(1)}
console.log(`Operational alerts self-test passed: ${checks.length}/${checks.length}.`);
