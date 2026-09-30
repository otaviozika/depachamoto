import fs from "node:fs";
import { execFileSync } from "node:child_process";

const load=fs.readFileSync("scripts/loadtest-staging-50.js","utf8");
const orchestrator=fs.readFileSync("scripts/loadtest-48-orchestrator.js","utf8");
const server=fs.readFileSync("server.js","utf8");
const workflow=fs.readFileSync(".github/workflows/staging-gate.yml","utf8");

const results=[];
function check(name,ok){
  results.push({name,ok:Boolean(ok)});
  if(!ok) console.error("FAIL - "+name);
  else console.log("PASS - "+name);
}

try{
  execFileSync(process.execPath,["--check","scripts/loadtest-staging-50.js"],{stdio:"pipe"});
  check("load-script-syntax",true);
}catch{check("load-script-syntax",false)}
try{
  execFileSync(process.execPath,["--check","scripts/loadtest-48-orchestrator.js"],{stdio:"pipe"});
  check("orchestrator-syntax",true);
}catch{check("orchestrator-syntax",false)}

check("l1-fixed-20-couriers",load.includes("COURIERS!==20"));
check("l1-64-departures",load.includes("L1_TOTAL_DEPARTURES = 64"));
check("l1-48-normal-16-peak",load.includes("L1_NORMAL_DEPARTURES = 48")&&load.includes("L1_PEAK_DEPARTURES = 16"));
check("l1-15-minute-phases",load.includes("L1_RAMP_MS = 2 * 60 * 1000")&&load.includes("L1_NORMAL_MS = 10 * 60 * 1000")&&load.includes("L1_PEAK_MS = 2 * 60 * 1000")&&load.includes("L1_DRAIN_MS = 60 * 1000"));
check("generator-pool-max-2",load.includes('max: LEVEL === "L1" ? 2 : 15'));
check("no-admin-release-in-load",!load.includes("/release"));
check("dashboard-only-realistic-endpoint",load.includes('/api/admin/dashboard')&&!load.includes('/api/admin/peak')&&!load.includes('/api/admin/history?page=1&page_size=25')&&!load.includes('/api/admin/conflicts?limit=30'));
check("explicit-request-timeout",load.includes("AbortSignal.timeout(REQUEST_TIMEOUT_MS)"));
check("integrity-pending-until-audit",load.includes('integrity:"PENDENTE"'));
check("preseed-before-baseline",load.indexOf("await seedL1Orders();")<load.indexOf('sampleHealth("BASELINE")'));
check("performance-thresholds-frozen",load.includes("dispatch.p50>300")&&load.includes("dispatch.p95>1000")&&load.includes("dispatch.p99>2000"));
check("pool-waiting-sustained-rule",load.includes("maxConsecutiveWaiting>=3"));
check("cleanup-before-final-report",load.lastIndexOf("await cleanup();")<load.lastIndexOf("writeReport(finalReport)"));
check("orchestrator-l1-only",orchestrator.includes('requestedLevel!=="L1"')&&!orchestrator.includes('level:"L2"'));
check("orchestrator-preserves-failure-evidence",orchestrator.includes("...last,active:false,state:\"FALHOU\""));
check("hosted-gate-pool-matches-staging",workflow.includes('DB_POOL_MAX: "10"'));

const retStart=server.indexOf("async function completeDispatchReturn");
const retEnd=server.indexOf("\nasync function",retStart+30);
const ret=server.slice(retStart,retEnd>retStart?retEnd:retStart+6000);
check("return-releases-pool-before-best-effort",ret.indexOf("client.release();")<ret.indexOf("await auditBestEffort"));

const txStart=server.indexOf("async function createDispatchTransaction");
const txEnd=server.indexOf("\nasync function",txStart+30);
const tx=server.slice(txStart,txEnd>txStart?txEnd:txStart+18000);
check("idempotency-after-courier-advisory-lock",tx.indexOf("pg_advisory_xact_lock")<tx.indexOf("WHERE d.client_token=$1"));
check("idempotency-scoped-to-courier",server.includes("WHERE d.client_token=$1 AND d.courier_id=$2 AND d.registration_source='COURIER'"));
check("idempotency-payload-mismatch-protected",server.includes("IDEMPOTENCY_TOKEN_MISMATCH"));
check("event-loop-lag-in-health",server.includes("eventLoopLagMs"));

const failed=results.filter(x=>!x.ok);
console.log(JSON.stringify({checks:results.length,passed:results.length-failed.length,failed:failed.map(x=>x.name)},null,2));
if(failed.length)process.exit(1);
