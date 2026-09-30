import pg from "pg";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import { classifyLoadResponse, RESPONSE_CLASSIFICATION } from "./k6-response-classifier.js";

const { Pool } = pg;

const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.LOADTEST_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
const LOAD_TEST_KEY = process.env.LOAD_TEST_KEY || "";
const CONFIRM = process.env.LOAD_TEST_CONFIRM;
const LEVEL = process.env.LOADTEST_LEVEL || "L1";
const STATE_FILE = process.env.LOADTEST_STATE_FILE || "/tmp/despachefull-loadtest-state.json";
const LEVEL_STARTED = Date.now();

const COURIERS = Math.max(1, Number(process.env.COURIERS || 50));
const DEPARTURES = Math.max(1, Number(process.env.DEPARTURES_PER_COURIER || (LEVEL === "L1" ? 4 : 40)));
const ORDERS_PER_DEPARTURE = Math.min(5, Math.max(1, Number(process.env.ORDERS_PER_DEPARTURE || (LEVEL === "L1" ? 2 : 3))));
const TEST_PASSWORD = "LoadTest!987654";
const RUN = `lt_${Date.now().toString(36)}`;

if (CONFIRM !== "STAGING_ONLY_I_UNDERSTAND") {
  console.error("ABORTADO: LOAD_TEST_CONFIRM incorreto.");
  process.exit(2);
}
if (!TARGET || !DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error("Faltam variáveis obrigatórias do teste.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: LEVEL === "L1" ? 2 : 15
});

const userIds = [];
let adminId = null;
const latencies = [];
const operationLatencies = new Map();
const operationStatuses = new Map();
const failures = [];
const warnings = [];
const telemetrySamples = [];
const activeSamples = [];
const lifecycleTasks = [];
const REQUEST_TIMEOUT_MS = 10000;
const L1_TOTAL_DEPARTURES = 64;
const L1_NORMAL_DEPARTURES = 48;
const L1_PEAK_DEPARTURES = 16;
const L1_RAMP_MS = 2 * 60 * 1000;
const L1_NORMAL_MS = 10 * 60 * 1000;
const L1_PEAK_MS = 2 * 60 * 1000;
const L1_DRAIN_MS = 60 * 1000;
const L1_RECOVERY_MS = 60 * 1000;
const statusCounts = {};
let createdDepartures = 0;
let createdOrders = 0;
let adminConcurrentChecks = 0;
let replayRequests = 0;
let replayAccepted = 0;
let measuredRequests = 0;
function writeLiveState(extra={}) {
  const sorted=[...latencies].sort((a,b)=>a-b);
  const pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]:0;
  const elapsed=Math.max(.001,(Date.now()-LEVEL_STARTED)/1000);
  const fiveXx=Object.entries(statusCounts).reduce((n,[k,v])=>n+(Number(k)>=500?Number(v):0),0);
  fs.writeFileSync(STATE_FILE,JSON.stringify({
    active:true,state:"EXECUTANDO",level:LEVEL,couriers:COURIERS,
    requests:measuredRequests,rps:Number((measuredRequests/elapsed).toFixed(1)),
    p50:round(pct(.5)),p95:round(pct(.95)),p99:round(pct(.99)),http5xx:fiveXx,
    lost:null,duplicates:null,orphanLocks:null,corruption:null,integrity:"PENDENTE",
    ...extra,updatedAt:new Date().toISOString()
  }));
}

const headers = () => ({
  "content-type": "application/json",
  ...(LOAD_TEST_KEY ? { "x-load-test-key": LOAD_TEST_KEY } : {})
});

function addStatus(status) {
  statusCounts[String(status)] = (statusCounts[String(status)] || 0) + 1;
  measuredRequests++;
  if (measuredRequests % 20 === 0) writeLiveState();
}

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

