import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createPerformanceDiagnostics } from "../lib/performance-diagnostics.js";

test("diagnostics is strictly disabled in production regardless of env", async () => {
  const seen = [];
  const perf = createPerformanceDiagnostics({
    appEnv: "production", env: { PERF_DIAGNOSTICS:"true" },
    pool: { totalCount:1, idleCount:1, waitingCount:0 },
    logger: { info:v=>seen.push(v) }
  });
  const req = { method:"POST", path:"/api/login" };
  const res = new EventEmitter();res.statusCode = 200;
  perf.middleware(req,res,()=>{});
  await perf.span(req,"user_lookup",async()=>7);
  perf.transaction({ acquire_ms:1,hold_ms:3,success:true });
  res.emit("finish");
  assert.equal(perf.enabled,false);
  assert.deepEqual(seen,[]);
});

test("staging diagnostics redacts sensitive data and records phases", async () => {
  const seen = [];
  const perf = createPerformanceDiagnostics({
    appEnv: "staging", env: { PERF_DIAGNOSTICS:"true" },
    pool: { totalCount:5,idleCount:2,waitingCount:1 },
    logger: { info:v=>seen.push(v) }
  });
  const req = {
    method:"POST",path:"/api/login",
    body:{password:"sensitive-pwd",username:"sensitive-user"},
    headers:{cookie:"sensitive-cookie"}
  };
  const res = new EventEmitter();res.statusCode=200;
  perf.middleware(req,res,()=>{});
  assert.equal(await perf.span(req,"user_lookup",async()=>42),42);
  await perf.span(req,"bcrypt_compare",async()=>true);
  perf.transaction({ acquire_ms:12.341,hold_ms:45.679,success:true,wait_start:2 });
  res.emit("finish");
  assert.equal(seen.length,2);
  assert.ok(seen.some(x=>x.startsWith("STAGING_PERF_V1 ")));
  assert.ok(seen.some(x=>x.startsWith("STAGING_PERF_TX_V1 ")));
  for (const raw of seen){
    for(const secret of ["sensitive-pwd","sensitive-user","sensitive-cookie"])assert.ok(!raw.includes(secret));
  }
  const obj=JSON.parse(seen.find(x=>x.startsWith("STAGING_PERF_V1 ")).split("STAGING_PERF_V1 ")[1]);
  assert.equal(obj.operation,"login");
  assert.ok(obj.phases_ms.user_lookup>=0);
  assert.ok(obj.phases_ms.bcrypt_compare>=0);
});

test("transaction metrics do not include order IDs, addresses, or credentials", async()=>{
  const seen=[];
  const perf = createPerformanceDiagnostics({appEnv:"staging",env:{PERF_DIAGNOSTICS:"true"},
    pool:{totalCount:2,idleCount:1,waitingCount:0},logger:{info:s=>seen.push(s)}});
  perf.transaction({acquire_ms:23,hold_ms:35,success:false,wait_start:4,
    orderId:"DO-NOT-LOG",address:"DO-NOT-LOG",password:"DO-NOT-LOG"});
  assert.equal(seen.length,1);
  assert.ok(!seen[0].includes("DO-NOT-LOG"));
  assert.equal(JSON.parse(seen[0].split("STAGING_PERF_TX_V1 ")[1]).success,false);
});

