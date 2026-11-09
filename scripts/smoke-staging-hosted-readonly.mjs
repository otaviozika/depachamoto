/**
 * Hosted STAGING read-only smoke. All requests are GET.
 * NEVER point this at production; the origin is hardcoded intentionally.
 */
import assert from "node:assert/strict";
const BASE = "https://despachefull-staging.onrender.com";
const pathResults = [];
async function get(path) {
  let last;
  for(let attempt=1;attempt<=4;attempt++){
    try {
      const r=await fetch(BASE+path,{method:"GET",redirect:"error",
        headers:{"accept":"application/json","x-despachefull-smoke":"staging-readonly"},
        signal:AbortSignal.timeout(20000)});
      const data=await r.json().catch(()=>null);
      const result={path,status:r.status,data};
      if(r.status===502||r.status===503||r.status===504){last=new Error(path+": HTTP "+r.status);await new Promise(resolve=>setTimeout(resolve,2000*attempt));continue;}
      return result;
    }catch(e){last=e;if(attempt<4)await new Promise(resolve=>setTimeout(resolve,2000*attempt));}
  }
  throw new Error("Staging GET "+path+" unavailable: "+(last?.message||"unknown"));
}
const live=await get("/api/live");
assert.equal(live.status,200,"/api/live must be HTTP 200");
assert.equal(live.data?.ok,true);
pathResults.push({path:live.path,status:live.status,ok:true});

const health=await get("/api/health");
assert.equal(health.status,200,"/api/health must be HTTP 200");
assert.equal(health.data?.ok,true);
assert.equal(health.data?.database,"connected","staging DB must be connected");
assert.equal(health.data?.environment,"staging","staging only");
assert.equal(health.data?.stagingSafeMode,true,"external mutation shield must be enabled");
assert.equal(health.data?.externalMutationsAllowed,false,"no live mutation");
assert.equal(health.data?.ifood?.eventSyncEnabled,false,"iFood auto sync must be off");
assert.equal(health.data?.ifood?.dispatchFlagEnabled,false,"iFood dispatch must be off");
assert.equal(health.data?.anotaai?.automaticSyncEnabled,false,"AnotaAI auto sync must be off");
pathResults.push({path:health.path,status:health.status,ok:true,dbLatencyMs:health.data.dbLatencyMs,
  environment:health.data.environment,stagingSafeMode:health.data.stagingSafeMode,
  externalMutationsAllowed:health.data.externalMutationsAllowed});

const config=await get("/api/public/config");
assert.equal(config.status,200,"public staging config");
assert.equal(config.data?.environment,"staging");
assert.equal(config.data?.stagingSafeMode,true);
pathResults.push({path:config.path,status:config.status,ok:true});

