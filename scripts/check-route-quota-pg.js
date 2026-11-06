// PostgreSQL cross-connection quota test; SAFE: use only against local isolated staging.
import assert from "node:assert/strict";
import pg from "pg";
import { reserveRouteMatrixBudget,withRouteMatrixBudget,ROUTE_MATRIX_BUDGET } from "../lib/route-quota.js";

const url=new URL(String(process.env.DATABASE_URL || ""));
if(process.env.APP_ENV!=="staging"||process.env.STAGING_SAFE_MODE!=="true"||
  process.env.LOAD_TEST_CONFIRM!=="STAGING_ONLY_I_UNDERSTAND" ||
  !["localhost","127.0.0.1"].includes(url.hostname))
  throw new Error("Quota test blocked outside isolated staging");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:15});
const scope="SYNTHETIC_QUOTA_TEST";
const now=new Date("2026-11-06T12:00:00Z");
try{
  assert.equal(ROUTE_MATRIX_BUDGET.perMinute,38);
  assert.equal(ROUTE_MATRIX_BUDGET.perDay,450);
  const first=await Promise.all(Array.from({length:36},()=>reserveRouteMatrixBudget(pool,{scope,perMinute:38,perDay:450,at:now})));
  assert.equal(first.filter(x=>x.ok).length,36,"36 simultaneous requests pass in one minute");
  // 12 concurrent DB clients competing for the same scope; at most 38 total.
  const second=await Promise.all(Array.from({length:12},()=>reserveRouteMatrixBudget(pool,{scope,perMinute:38,perDay:450,at:now})));
  assert.equal(second.filter(x=>x.ok).length,2);
  assert.equal(second.filter(x=>x.reason==="MINUTE").length,10);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM route_matrix_quota_ledger WHERE scope=$1",[scope])).rows[0].n),38);
  const later=new Date(now.getTime()+60_100);
  const resumed=await reserveRouteMatrixBudget(pool,{scope,perMinute:38,perDay:450,at:later});
  assert.equal(resumed.ok,true,"sliding window resumes after 60s");
  const shifted=new Date(now.getTime()+90_000);
  const simulated=await Promise.all(Array.from({length:61},(_,i)=>reserveRouteMatrixBudget(pool,{
    scope,perMinute:100,perDay:45,at:shifted
  })));
  // This scope has 39 prior calls + 6 = 45, then must reject all the rest.
  assert.equal(simulated.filter(x=>x.ok).length,6);
  assert.equal(simulated.filter(x=>x.reason==="DAILY").length,55);
  const nextDay=new Date("2026-11-07T12:00:00Z");
  const reset=await reserveRouteMatrixBudget(pool,{scope,perMinute:38,perDay:450,at:nextDay});
  assert.equal(reset.ok,true,"UTC quota day resets");
  let providerCalls=0;
  const shortScope="SYNTHETIC_FAILSAFE";
  const failOnce=await withRouteMatrixBudget(pool,async()=>{providerCalls++;throw Object.assign(new Error("fake 503"),{code:"ROUTES_SERVICE_FAILED"})},{scope:shortScope,perMinute:1,perDay:2,maxQueueWaitMs:0,at:now}).catch(e=>e);
  assert.equal(failOnce.code,"ROUTES_SERVICE_FAILED");
  assert.equal(providerCalls,1);
  const next=await withRouteMatrixBudget(pool,async()=>{providerCalls++},{scope:shortScope,perMinute:1,perDay:2,maxQueueWaitMs:0,at:now}).catch(e=>e);
  assert.equal(next.code,"ROUTES_RATE_LIMITED_LOCAL");
  assert.equal(providerCalls,1,"failed provider calls must keep reservation");
  const report={result:"PASS",concurrent_first:36,concurrent_second_allowed:2,
    concurrent_second_throttled:10,utc_reset:true,sliding_window:true,
    daily_budget_rejected:55,failed_provider_call_counted:true,production_database_access:false};
  console.log("ORS_GLOBAL_QUOTA_TEST_START");
  console.log(JSON.stringify(report,null,2));
  console.log("ORS_GLOBAL_QUOTA_TEST_END");
}finally{await pool.end().catch(()=>{});}
