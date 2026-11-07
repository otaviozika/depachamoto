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
console.log(JSON.stringify({result:"PASS",environment:"hosted Render staging",productionTouched:false,
  methods:["GET"],checks:pathResults},null,2));
