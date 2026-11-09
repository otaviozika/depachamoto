// Summarize staging-only, redacted performance telemetry captured during CI.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const path=process.argv[2]||"friday-staging-server.log";
const text=readFileSync(path,"utf8");
const http=[],tx=[];
for(const line of text.split(/\r?\n/)){
  for(const [prefix,to] of [["STAGING_PERF_V1 ",http],["STAGING_PERF_TX_V1 ",tx]]){
    const at=line.indexOf(prefix);
    if(at<0)continue;
    try { to.push(JSON.parse(line.slice(at+prefix.length))); } catch {}
  }
}
function percentile(arr,q){const a=arr.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?Number(a[Math.ceil(a.length*q)-1].toFixed(2)):null}
const grouped=Object.groupBy(http,x=>x.operation);
const ops=Object.fromEntries(Object.entries(grouped).map(([name,items])=>{
  const phases=Object.create(null);
  for(const item of items)for(const [phase,value] of Object.entries(item.phases_ms||{}))
    (phases[phase]??=[]).push(Number(value));
  return [name,{count:items.length,p50_ms:percentile(items.map(x=>x.total_ms),.5),
    p95_ms:percentile(items.map(x=>x.total_ms),.95),p99_ms:percentile(items.map(x=>x.total_ms),.99),
    phase_p95_ms:Object.fromEntries(Object.entries(phases).map(([k,a])=>[k,percentile(a,.95)])),
    pool_waiting_peak:Math.max(0,...items.flatMap(x=>[x.pool_start?.pool_waiting||0,x.pool_end?.pool_waiting||0])),
    non_success:items.filter(x=>x.status>=500).length}];
}));
const report={result:"PASS",environment:"GitHub Actions ephemeral staging",
  http:ops,
  predeparture_tx:{count:tx.length,acquire_p95_ms:percentile(tx.map(x=>x.acquire_ms),.95),
    hold_p95_ms:percentile(tx.map(x=>x.hold_ms),.95),
    acquire_max_ms:tx.length?Math.max(...tx.map(x=>x.acquire_ms)):null,
    waiting_peak:Math.max(0,...tx.map(x=>x.waiting_on_acquire||0)),
    failed_transactions:tx.filter(x=>!x.success).length},
  warning:"Does not measure Render-Oregon to Supabase-Sao-Paulo RTT or actual production Egress"};
console.log("STAGE8_PERFORMANCE_DIAGNOSIS "+JSON.stringify(report));
assert.ok((ops.login?.count||0)>=36,"Expected at least 36 login samples");
assert.ok((ops.predeparture_create?.count||0)>=300,"Expected 300 HTTP predeparture requests");
assert.ok(tx.length>=300,"Expected >=300 predeparture transactions");
