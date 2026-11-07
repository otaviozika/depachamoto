/**
 * One-time staged 40-courier / 600-synthetic-order capacity test.
 * Uses real Render web instance and isolated PostgreSQL (no external providers).
 * HTTP sessions/auth/read-only probes + concurrent real pre-departure service logic.
 * The app_settings feature flags are NEVER changed. No real dispatches are created.
 *
 * Temporary staging startup: node scripts/staging-hosted-capacity-40.js --launch
 * Restore package.json start = "node server.js" after seeing the result.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import bcrypt from "bcryptjs";
import pg from "pg";
import { createPreDepartureService } from "../lib/pre-departure-service.js";

const EXPECTED_DB="despachefull_incidentes_homologacao";
const DB_TAG="dbn9n1psrm7s738pu81g";
const PREFIX="stage5-cap-"+randomBytes(5).toString("hex");
const N=40, WAVES=3, PER_WAVE=5, EXPECTED_ORDERS=N*WAVES*PER_WAVE;
const deadline=Date.now()+4*60*1000;
const env=process.env;
const dbUrl=new URL(String(env.DATABASE_URL||""));
function guard(){
  assert.equal(env.APP_ENV,"staging","FORBIDDEN: not staging");
  assert.equal(env.STAGING_SAFE_MODE,"true","FORBIDDEN: safe mode missing");
  assert.equal(decodeURIComponent(dbUrl.pathname.slice(1)),EXPECTED_DB,"FORBIDDEN: wrong database");
  assert.ok(dbUrl.hostname.includes(DB_TAG),"FORBIDDEN: non-isolated PostgreSQL");
  assert.ok(!["prod","production"].includes(String(env.APP_ENV).toLowerCase()));
}
guard();
const port=Number(env.PORT||3000);
assert.ok(Number.isInteger(port)&&port>0);
const host="http://127.0.0.1:"+port;
const round=v=>Number(v.toFixed(1));
function quantile(a,q) {
  const x=a.slice().sort((l,r)=>l-r);
  return x.length?round(x[Math.min(x.length-1,Math.floor((x.length-1)*q))]):null;
}
const stats={};
function record(name,ms,code) {
  const x=stats[name]||(stats[name]={duration:[],status:{}});
  x.duration.push(ms);
  x.status[String(code||"ok")]=(x.status[String(code||"ok")]||0)+1;
}
async function timed(name,cb) {
  const start=performance.now();
  try {
    const ret=await cb();
    record(name,performance.now()-start,"ok");
    return ret;
  } catch(e) {
    record(name,performance.now()-start,e?.code||"ERROR");
    throw e;
  }
}
const report={
  kind:"HOSTED_RENDER_40_COURIERS_600_SYNTHETIC",
  status:"RUNNING",target:{couriers:N,waves:WAVES,ordersPerWave:PER_WAVE,totalOrders:EXPECTED_ORDERS},
  counts:{couriers:0,seededOrders:0,predepartures:0,checks:0,computedRoutes:0,
    blockedEarlyDepartures:0,idempotentDrafts:0,preparedDispatches:0,cancelledDrafts:0},
  http:{},engine:{},failures:[],safety:{environment:"staging",externalProviderRequests:0,
    featureFlagsModified:false,productionTouched:false,realCustomersUsed:false,dispatchesCreated:0},
  cleanup:{status:"NOT_STARTED"}
};
const created={users:[],orders:[],pre:[]};
const indexByUser=new Map();
const errors=[];
const password=randomBytes(40).toString("base64url");
const passwordHash=await bcrypt.hash(password,10);
const sampler={peakRss:0,peakHeap:0,peakDbConnections:0,peakPoolTotal:0,peakPoolWaiting:0};
let timer=null;
const loop=monitorEventLoopDelay({resolution:20});
let pool=null,origin=null;
const startedAt=performance.now();
function checkDeadline(){
  if(Date.now()>deadline)throw Object.assign(new Error("Safety timeout after 4 minutes"),{code:"STAGING_CAPACITY_DEADLINE"});
}
async function req(path,options={}) {
  const start=performance.now();
  let res;
  try{
    res=await fetch(host+path,{...options,
      headers:{"content-type":"application/json","x-forwarded-proto":"https",...(options.headers||{})},
      signal:AbortSignal.timeout(30000)});
    const obj=await res.json().catch(()=>({}));
    record("HTTP "+(options.method||"GET")+" "+path,performance.now()-start,res.status);
    return {status:res.status,body:obj,cookie:(res.headers.get("set-cookie")||"").split(";")[0]};
  }catch(e){
    record("HTTP "+(options.method||"GET")+" "+path,performance.now()-start,e?.name||"ERROR");
    throw e;
  }
}
function asExpected(result,status,label){
  assert.equal(result.status,status,label+" HTTP "+result.status+" expected "+status+" ("+String(result.body?.code||result.body?.error||"").slice(0,80)+")");
}
function describeOrder(_platform,payload){
  const p=typeof payload==="string"?JSON.parse(payload):payload;
  const a=p?.deliveryAddress||{};
  const pin=a.coordinates||{};
  return {navigation:{latitude:pin.latitude,longitude:pin.longitude,address:"TESTE SINTETICO - NAO ENTREGAR",address_complete:true},
    fields:{street:"Rua Ficticia",number:String(a.streetNumber||"100"),
      neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP"},customer_name:"CLIENTE SINTETICO"};
}
async function setup(){
  checkDeadline();
  pool=new pg.Pool({connectionString:env.DATABASE_URL,
    ssl:env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,
    max:Math.min(6,Number(env.DB_POOL_MAX)||10),
    connectionTimeoutMillis:7000,idleTimeoutMillis:30000});
  const db=await pool.query("SELECT current_database() AS db");
  assert.equal(db.rows[0]?.db,EXPECTED_DB);
  const health=await req("/api/health");
  asExpected(health,200,"health");
  assert.equal(health.body.environment,"staging");
  assert.equal(health.body.stagingSafeMode,true);
  assert.equal(health.body.externalMutationsAllowed,false);
  assert.equal(health.body.ifood?.eventSyncEnabled,false);
  assert.equal(health.body.anotaai?.automaticSyncEnabled,false);
  const current=await pool.query("SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [["pre_departure_enabled","route_planner_enabled","address_correction_enabled","delivery_incidents_enabled"]]);
  report.settingsBefore=Object.fromEntries(current.rows.map(x=>[x.setting_key,x.setting_value]));
  assert.notEqual(report.settingsBefore.route_planner_enabled,"true","Safety: automatic route already active");
  const saved=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='route_store_origin'");
  assert.equal(saved.rowCount,1);
  origin=JSON.parse(saved.rows[0].setting_value);
  assert.equal(origin.source,"ADMIN_CONFIRMED");
  loop.enable();
  timer=setInterval(()=>{
    const m=process.memoryUsage();
    sampler.peakRss=Math.max(sampler.peakRss,m.rss);
    sampler.peakHeap=Math.max(sampler.peakHeap,m.heapUsed);
    sampler.peakPoolTotal=Math.max(sampler.peakPoolTotal,pool.totalCount);
    sampler.peakPoolWaiting=Math.max(sampler.peakPoolWaiting,pool.waitingCount);
  },250);
  timer.unref();
}
async function seed(){
  checkDeadline();
  // 40 unique accounts, all credentials randomized and never printed.
  for(let i=0;i<N;i++){
    const username=PREFIX+"-c"+i;
    const u=await pool.query("INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',true,false) RETURNING id",
      ["CAPACITY SYNTHETIC "+i,username,passwordHash]);
    const id=Number(u.rows[0].id);
    created.users.push(id);
    indexByUser.set(i,{id,username});
  }
  // One SQL insert for the 600 entirely artificial orders (no platform network).
  const ids=[],displays=[],payloads=[];
  const runDigits=Number.parseInt(PREFIX.split("-").at(-1).slice(0,4),16);
  for(let wave=0;wave<WAVES;wave++){
    for(let c=0;c<N;c++){
      for(let k=0;k<PER_WAVE;k++){
        const i=((wave*N+c)*PER_WAVE+k);
        const orderId=PREFIX+"-order-"+i;
        const display=String(81000000+((runDigits*601+i)%17000000));
        const lat=Number(origin.latitude)+(c-20)*0.000018+(wave-1)*0.00008+(k-2)*0.000015;
        const lon=Number(origin.longitude)+(c-20)*0.000013+(wave-1)*0.000065+(k-2)*0.00001;
        ids.push(orderId);displays.push(display);
        payloads.push(JSON.stringify({deliveryAddress:{streetName:"Rua Ficticia",
          streetNumber:String(100+i),neighborhood:"Barcelona",city:"Sao Caetano do Sul",
          state:"SP",coordinates:{latitude:lat,longitude:lon}},
          customer:{name:"CLIENTE SINTETICO - NAO ENTREGAR"}}));
      }
    }
  }
  created.orders.push(...ids);
  const inserted=await pool.query(
    "INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) "+
    "SELECT o,$2::text,d,'READY','DELIVERY',NOW()-INTERVAL '18 minutes',NOW(),p,'CLIENTE SINTETICO' "+
    "FROM UNNEST($1::text[],$3::text[],$4::jsonb[]) AS t(o,d,p)",
    [ids,PREFIX,displays,payloads]);
  assert.equal(inserted.rowCount,EXPECTED_ORDERS);
  report.counts.couriers=N;
  report.counts.seededOrders=inserted.rowCount;
}
async function httpSessions(){
  // Real HTTP authentication and 40 parallel courier reads, with all requests awaited
  // before any cleanup. Never assume the staging feature flags are disabled.
  const users=Array.from(indexByUser.values());
  const cookies=new Map();
  for(let i=0;i<users.length;i+=8){
    const responses=await Promise.allSettled(users.slice(i,i+8).map(async u=>{
      const a=await req("/api/login",{method:"POST",body:JSON.stringify({username:u.username,password})});
      asExpected(a,200,"courier-login");
      assert.ok(a.cookie.startsWith("connect.sid="),"Missing session cookie");
      cookies.set(u.id,a.cookie);
    }));
    const failures=responses.filter(x=>x.status==="rejected");
    assert.equal(failures.length,0,"Login batch has "+failures.length+" failures");
  }
  report.http.authenticatedCouriers=cookies.size;
  const responses=await Promise.allSettled(users.map(async u=>{
    const cookie=cookies.get(u.id);
    const o=await req("/api/courier/pre-departure",{headers:{cookie}});
    asExpected(o,200,"courier-read");
    assert.equal(o.body.enabled?.pre_departure,report.settingsBefore.pre_departure_enabled==="true",
      "Staging feature state mismatch");
    return {id:u.id,enabled:o.body.enabled?.pre_departure};
  }));
  const failed=responses.map((x,i)=>({i,x})).filter(o=>o.x.status==="rejected");
  report.http.concurrentReadFailures=failed.length;
  report.http.concurrentReadSuccesses=responses.length-failed.length;
  if(failed.length){
    report.http.failureDetails=failed.slice(0,6).map(o=>({index:o.i,
      reason:String(o.x.reason?.message||"error").slice(0,150)}));
    throw new Error("Concurrent authenticated read failures: "+failed.length+"/"+N);
  }
  // No POST needed for the enabled feature: do not change actual staging operation.
  // If disabled, assert it fails closed before any user/order mutation.
  if(report.settingsBefore.pre_departure_enabled!=="true"){
    const rejections=await Promise.allSettled(users.map(async u=>{
      const x=await req("/api/courier/pre-departures",{
        method:"POST",headers:{cookie:cookies.get(u.id)},
        body:JSON.stringify({order_numbers:["#99999999"],order_count:1})});
      asExpected(x,409,"fail-closed-disabled");
      assert.equal(x.body.code,"FEATURE_DISABLED");
    }));
    assert.equal(rejections.filter(x=>x.status==="rejected").length,0,
      "Fail-closed HTTP check failed");
    report.http.disabledFeatureRejections=N;
  } else report.http.disabledFeatureRejections=0;
  report.http.authenticatedReads=N;
}
const service=()=>createPreDepartureService({pool,describeOrder,env,
  routesClientFactory:()=>{throw new Error("ERROR: external Matrix calls forbidden in capacity test");},
  audit:async()=>{},emitRealtime:()=>{}});
let srv=null;
async function runOne(courier,wave){
  checkDeadline();
  const user=indexByUser.get(courier);
  const links=Array.from({length:PER_WAVE},(_,k)=>{
    const i=(wave*N+courier)*PER_WAVE+k;
    const display=String(81000000+((Number.parseInt(PREFIX.split("-").at(-1).slice(0,4),16)*601+i)%17000000));
    return {platform:"anotaai",order_id:PREFIX+"-order-"+i,order_number:"#"+display};
  });
  const begin=performance.now();
  const pd=await timed("create-predeparture",()=>srv.create({courierId:user.id,links}));
  created.pre.push(pd.id);
  assert.equal(pd.counts.total,PER_WAVE);
  report.counts.predepartures++;
  const again=await timed("idempotent-predeparture",()=>srv.create({courierId:user.id,links}));
  assert.equal(again.id,pd.id);assert.equal(again.duplicate,true);
  report.counts.idempotentDrafts++;
  await assert.rejects(()=>srv.prepareDispatch({courierId:user.id,id:pd.id,compositionVersion:pd.composition_version}),
    e=>e.status===409&&/CHECK_PENDING|PRE_DEPARTURE_CHECK_PENDING/.test(e.code||""));
  report.counts.blockedEarlyDepartures++;
  let fresh=pd;
  for(const o of pd.orders){
    fresh=await timed("confirm-bag",()=>srv.setCheck({courierId:user.id,id:pd.id,orderId:o.id,
      compositionVersion:pd.composition_version,checked:true}));
    report.counts.checks++;
  }
  assert.equal(fresh.counts.checked,PER_WAVE);
  const ready=await timed("compute-manual-order",()=>srv.computeRoute(pd.id,{courierId:user.id}));
  assert.equal(ready.status,"ROUTE_READY");
  assert.equal(ready.route?.source,"TYPED_ORDER","Budget mode must avoid ORS calls");
  assert.equal(ready.can_dispatch,true);
  report.counts.computedRoutes++;
  const prepared=await timed("prepare-dispatch",()=>srv.prepareDispatch({courierId:user.id,id:pd.id,compositionVersion:pd.composition_version}));
  assert.equal(prepared.order_numbers.length,PER_WAVE);
  report.counts.preparedDispatches++;
  const close=await timed("cancel-synthetic-predeparture",()=>srv.cancel({actorUserId:user.id,
    courierId:user.id,id:pd.id,reason:"Synthetic capacity test completed"}));
  assert.equal(close.status,"CANCELLED");
  report.counts.cancelledDrafts++;
  record("full-worker-cycle",performance.now()-begin,"ok");
}
async function runWave(wave,concurrency){
  checkDeadline();
  const start=performance.now();
  let next=0,done=0;
  const workers=Array.from({length:concurrency},async()=>{
    while(next<N){
      const i=next++;
      try{await runOne(i,wave);done++;}
      catch(e){errors.push("wave"+(wave+1)+":courier"+i+":"+
        String(e?.code||"ERROR")+":"+String(e?.message||"").slice(0,140));}
    }
  });
  await Promise.all(workers);
  report.engine["wave"+(wave+1)]={concurrency,completed:done,errors:errors.length,
    elapsed_ms:round(performance.now()-start)};
  console.log("STAGING_CAPACITY_WAVE "+JSON.stringify(report.engine["wave"+(wave+1)]));
  assert.equal(done,N,"Wave "+wave+" failed or timed out; stop ramp");
}
async function validate(){
  const db=await pool.query(
    "SELECT (SELECT count(*)::int FROM pre_departures WHERE courier_id=ANY($1::int[]) AND status='CANCELLED') AS cancelled, "+
    "(SELECT count(*)::int FROM dispatches WHERE courier_id=ANY($1::int[])) AS dispatches, "+
    "(SELECT count(*)::int FROM anotaai_orders WHERE order_id=ANY($2::text[])) AS synthetic_orders",
    [created.users,created.orders]);
  const r=db.rows[0];
  assert.equal(r.cancelled,120,"Expected 120 cancelled drafts");
  assert.equal(r.dispatches,0,"Do not create active dispatches");
  assert.equal(r.synthetic_orders,600,"All synthetic orders must remain until cleanup");
  report.safety.dispatchesCreated=Number(r.dispatches);
  const flags=await pool.query("SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [["pre_departure_enabled","route_planner_enabled","address_correction_enabled","delivery_incidents_enabled"]]);
  report.settingsAfter=Object.fromEntries(flags.rows.map(x=>[x.setting_key,x.setting_value]));
  assert.deepEqual(report.settingsAfter,report.settingsBefore,"Feature flags unexpectedly changed");
  for(const [key,value] of Object.entries({predepartures:120,checks:600,computedRoutes:120,
    blockedEarlyDepartures:120,idempotentDrafts:120,preparedDispatches:120,cancelledDrafts:120})){
    assert.equal(report.counts[key],value,"Counter mismatch: "+key);
  }
  assert.equal(errors.length,0,"Unexpected errors during load");
}
async function cleanup(){
  if(!pool)return;
  const outcomes={deletedDrafts:0,deletedOrders:0,disabledAccounts:0,remainingOrders:null,remainingDrafts:null};
  try{
    // Always disable ephemeral accounts immediately, regardless of prior failure.
    if(created.users.length){
      const r=await pool.query("UPDATE users SET active=false WHERE id=ANY($1::int[])",[created.users]);
      outcomes.disabledAccounts=r.rowCount;
    }
    if(created.users.length){
      const r=await pool.query("DELETE FROM pre_departures WHERE courier_id=ANY($1::int[])",[created.users]);
      outcomes.deletedDrafts=r.rowCount;
    }
    if(created.orders.length){
      const r=await pool.query("DELETE FROM anotaai_orders WHERE order_id=ANY($1::text[]) AND page_id=$2",
        [created.orders,PREFIX]);
      outcomes.deletedOrders=r.rowCount;
    }
    outcomes.remainingOrders=created.orders.length
      ? Number((await pool.query("SELECT count(*)::int AS n FROM anotaai_orders WHERE order_id=ANY($1::text[])",[created.orders])).rows[0].n):0;
    outcomes.remainingDrafts=created.users.length
      ? Number((await pool.query("SELECT count(*)::int AS n FROM pre_departures WHERE courier_id=ANY($1::int[])",[created.users])).rows[0].n):0;
    assert.equal(outcomes.remainingOrders,0);
    assert.equal(outcomes.remainingDrafts,0);
    // Synthetic audit records only. Avoid leaving 40 fake couriers in the admin list.
    outcomes.deletedAccounts=0;
    if(created.users.length){
      await pool.query("DELETE FROM audit_logs WHERE user_id=ANY($1::int[])",[created.users]);
      await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])",[created.users]);
      try{
        const removed=await pool.query("DELETE FROM users WHERE id=ANY($1::int[]) AND username LIKE $2",
          [created.users,PREFIX+"-%"]);
        outcomes.deletedAccounts=removed.rowCount;
      }catch(e){
        // The only safe fallback is already applied: synthetic users stay disabled.
        outcomes.accountRemovalDeferred=String(e.code||"constraint");
      }
    }
    outcomes.remainingActiveAccounts=created.users.length?
      Number((await pool.query("SELECT count(*)::int AS n FROM users WHERE id=ANY($1::int[]) AND active=true",[created.users])).rows[0].n):0;
    assert.equal(outcomes.remainingActiveAccounts,0);
    report.cleanup={status:"PASS",...outcomes};
    console.log("STAGING_CAPACITY_CLEANUP_OK "+JSON.stringify(outcomes));
  }catch(e){
    report.cleanup={status:"FAIL",...outcomes,reason:String(e?.code||e?.message||"error").slice(0,120)};
    console.error("STAGING_CAPACITY_CLEANUP_FAIL "+JSON.stringify(report.cleanup));
    errors.push("cleanup:"+report.cleanup.reason);
  }
}
async function execute(){
  try{
    await setup();await seed();await httpSessions();
    srv=service();
    await runWave(0,5);
    await runWave(1,15);
    await runWave(2,40);
    await validate();
  }catch(e){
    errors.push("RUN:"+String(e?.code||"ERROR")+":"+String(e?.message||"unknown").slice(0,160));
  }finally{
    if(timer)clearInterval(timer);
    loop.disable();
    try{await cleanup();}catch(e){errors.push("FINAL_CLEANUP:"+String(e?.code||"error"));}
    if(pool)await pool.end().catch(()=>{});
    report.elapsed_ms=round(performance.now()-startedAt);
    report.stats=Object.fromEntries(Object.entries(stats).map(([k,v])=>[
      k,{calls:v.duration.length,status:v.status,p50_ms:quantile(v.duration,.5),
      p95_ms:quantile(v.duration,.95),p99_ms:quantile(v.duration,.99),max_ms:quantile(v.duration,1)}]));
    report.load_generator={peak_rss_mib:round(sampler.peakRss/1048576),
      peak_heap_mib:round(sampler.peakHeap/1048576),
      peak_pool_connections:sampler.peakPoolTotal,peak_pool_waiting:sampler.peakPoolWaiting,
      event_loop_delay_p95_ms:round(loop.percentile(95)/1e6),
      event_loop_delay_max_ms:round(loop.max/1e6)};
    report.failures=errors.slice(0,12);
    report.status=errors.length===0&&report.cleanup.status==="PASS"?"PASS":"FAIL";
    console.log("STAGING_HOSTED_CAPACITY_40_RESULT "+JSON.stringify(report));
  }
}
if(process.argv.includes("--launch")) {
  const proc=spawn(process.execPath,["server.js"],{stdio:"inherit",env});
  process.on("SIGTERM",()=>proc.kill("SIGTERM"));
  process.on("SIGINT",()=>proc.kill("SIGINT"));
  proc.on("exit",(code,signal)=>{
    console.log("STAGING_CAPACITY_WEB_EXIT "+JSON.stringify({code,signal}));
    process.exitCode=code||1;
  });
  let ready=false;
  for(let i=0;i<55;i++){
    if(proc.exitCode!==null)break;
    try{
      const r=await fetch(host+"/api/health",{signal:AbortSignal.timeout(2000)});
      if(r.status===200){ready=true;break;}
    }catch{}
    await delay(600);
  }
  if(!ready)console.error("STAGING_CAPACITY_STARTUP_NOT_HEALTHY");
  else await execute();
} else {
  throw new Error("Use --launch only in the isolated staging startup.");
}
