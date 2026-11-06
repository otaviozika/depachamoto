/**
 * HTTP/PostgreSQL REAL isolado, 600 pedidos e 36 motoboys ficticios.
 * A ORS roda como mock por preload estritamente em staging. Nenhum DB/servico de producao.
 * 8 ondas de 72 entregas + 1 de 24, cada saida com 2 pedidos.
 */
import assert from "node:assert/strict";
import pg from "pg";
import bcrypt from "bcryptjs";
import { performance } from "node:perf_hooks";
import { operationalShiftAt } from "../lib/operational-shift.js";

const url = new URL(String(process.env.TARGET_URL || ""));
const db = new URL(String(process.env.DATABASE_URL || ""));
if (process.env.APP_ENV !== "staging" || process.env.STAGING_SAFE_MODE !== "true" ||
    process.env.LOAD_TEST_CONFIRM !== "STAGING_ONLY_I_UNDERSTAND" ||
    process.env.FRIDAY_MOCK_ORS_ONLY !== "YES" ||
    !["localhost","127.0.0.1"].includes(url.hostname) ||
    !["localhost","127.0.0.1"].includes(db.hostname) ||
    process.env.NODE_ENV === "production" ||
    process.env.OPENROUTESERVICE_API_KEY !== "FRIDAY_SYNTHETIC_STAGING_ONLY") {
  throw new Error("ABORTADO: exige staging local e chave ORS sintetica.");
}
const COURIERS=36,ORDERS=600;
const origin={latitude:-23.6244855,longitude:-46.5549218};
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:20});
const run = "fri"+String(Date.now()).slice(-9);
const password="FridaySyntheticOnly!001";
const fixedNow="2026-09-29T15:00:00Z";
const shift=operationalShiftAt(new Date(fixedNow),{required:true});
const cookies=[],users=[],records=[],routeTimes=[],fullTimes=[],waveTimes=[],failures=[];
const statuses={};
const jsonHeaders={ "content-type":"application/json","x-load-test-key":process.env.LOAD_TEST_KEY };
function percentile(xs,p) {
  if(!xs.length)return null;
  const a=[...xs].sort((x,y)=>x-y);
  return Number(a[Math.max(0,Math.ceil(a.length*p/100)-1)].toFixed(2));
}
function metrics(xs){return {count:xs.length,p50_ms:percentile(xs,50),p95_ms:percentile(xs,95),p99_ms:percentile(xs,99),max_ms:percentile(xs,100)}}
async function call(path,cookie="",method="GET",body=null) {
  const res=await fetch(url.origin+path,{method,headers:{...jsonHeaders,...(cookie?{cookie}:{})},
    ...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
  statuses[res.status]=(statuses[res.status]||0)+1;
  const value=await res.json().catch(()=>({}));
  return {status:res.status,value,cookie:(res.headers.get("set-cookie")||"").split(";")[0]};
}
async function must(path,cookie,method,body,code) {
  const result=await call(path,cookie,method,body);
  if(result.status!==code)throw new Error(`${path}: esperado ${code}, obtido ${result.status}: ${String(result.value?.code||result.value?.error||"unknown").slice(0,120)}`);
  return result;
}
async function seed() {
  const health=await must("/api/health","","GET",null,200);
  assert.equal(health.value.environment,"staging");
  assert.equal(health.value.stagingSafeMode,true);
  assert.equal(health.value.externalMutationsAllowed,false);
  const hash=await bcrypt.hash(password,10);
  const admin=(await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  assert.ok(admin,"admin do staging nao encontrado");
  for(let i=0;i<COURIERS;i++){
    const username=`${run}_${i}`;
    const u=(await pool.query(
      "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE) RETURNING id",
      [`Friday fake courier ${i}`,username,hash])).rows[0];
    users.push({id:u.id,username});
    await pool.query(
      "INSERT INTO courier_attendance(courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason) VALUES($1,$2::date,$3,$4::timestamptz,'ADMIN',$5,'Friday synthetic peak')",
      [u.id,shift.operational_date,shift.shift_code,fixedNow,admin.id]);
  }
  for(let i=0;i<ORDERS;i++){
    const display=`7${String(i+1).padStart(7,"0")}`;
    const orderId=`${run}_order_${i}`;
    const k=(i%72),lat=origin.latitude+0.002+((k%9)-4)*0.0008+Math.floor(i/72)*.00006;
    const lon=origin.longitude+0.002+((k%12)-6)*0.0009+Math.floor(i/72)*.00005;
    const payload={deliveryAddress:{streetName:"Rua Sintetica",streetNumber:String(100+i),
      neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP",
      coordinates:{latitude:lat,longitude:lon}},customer:{name:"Cliente Sintetico"}};
    await pool.query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'friday-staging-page',$2,'READY','DELIVERY',$3::timestamptz,$3::timestamptz,$4::jsonb,'Cliente Sintetico')",
      [orderId,display,fixedNow,JSON.stringify(payload)]);
    records.push({display,orderId});
  }
  await pool.query("INSERT INTO app_settings(setting_key,setting_value) VALUES('pre_departure_enabled','true'),('route_planner_enabled','true'),('address_correction_enabled','false'),('route_store_origin',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value",
    [JSON.stringify({...origin,source:"ADMIN_CONFIRMED",confirmed_at:new Date().toISOString()})]);
  await Promise.all(users.map(async (u,i)=>{
    const login=await must("/api/login","","POST",{username:u.username,password},200);
    assert.ok(login.cookie);
    cookies[i]=login.cookie;
  }));
  assert.equal(cookies.length,COURIERS);
  assert.ok(cookies.every(Boolean),"cada cookie precisa pertencer ao motoboy correto");
}
async function executeTwo(i,courierIndex){
  const begin=performance.now();
  const cookie=cookies[courierIndex], batch=records.slice(i,i+2);
  const order_numbers=batch.map(o=>"#"+o.display);
  const selection=order_numbers.map(order_number=>({order_number,platform:"anotaai"}));
  let created=await must("/api/courier/pre-departures",cookie,"POST",
    {order_numbers,order_count:2,platform_selections:selection},201);
  let pd=created.value.pre_departure;
  assert.ok(pd&&pd.counts.total===2);
  for(const order of pd.orders){
    const check=await must(`/api/courier/pre-departures/${pd.id}/orders/${order.id}/check`,cookie,"POST",
      {composition_version:pd.composition_version,checked:true},200);
    pd=check.value.pre_departure;
  }
  const t=performance.now();
  const route=await must(`/api/courier/pre-departures/${pd.id}/route`,cookie,"POST",{},200);
  routeTimes.push(performance.now()-t);
  pd=route.value.pre_departure;
  assert.equal(pd.status,"ROUTE_READY");
  assert.equal(pd.can_dispatch,true);
  assert.equal(pd.route?.source,"ROAD_MATRIX","rota automatica precisa estar ligada");
  assert.equal(pd.route?.stops?.length,2);
  assert.equal(pd.route?.evaluated,2);
  const depart=await must("/api/courier/depart",cookie,"POST",
    {pre_departure_id:pd.id,composition_version:pd.composition_version},201);
  const dispatchId=Number(depart.value?.dispatch?.id);
  assert.ok(dispatchId>0);
  for(const o of batch){
    const confirmation=await must(`/api/courier/anotaai/orders/${o.orderId}/confirm-delivery`,cookie,"POST",{},200);
    assert.equal(confirmation.value.confirmed,true);
  }
  const q=await pool.query("SELECT status FROM dispatches WHERE id=$1",[dispatchId]);
  assert.equal(q.rows[0]?.status,"RELEASED","motoboy deve estar livre para nova saida");
  fullTimes.push(performance.now()-begin);
}
try{
  await seed();
  for(let wave=0;wave<9;wave++){
    const waveStart=performance.now();
    const base=wave*72,amount=Math.min(72,ORDERS-base);
    const jobs=[];
    for(let c=0;c<amount/2;c++)jobs.push(executeTwo(base+c*2,c));
    const settled=await Promise.allSettled(jobs);
    for(let j=0;j<settled.length;j++)
      if(settled[j].status==="rejected")failures.push({wave,courier:j,error:String(settled[j].reason?.message||settled[j].reason).slice(0,220)});
    waveTimes.push(performance.now()-waveStart);
    if(failures.length)break; // nao mascarar bugs com novas tentativas de saida
  }
  // Assert the new persistent quota ledger was used (safe sandbox-only high limits).
  const slotCount=Number((await pool.query(
    "SELECT count(*)::int AS c FROM route_matrix_quota_ledger WHERE scope='ORS_MATRIX'"
  )).rows[0].c);
  assert.ok(slotCount>0 && slotCount<=300,"reserva global de cota deve registrar as chamadas Matrix");
  const totals=(await pool.query(
    "SELECT (SELECT count(*)::int FROM anotaai_orders WHERE order_id LIKE $1) AS orders, "+
    "(SELECT count(*)::int FROM anotaai_delivery_confirmations c JOIN anotaai_orders a ON a.order_id=c.anotaai_order_id WHERE a.order_id LIKE $1) AS confirmed, "+
    "(SELECT count(*)::int FROM dispatches WHERE courier_id=ANY($2::int[]) AND status='RELEASED') AS dispatches, "+
    "(SELECT count(*)::int FROM pre_departures WHERE courier_id=ANY($2::int[]) AND route_status='READY') AS ready",
    [run+"_order_%",users.map(x=>x.id)])).rows[0];
  const report={result:failures.length?"FAIL":"PASS",environment:"ephemeral PostgreSQL + local HTTP + fake ORS",
    synthetic_only:true,production_database_access:false,real_provider_requests:0,
    orders_requested:ORDERS,couriers:COURIERS,dispatches_expected:300,
    counts:{...totals,completed_routes:routeTimes.length,full_roundtrips:fullTimes.length,quota_reservations:slotCount},
    route_http_latency:metrics(routeTimes),full_predeparture_to_confirmation_latency:metrics(fullTimes),
    wave_elapsed:metrics(waveTimes),status_codes:statuses,
    failures:failures.slice(0,12),
    limitations:["mock ORS 150-650ms, no external latency or real API quota",
      "PostgreSQL local on GitHub runner; NOT Supabase hosted latency",
      "Conferencias instantaneas em teste; nao mede tempo de sacola ou viagem"]};
  console.log("FRIDAY_HTTP_600_REPORT_START");console.log(JSON.stringify(report,null,2));console.log("FRIDAY_HTTP_600_REPORT_END");
  assert.equal(failures.length,0,"falhas em etapas do fluxo");
  assert.equal(Number(totals.orders),ORDERS);
  assert.equal(Number(totals.confirmed),ORDERS);
  assert.equal(Number(totals.dispatches),300);
  assert.equal(Number(totals.ready),300);
  assert.equal(routeTimes.length,300);
}finally{await pool.end().catch(()=>{});}