function recordOperation(operation,status,elapsed){
  if(!operationLatencies.has(operation)) operationLatencies.set(operation,[]);
  operationLatencies.get(operation).push(elapsed);
  if(!operationStatuses.has(operation)) operationStatuses.set(operation,{});
  const statuses=operationStatuses.get(operation);
  statuses[String(status)]=(statuses[String(status)]||0)+1;
}
function operationPercentile(operation,p){
  const values=operationLatencies.get(operation)||[];
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
}
function operationSummary(operation){
  const values=operationLatencies.get(operation)||[];
  return {
    requests:values.length,
    statusCounts:operationStatuses.get(operation)||{},
    p50:values.length?round(operationPercentile(operation,.50)):null,
    p95:values.length?round(operationPercentile(operation,.95)):null,
    p99:values.length?round(operationPercentile(operation,.99)):null,
    max:values.length?round(Math.max(...values)):null
  };
}
async function login(username, password, operation="login") {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${TARGET}/api/login`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    const elapsed=performance.now()-started;
    latencies.push(elapsed); recordOperation(operation,0,elapsed); addStatus(0);
    throw new Error(`login ${username}: TIMEOUT ${err?.name||"network"}`);
  }
  const elapsed=performance.now()-started;
  latencies.push(elapsed); recordOperation(operation,res.status,elapsed); addStatus(res.status);

  if (!res.ok) {
    throw new Error(`login ${username}: HTTP ${res.status} ${await res.text()}`);
  }
  return cookieFrom(res);
}

async function call(path, cookie, opt = {}, operation="other") {
  const started = performance.now();
  try {
    const res = await fetch(`${TARGET}${path}`, {
      ...opt,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...headers(),
        cookie,
        ...(opt.headers || {})
      }
    });
    const elapsed=performance.now()-started;
    latencies.push(elapsed); recordOperation(operation,res.status,elapsed); addStatus(res.status);
    return res;
  } catch (err) {
    const elapsed=performance.now()-started;
    latencies.push(elapsed); recordOperation(operation,0,elapsed); addStatus(0);
    const synthetic={ok:false,status:0,statusText:"TIMEOUT",transportError:err,
      async text(){return String(err?.message||"timeout")},
      async json(){return {code:"TIMEOUT",error:String(err?.message||"timeout")}},
      clone(){return this}};
    return synthetic;
  }
}

async function seedCouriers() {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  for (let i = 1; i <= COURIERS; i++) {
    const q = await pool.query(`
      INSERT INTO users(
        name,username,password_hash,role,
        approval_status,active,must_change_password
      )
      VALUES($1,$2,$3,'courier','APPROVED',true,false)
      RETURNING id
    `, [`Load Test ${i}`, `${RUN}_c${i}`, hash]);
    userIds.push(q.rows[0].id);
    const dates=(await pool.query("SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS today, ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 1) AS yesterday")).rows[0];
    for(const d of [dates.today,dates.yesterday]){
      for(const shiftCode of ["LUNCH","DINNER"]){
        await pool.query(`
          INSERT INTO courier_attendance(courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason)
          VALUES($1,$2::date,$3,NOW(),'ADMIN_MANUAL',$4,'Load test 4.8')
          ON CONFLICT(courier_id,attendance_date,shift_code) WHERE shift_code IS NOT NULL DO NOTHING
        `,[q.rows[0].id,d,shiftCode,adminId]);
      }
    }
  }
}

function l1OrderCount(index){
  // Exactly 19/64 departures with one order (~30%) and 45/64 with two (~70%),
  // distributed deterministically across the whole run.
  return ((index * 7) % L1_TOTAL_DEPARTURES) < 19 ? 1 : 2;
}
function buildL1Plan(){
  return Array.from({length:L1_TOTAL_DEPARTURES},(_,index)=>{
    const items=Array.from({length:l1OrderCount(index)},(_,j)=>({
      display:`#${RUN.toUpperCase()}-${String(index+1).padStart(3,"0")}-${j+1}`,
      orderId:`${RUN}-order-${index+1}-${j+1}`
    }));
    return {index,items};
  });
}
const l1Plan=buildL1Plan();
const l1RaceOrder={display:`#${RUN.toUpperCase()}-RACE`,orderId:`${RUN}-race-order`};
const l1ExpectedOrders=l1Plan.reduce((n,x)=>n+x.items.length,0);

async function seedL1Orders(){
  for(const item of [...l1Plan.flatMap(x=>x.items),l1RaceOrder]){
    await pool.query(`
      INSERT INTO anotaai_orders(
        order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload
      )
      VALUES($1,$2,$3,'READY','DELIVERY',NOW(),NOW(),'{}'::jsonb)
      ON CONFLICT(order_id) DO NOTHING
    `,[item.orderId,RUN,item.display]);
  }
}