for(const path of ["/api/admin/delivery-incidents","/api/admin/pre-departure/overview","/api/courier/pre-departure"]){
  const r=await get(path);
  assert.ok([401,403].includes(r.status),path+" must reject anonymous access, got "+r.status);
  pathResults.push({path:r.path,status:r.status,authProtected:true});
}
// Live hosted Render baseline: 40 independent read-only request streams.
// Ramp 5/15/30/40. No courier accounts, no dispatch, no real provider traffic.
// Fail closed if /api/health does not identify the isolated staging service.
const waves=[5,15,30,40];
const latencySamples=[];
const waveReports=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function percentile(nums,q){
  const a=[...nums].sort((a,b)=>a-b);
  return a.length?Number(a[Math.ceil(a.length*q)-1].toFixed(2)):null;
}
function aggregate(requests){
  const durations=requests.map(x=>x.ms);
  return {requests:requests.length,p50_ms:percentile(durations,.5),
    p95_ms:percentile(durations,.95),p99_ms:percentile(durations,.99),
    max_ms:durations.length?Number(Math.max(...durations).toFixed(2)):null,
    errors:requests.filter(x=>!x.ok).length,
    status_codes:Object.fromEntries([...new Set(requests.map(x=>x.status))].map(code=>
      [String(code),requests.filter(x=>x.status===code).length]))};
}
async function sample(path){
  const start=performance.now();let status=0,ok=false,error=null,dbLatencyMs=null;
  try{
    const response=await fetch(BASE+path,{
      method:"GET",redirect:"error",
      headers:{"accept":"application/json","cache-control":"no-store",
        "x-despachefull-smoke":"staging-readonly-40-bounded"},
      signal:AbortSignal.timeout(15000)
    });
    status=response.status;
    const value=await response.json().catch(()=>null);
    if(status!==200)throw Error("HTTP "+status);
    if(value?.ok!==true)throw Error("response not healthy");
    if(path==="/api/health"){
      if(value?.environment!=="staging"||value?.stagingSafeMode!==true||
         value?.externalMutationsAllowed!==false||value?.database!=="connected")
        throw Error("staging isolation/DB health failed");
      dbLatencyMs=value.dbLatencyMs;
    }
    ok=true;
  }catch(e){error=String(e?.name||"ERROR")+": "+String(e?.message||e).slice(0,120);}
  const row={path,ms:Number((performance.now()-start).toFixed(2)),status,ok,
    ...(dbLatencyMs===null?{}:{dbLatencyMs}),...(error?{error}:{})};
  latencySamples.push(row);
  return row;
}
const baselineHealth=await sample("/api/health");
const baselineLive=await sample("/api/live");
assert.ok(baselineHealth.ok && baselineLive.ok,
  "Refuse load: staging baseline is unhealthy");
for(const n of waves){
  // Two small GETs per virtual courier; no sessions or mutation endpoints.
  const begin=performance.now();
  const results=await Promise.all(Array.from({length:n},async()=>{
    const health=await sample("/api/health");
    // Stop this stream on error so it cannot amplify a struggling service.
    if(!health.ok)return [health];
    return [health,await sample("/api/live")];
  }));
  const requests=results.flat();
  const health=requests.filter(x=>x.path==="/api/health");
  const live=requests.filter(x=>x.path==="/api/live");
  const summary={concurrent_clients:n,elapsed_ms:Number((performance.now()-begin).toFixed(2)),
    health:aggregate(health),live:aggregate(live),
    db_latency_p95_ms:percentile(health.map(x=>x.dbLatencyMs).filter(x=>Number.isFinite(x)),.95),
    first_errors:requests.filter(x=>!x.ok).slice(0,3).map(x=>({path:x.path,status:x.status,message:x.error}))};
  waveReports.push(summary);
  console.log("HOSTED_STAGING_READONLY_WAVE "+JSON.stringify(summary));
  if(summary.health.errors||summary.live.errors)
    throw Error("Stop ramp: "+n+"-client stage had failed requests");
  if(summary.health.p95_ms>10000||summary.live.p95_ms>10000)
    throw Error("Stop ramp: "+n+"-client stage exceeded 10s p95");
  await sleep(750);
}
const after=await sample("/api/health");
assert.ok(after.ok,"Staging health did not recover at end");
const loadReport={result:"PASS",environment:"hosted Render staging",read_only:true,
  synthetic_clients:40,requests:latencySamples.length,waves:waveReports,
  full_run:aggregate(latencySamples),health_after:after.ok,
  productionTouched:false,createdAccounts:0,createdDispatches:0,
  externalIntegrationWrites:0,
  caveats:["Unprivileged health/live GETs only; not 40 authenticated mobile sessions",
    "The test samples current hosted resources; not equivalent to a real 600-order rush",
    "Service is Render Free and may have cold starts"]};
console.log("HOSTED_STAGING_READONLY_40_PASS "+JSON.stringify(loadReport));

console.log(JSON.stringify({result:"PASS",environment:"hosted Render staging",productionTouched:false,
  methods:["GET"],checks:pathResults},null,2));