async function sampleHealth(label){
  const res=await call("/api/health","",{},"telemetry");
  if(!res.ok){
    failures.push(`telemetry-${label}:HTTP${res.status}`);
    return null;
  }
  const body=await res.json();
  const sample={
    at:new Date().toISOString(),label,
    status:body.status,
    stagingSafeMode:body.stagingSafeMode,
    externalMutationsAllowed:body.externalMutationsAllowed,
    dbLatencyMs:Number(body.dbLatencyMs||0),
    pool:body.components?.database?.pool||null,
    memory:body.components?.application?.memory||null,
    eventLoopLagMs:Number(body.components?.application?.eventLoopLagMs||0),
    connectedClients:Number(body.components?.realtime?.connectedClients||0)
  };
  telemetrySamples.push(sample);
  if(sample.stagingSafeMode!==true||sample.externalMutationsAllowed!==false){
    failures.push(`safe-mode-${label}:invalid`);
  }
  return sample;
}

async function waitUntil(epoch){
  while(Date.now()<epoch) await new Promise(r=>setTimeout(r,Math.min(1000,epoch-Date.now())));
}

async function cleanup() {
  if (!userIds.length) return;
  await pool.query("BEGIN");
  try {
    await pool.query(
      "DELETE FROM operational_conflicts WHERE actor_user_id=ANY($1::int[]) OR courier_id=ANY($1::int[])",
      [userIds]
    );
    await pool.query("DELETE FROM notifications WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM audit_logs WHERE user_id=ANY($1::int[]) OR (entity='dispatch' AND entity_id::text IN (SELECT id::text FROM dispatches WHERE courier_id=ANY($1::int[])))", [userIds]);
    await pool.query("DELETE FROM active_order_locks WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM dispatches WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM anotaai_orders WHERE page_id=$1", [RUN]);
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

function percentile(p) {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function round(n) {
  return Number(Number(n).toFixed(1));
}

function writeReport(report) {
  fs.writeFileSync(
    "full-staging-load-report.json",
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report, null, 2));
}

writeLiveState({state:"PREPARANDO"});
adminId=Number((await pool.query(
  "SELECT id FROM users WHERE username=$1 AND role='admin' LIMIT 1",
  [ADMIN_USERNAME.toLowerCase()]
)).rows[0]?.id||0);
if(!adminId)throw new Error("Admin staging não encontrado para presença de carga.");

if(LEVEL!=="L1" || COURIERS!==20){
  throw new Error("Executor 4.8 bloqueado: somente L1 com 20 motoboys é permitido nesta etapa.");
}
if(String(process.env.APP_ENV||"").toLowerCase()!=="staging" ||
   !["1","true","yes","on"].includes(String(process.env.STAGING_SAFE_MODE||"").toLowerCase())){
  throw new Error("Executor 4.8 bloqueado fora do staging protegido.");
}
if(!TARGET.includes("despachefull-staging.onrender.com")){
  throw new Error("Executor 4.8 bloqueado: TARGET_URL não é o staging hospedado.");
}

await seedCouriers();
await seedL1Orders();
writeLiveState({state:"PRE-CHECK"});

let running=true;
let watcher=null;
let telemetryWatcher=null;
let runStartEpoch=0;
let maxActiveCouriers=0;
let confirmedOrders=0;
let raceSummary=null;
let integrityAudit=null;
let baselineHealth=null;
let recoveryEndHealth=null;
let finalReport=null;
let cleanupOk=false;
let cleanupError=null;

function failureBodyCode(res){
  try{return res?._loadBody?.code||null}catch{return null}
}

async function readResponseBody(res){
  if(!res)return null;
  if(res._loadBody!==undefined)return res._loadBody;
  try{
    const body=await res.clone().json();
    res._loadBody=body;
    return body;
  }catch{
    res._loadBody=null;
    return null;
  }
}

async function expectNormalSuccess(res,label){
  const body=await readResponseBody(res);
  if(res.status===0){
    failures.push(label+":TIMEOUT");
    return false;
  }
  if(res.status===401||res.status===403){
    failures.push(label+":AUTH_"+res.status);
    return false;
  }
  if(res.status>=500){
    failures.push(label+":HTTP"+res.status);
    return false;
  }
  if(res.status===409){
    failures.push(label+":UNEXPECTED_409:"+(body?.code||"NO_CODE"));
    return false;
  }
  if(!res.ok){
    failures.push(label+":HTTP"+res.status);
    return false;
  }
  return true;
}

function currentActive(states){
  return states.filter(x=>x.active).length;
}

function pickIdleCourier(states){
  return states
    .filter(x=>x.cookie&&!x.active)
    .sort((a,b)=>a.departures-b.departures||a.index-b.index)[0]||null;
}

async function waitForIdleCourier(states,timeoutMs=30000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const found=pickIdleCourier(states);
    if(found)return found;
    await new Promise(r=>setTimeout(r,250));
  }
  return null;
}

function buildSchedule(){
  const out=[];
  const normalStart=runStartEpoch+L1_RAMP_MS;
  const normalStep=L1_NORMAL_MS/L1_NORMAL_DEPARTURES;
  for(let i=0;i<L1_NORMAL_DEPARTURES;i++){
    out.push({plan:l1Plan[i],at:normalStart+Math.floor(i*normalStep),phase:"NORMAL"});
  }
  const peakStart=normalStart+L1_NORMAL_MS;
  const peakStep=L1_PEAK_MS/L1_PEAK_DEPARTURES;
  for(let i=0;i<L1_PEAK_DEPARTURES;i++){
    const index=L1_NORMAL_DEPARTURES+i;
    out.push({plan:l1Plan[index],at:peakStart+Math.floor(i*peakStep),phase:"PICO"});
  }
  return out;
}

async function confirmLifecycle(state,plan,holdMs){
  await new Promise(r=>setTimeout(r,holdMs));
  for(const item of plan.items){
    const res=await call(
      "/api/courier/anotaai/orders/"+encodeURIComponent(item.orderId)+"/confirm-delivery",
      state.cookie,
      {method:"POST",body:"{}"},
      "confirm"
    );
    if(await expectNormalSuccess(res,"confirm:"+item.display))confirmedOrders++;
    await new Promise(r=>setTimeout(r,350));
  }
  state.active=false;
  state.activeDispatchId=null;
}

function all5xxCount(){
  return Object.entries(statusCounts).reduce(
    (n,[status,count])=>n+(Number(status)>=500?Number(count):0),0
  );
}

function statusZeroCount(){
  return Number(statusCounts["0"]||0);
}

function evaluatePerformance(){
  const dispatch=operationSummary("dispatch");
  const confirm=operationSummary("confirm");
  const dashboard=operationSummary("dashboard");

  if(dispatch.p50!==null&&dispatch.p50>300)failures.push("perf:dispatch:p50:"+dispatch.p50+">300");
  if(dispatch.p95!==null&&dispatch.p95>1000)failures.push("perf:dispatch:p95:"+dispatch.p95+">1000");
  if(dispatch.p99!==null&&dispatch.p99>2000)failures.push("perf:dispatch:p99:"+dispatch.p99+">2000");

  for(const pair of [["confirm",confirm],["dashboard",dashboard]]){
    const name=pair[0],summary=pair[1];
    if(summary.p95!==null&&summary.p95>1000)failures.push("perf:"+name+":p95:"+summary.p95+">1000");
    if(summary.p99!==null&&summary.p99>2000)failures.push("perf:"+name+":p99:"+summary.p99+">2000");
  }
  return {dispatch,confirm,dashboard};
}

function evaluateTelemetry(){
  let consecutiveWaiting=0,maxConsecutiveWaiting=0,maxWaiting=0;
  let maxDbLatencyMs=0,maxRssMb=0,maxEventLoopLagMs=0,safeModeViolations=0;
  for(const sample of telemetrySamples){
    const waiting=Number(sample.pool?.waiting||0);
    maxWaiting=Math.max(maxWaiting,waiting);
    maxDbLatencyMs=Math.max(maxDbLatencyMs,Number(sample.dbLatencyMs||0));
    maxRssMb=Math.max(maxRssMb,Number(sample.memory?.rssMb||0));
    maxEventLoopLagMs=Math.max(maxEventLoopLagMs,Number(sample.eventLoopLagMs||0));
    if(waiting>0)consecutiveWaiting++;else consecutiveWaiting=0;
    maxConsecutiveWaiting=Math.max(maxConsecutiveWaiting,consecutiveWaiting);
    if(sample.stagingSafeMode!==true||sample.externalMutationsAllowed!==false)safeModeViolations++;
  }
  if(maxConsecutiveWaiting>=3)failures.push("pool:waiting-sustained:"+maxConsecutiveWaiting+"-samples");
  if(safeModeViolations)failures.push("safe-mode:violations:"+safeModeViolations);
  return {
    samples:telemetrySamples.length,maxWaiting,maxConsecutiveWaiting,
    maxDbLatencyMs,maxRssMb,maxEventLoopLagMs,safeModeViolations
  };
}

async function runIntegrityAudit(expectedRaceSuccess){
  const sql=[
    "SELECT",
    " (SELECT COUNT(*)::int FROM dispatches WHERE courier_id=ANY($1::int[])) AS dispatches,",
    " (SELECT COUNT(*)::int FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id",
    "  WHERE d.courier_id=ANY($1::int[])) AS orders,",
    " (SELECT COUNT(*)::int FROM (",
    "   SELECT o.order_number,COUNT(*) c",
    "   FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id",
    "   WHERE d.courier_id=ANY($1::int[])",
    "   GROUP BY o.order_number HAVING COUNT(*)>1",
    " ) x) AS duplicates,",
    " (SELECT COUNT(*)::int FROM active_order_locks l LEFT JOIN dispatches d ON d.id=l.dispatch_id",
    "  WHERE l.courier_id=ANY($1::int[]) AND (d.id IS NULL OR d.status<>'ON_ROAD')) AS orphan_locks,",
    " (SELECT COUNT(*)::int FROM dispatches d",
    "  WHERE d.courier_id=ANY($1::int[])",
    "  AND NOT EXISTS(SELECT 1 FROM dispatch_orders o WHERE o.dispatch_id=d.id)) AS corruption,",
    " (SELECT COUNT(*)::int FROM active_order_locks WHERE courier_id=ANY($1::int[])) AS active_locks,",
    " (SELECT COUNT(*)::int FROM anotaai_dispatch_links l JOIN dispatches d ON d.id=l.dispatch_id",
    "  WHERE d.courier_id=ANY($1::int[])) AS anota_links"
  ].join("\n");
  const row=(await pool.query(sql,[userIds])).rows[0];
  const expectedDispatches=L1_TOTAL_DEPARTURES+(expectedRaceSuccess?1:0);
  const expectedOrders=l1ExpectedOrders+(expectedRaceSuccess?1:0);
  const audit={
    expectedDispatches,
    databaseDispatches:Number(row.dispatches||0),
    expectedOrders,
    databaseOrders:Number(row.orders||0),
    duplicateOrders:Number(row.duplicates||0),
    orphanLocks:Number(row.orphan_locks||0),
    corruption:Number(row.corruption||0),
    activeLocks:Number(row.active_locks||0),
    anotaAiLinks:Number(row.anota_links||0)
  };
  audit.lostDispatches=Math.max(0,audit.expectedDispatches-audit.databaseDispatches);
  audit.lostOrders=Math.max(0,audit.expectedOrders-audit.databaseOrders);

  if(audit.databaseDispatches!==audit.expectedDispatches)failures.push("audit:dispatches:"+audit.databaseDispatches+"/"+audit.expectedDispatches);
  if(audit.databaseOrders!==audit.expectedOrders)failures.push("audit:orders:"+audit.databaseOrders+"/"+audit.expectedOrders);
  if(audit.duplicateOrders!==0)failures.push("audit:duplicates:"+audit.duplicateOrders);
  if(audit.orphanLocks!==0)failures.push("audit:orphanLocks:"+audit.orphanLocks);
  if(audit.corruption!==0)failures.push("audit:corruption:"+audit.corruption);
  if(audit.activeLocks!==0)failures.push("audit:activeLocks:"+audit.activeLocks);
  if(audit.anotaAiLinks!==audit.expectedOrders)failures.push("audit:anotaLinks:"+audit.anotaAiLinks+"/"+audit.expectedOrders);
  return audit;
}

try{
  baselineHealth=await sampleHealth("BASELINE");
  if(!baselineHealth)throw new Error("Health baseline indisponível.");
  if(Number(baselineHealth.pool?.waiting||0)!==0){
    throw new Error("Baseline PostgreSQL já possui waiting no pool.");
  }
  if(baselineHealth.stagingSafeMode!==true||baselineHealth.externalMutationsAllowed!==false){
    throw new Error("Safe Mode não confirmado no staging.");
  }

  const adminCookie=await login(ADMIN_USERNAME,ADMIN_PASSWORD,"admin_login");
  runStartEpoch=Date.now();
  const states=userIds.map((id,index)=>({
    id:Number(id),index,cookie:"",active:false,departures:0,activeDispatchId:null
  }));

  writeLiveState({state:"RAMP"});

  const loginTasks=states.map(async state=>{
    await waitUntil(runStartEpoch+Math.floor(state.index*(L1_RAMP_MS/COURIERS)));
    state.cookie=await login(RUN+"_c"+(state.index+1),TEST_PASSWORD,"login");
  });
  await Promise.all(loginTasks);

  watcher=(async()=>{
    while(running){
      try{
        const res=await call("/api/admin/dashboard",adminCookie,{},"dashboard");
        adminConcurrentChecks++;
        await expectNormalSuccess(res,"dashboard");
      }catch(err){
        failures.push("dashboard:"+err.message);
      }
      await new Promise(r=>setTimeout(r,5000));
    }
  })();

  telemetryWatcher=(async()=>{
    while(running){
      await sampleHealth("RUN");
      const active=currentActive(states);
      activeSamples.push({at:new Date().toISOString(),active});
      maxActiveCouriers=Math.max(maxActiveCouriers,active);
      writeLiveState({state:"EXECUTANDO",activeCouriers:active,maxActiveCouriers});
      await new Promise(r=>setTimeout(r,5000));
    }
  })();

  const schedule=buildSchedule();
  for(const event of schedule){
    await waitUntil(event.at);
    writeLiveState({state:event.phase});
    const state=await waitForIdleCourier(states,30000);
    if(!state){
      failures.push("dispatch-"+(event.plan.index+1)+":NO_IDLE_COURIER");
      continue;
    }

    state.active=true;
    maxActiveCouriers=Math.max(maxActiveCouriers,currentActive(states));

    const orders=event.plan.items.map(x=>x.display);
    const token=RUN+"-depart-"+(event.plan.index+1);
    const payload={
      order_numbers:orders,
      order_count:orders.length,
      platform_selections:orders.map(order_number=>({order_number,platform:"anotaai"})),
      confirm_recent_orders:true,
      client_token:token
    };

    const res=await call("/api/courier/depart",state.cookie,{
      method:"POST",body:JSON.stringify(payload)
    },"dispatch");

    if(!(await expectNormalSuccess(res,"dispatch:"+(event.plan.index+1)))){
      state.active=false;
      continue;
    }

    const body=await readResponseBody(res);
    const dispatch=body?.dispatch;
    if(!dispatch?.id){
      failures.push("dispatch:"+(event.plan.index+1)+":NO_DISPATCH_ID");
      state.active=false;
      continue;
    }

    createdDepartures++;
    createdOrders+=orders.length;
    state.departures++;
    state.activeDispatchId=Number(dispatch.id);

    if([9,24,39,54].includes(event.plan.index)){
      replayRequests++;
      const replay=await call("/api/courier/depart",state.cookie,{
        method:"POST",body:JSON.stringify(payload)
      },"idempotency");
      const replayBody=await readResponseBody(replay);
      if(replay.ok&&replayBody?.duplicate===true&&Number(replayBody?.dispatch?.id)===Number(dispatch.id)){
        replayAccepted++;
      }else{
        failures.push("idempotency:"+(event.plan.index+1)+":HTTP"+replay.status+":"+(replayBody?.code||"NO_CODE"));
      }
    }

    const drainEnd=runStartEpoch+L1_RAMP_MS+L1_NORMAL_MS+L1_PEAK_MS+L1_DRAIN_MS;
    const baseHold=90000+((event.plan.index*7919)%40000);
    const remaining=Math.max(20000,drainEnd-Date.now()-15000);
    const holdMs=Math.min(baseHold,remaining);
    lifecycleTasks.push(confirmLifecycle(state,event.plan,holdMs));
  }

  writeLiveState({state:"DRENAGEM"});
  await waitUntil(runStartEpoch+L1_RAMP_MS+L1_NORMAL_MS+L1_PEAK_MS+L1_DRAIN_MS);
  await Promise.all(lifecycleTasks);

  const activeAfterDrain=currentActive(states);
  if(activeAfterDrain!==0)failures.push("drain:active-couriers:"+activeAfterDrain);

  writeLiveState({state:"RACE"});
  const raceResponses=await Promise.all(states.map((state,index)=>
    call("/api/courier/depart",state.cookie,{
      method:"POST",
      body:JSON.stringify({
        order_numbers:[l1RaceOrder.display],
        order_count:1,
        platform_selections:[{order_number:l1RaceOrder.display,platform:"anotaai"}],
        confirm_recent_orders:true,
        client_token:RUN+"-race-"+(index+1)
      })
    },"race")
  ));

  const raceClassifications=[];
  for(const response of raceResponses){
    const body=await readResponseBody(response);
    raceClassifications.push(classifyLoadResponse({
      status:response.status,
      body,
      transportError:response.transportError,
      tags:{operation:"concurrency_race",scenario:"l1_race",conflict_context:"expected"}
    }));
  }
  const countClass=kind=>raceClassifications.filter(x=>x.classification===kind).length;
  const raceSuccess=countClass(RESPONSE_CLASSIFICATION.SUCCESS);
  const raceBlocked=countClass(RESPONSE_CLASSIFICATION.EXPECTED_409);
  const raceUnexpected409=countClass(RESPONSE_CLASSIFICATION.UNEXPECTED_409);
  const raceServerErrors=countClass(RESPONSE_CLASSIFICATION.SERVER_ERROR);
  const raceTimeouts=countClass(RESPONSE_CLASSIFICATION.TIMEOUT);
  const raceAuthFailures=countClass(RESPONSE_CLASSIFICATION.AUTH_FAILURE);
  const raceKnown=raceSuccess+raceBlocked+raceUnexpected409+raceServerErrors+raceTimeouts+raceAuthFailures;
  const raceOther=raceClassifications.length-raceKnown;

  if(raceSuccess!==1)failures.push("race-success:"+raceSuccess+"/1");
  if(raceBlocked!==COURIERS-1)failures.push("race-expected-409:"+raceBlocked+"/"+(COURIERS-1));
  if(raceUnexpected409)failures.push("race-unexpected-409:"+raceUnexpected409);
  if(raceServerErrors)failures.push("race-server-errors:"+raceServerErrors);
  if(raceTimeouts)failures.push("race-timeouts:"+raceTimeouts);
  if(raceAuthFailures)failures.push("race-auth-failures:"+raceAuthFailures);
  if(raceOther)failures.push("race-other:"+raceOther);

  const raceDb=(await pool.query([
    "SELECT",
    " (SELECT COUNT(*)::int FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id",
    "  WHERE d.courier_id=ANY($1::int[]) AND o.order_number=$2) AS dispatches,",
    " (SELECT COUNT(*)::int FROM active_order_locks",
    "  WHERE courier_id=ANY($1::int[]) AND order_number=$2) AS locks"
  ].join("\n"),[userIds,l1RaceOrder.display])).rows[0];
  const raceDbDispatches=Number(raceDb.dispatches||0);
  const raceDbLocks=Number(raceDb.locks||0);
  if(raceDbDispatches!==1)failures.push("race-db-dispatches:"+raceDbDispatches+"/1");
  if(raceDbLocks!==1)failures.push("race-db-locks:"+raceDbLocks+"/1");

  const winnerIndex=raceResponses.findIndex(x=>x.status>=200&&x.status<300);
  if(winnerIndex>=0){
    const winner=states[winnerIndex];
    const clean=await call(
      "/api/courier/anotaai/orders/"+encodeURIComponent(l1RaceOrder.orderId)+"/confirm-delivery",
      winner.cookie,
      {method:"POST",body:"{}"},
      "race_cleanup"
    );
    await expectNormalSuccess(clean,"race-cleanup");
  }

  raceSummary={
    attempts:COURIERS,successful:raceSuccess,expected409:raceBlocked,
    unexpected409:raceUnexpected409,serverErrors:raceServerErrors,
    timeouts:raceTimeouts,authFailures:raceAuthFailures,other:raceOther,
    authoritativeDispatches:raceDbDispatches,authoritativeLocks:raceDbLocks
  };

  writeLiveState({state:"RECUPERAÇÃO"});
  await sampleHealth("RECOVERY_START");
  await new Promise(r=>setTimeout(r,L1_RECOVERY_MS));
  recoveryEndHealth=await sampleHealth("RECOVERY_END");

  running=false;
  await Promise.all([watcher,telemetryWatcher]);

  if(createdDepartures!==L1_TOTAL_DEPARTURES)failures.push("created-departures:"+createdDepartures+"/"+L1_TOTAL_DEPARTURES);
  if(createdOrders!==l1ExpectedOrders)failures.push("created-orders:"+createdOrders+"/"+l1ExpectedOrders);
  if(confirmedOrders!==l1ExpectedOrders)failures.push("confirmed-orders:"+confirmedOrders+"/"+l1ExpectedOrders);
  if(replayRequests!==4||replayAccepted!==4)failures.push("idempotency-replays:"+replayAccepted+"/"+replayRequests);
  if(all5xxCount()!==0)failures.push("http5xx:"+all5xxCount());
  if(statusZeroCount()!==0)failures.push("timeouts:"+statusZeroCount());

  if(maxActiveCouriers<8||maxActiveCouriers>16){
    warnings.push("concurrency-window:max-active="+maxActiveCouriers+" target=8-16");
  }

  const performance=evaluatePerformance();
  const telemetry=evaluateTelemetry();

  writeLiveState({state:"AUDITORIA"});
  integrityAudit=await runIntegrityAudit(raceSuccess===1);

  const baselineRss=Number(baselineHealth?.memory?.rssMb||0);
  const recoveryRss=Number(recoveryEndHealth?.memory?.rssMb||0);
  if(baselineRss&&recoveryRss>baselineRss+128&&recoveryRss>baselineRss*1.5){
    failures.push("memory:not-recovered:"+baselineRss+"->"+recoveryRss+"MB");
  }

  finalReport={
    result:failures.length?"FAIL":"PASS",
    profile:{
      name:"L1_REALISTIC_15M",
      couriers:COURIERS,
      rampMinutes:2,
      normalMinutes:10,
      peakMinutes:2,
      drainMinutes:1,
      recoverySeconds:60,
      requestedDepartures:L1_TOTAL_DEPARTURES,
      requestedOrders:l1ExpectedOrders,
      orderMix:"19 departures with 1 order / 45 with 2 orders",
      requestTimeoutMs:REQUEST_TIMEOUT_MS
    },
    mainLoad:{
      createdDepartures,createdOrders,confirmedOrders,
      idempotentReplayRequests:replayRequests,
      idempotentReplaysAcceptedWithoutDuplicate:replayAccepted,
      adminDashboardChecks:adminConcurrentChecks,
      maxActiveCouriers
    },
    operationMetrics:{
      login:operationSummary("login"),
      adminLogin:operationSummary("admin_login"),
      dispatch:operationSummary("dispatch"),
      confirm:operationSummary("confirm"),
      dashboard:operationSummary("dashboard"),
      telemetry:operationSummary("telemetry"),
      idempotency:operationSummary("idempotency"),
      race:operationSummary("race")
    },
    performance,
    telemetry,
    race:raceSummary,
    integrity:integrityAudit,
    baseline:baselineHealth,
    recoveryEnd:recoveryEndHealth,
    warnings:[...warnings],
    failures:[...failures]
  };
}catch(err){
  running=false;
  failures.push("fatal:"+err.message);
  if(watcher){try{await watcher}catch{}}
  if(telemetryWatcher){try{await telemetryWatcher}catch{}}
  finalReport={
    result:"FAIL",
    fatal:err.message,
    warnings:[...warnings],
    failures:[...failures]
  };
}finally{
  writeLiveState({state:"CLEANUP"});
  try{
    await cleanup();
    cleanupOk=true;
  }catch(err){
    cleanupError=err.message;
    failures.push("cleanup:"+err.message);
    cleanupOk=false;
  }

  finalReport=finalReport||{result:"FAIL"};
  finalReport.cleanup={ok:cleanupOk,error:cleanupError};
  finalReport.failures=[...new Set([...(finalReport.failures||[]),...failures])];
  finalReport.warnings=[...new Set([...(finalReport.warnings||[]),...warnings])];
  finalReport.result=finalReport.failures.length?"FAIL":"PASS";
  finalReport.completedAt=new Date().toISOString();

  writeReport(finalReport);
  writeLiveState({
    active:false,
    state:finalReport.result==="PASS"?"CONCLUÍDO":"FALHOU",
    p50:finalReport.operationMetrics?.dispatch?.p50??null,
    p95:finalReport.operationMetrics?.dispatch?.p95??null,
    p99:finalReport.operationMetrics?.dispatch?.p99??null,
    http5xx:all5xxCount(),
    lost:integrityAudit?integrityAudit.lostDispatches+integrityAudit.lostOrders:null,
    duplicates:integrityAudit?.duplicateOrders??null,
    orphanLocks:integrityAudit?.orphanLocks??null,
    corruption:integrityAudit?.corruption??null,
    integrity:finalReport.result==="PASS"?"100%":"FALHOU",
    cleanup:{ok:cleanupOk,error:cleanupError}
  });

  await pool.end();
  if(finalReport.result!=="PASS")process.exitCode=1;
}
