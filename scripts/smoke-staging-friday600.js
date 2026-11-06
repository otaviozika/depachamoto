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
let adminCookie=null;const incidentValidation={};
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
  const adminLogin=await must("/api/login","","POST",{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD},200);
  adminCookie=adminLogin.cookie;
  assert.ok(adminCookie,"admin staging login");
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
  if(i===0){
    const orderId=String(pd.route.stops[0].external_order_id);
    const reportPath="/api/courier/dispatches/"+dispatchId+"/incidents";
    const payload={platform:"anotaai",order_id:orderId,reason:"CLIENT_NOT_FOUND"};
    await must(reportPath,cookies[1],"POST",payload,404);
    incidentValidation.other_courier_rejected=true;
    await must(reportPath,cookie,"POST",{...payload,reason:"CODE_UNAVAILABLE"},400);
    incidentValidation.code_on_anota_rejected=true;
    const createdIncident=await must(reportPath,cookie,"POST",payload,201);
    const incidentId=Number(createdIncident.value.incident.id);
    assert.ok(incidentId>0);
    incidentValidation.report_created=true;
    const duplicate=await must(reportPath,cookie,"POST",payload,200);
    assert.equal(Number(duplicate.value.incident.id),incidentId);
    incidentValidation.idempotent=true;
    const listPath="/api/admin/delivery-incidents";
    await must(listPath,cookie,"GET",null,403);
    const list=await must(listPath,adminCookie,"GET",null,200);
    assert.ok(list.value.incidents.some(x=>Number(x.id)===incidentId && x.status==="OPEN"));
    incidentValidation.role_scoped=true;
    const before=(await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.route;
    assert.equal(before.stops.find(x=>x.external_order_id===orderId).incident.status,"OPEN");
    assert.equal(before.ack_required,false);
    const approve=await must("/api/admin/delivery-incidents/"+incidentId+"/decision",adminCookie,"POST",
      {action:"APPROVE_CONTINUE",reason:"Proxima entrega liberada pelo caixa"},200);
    assert.equal(approve.value.incident.status,"CONTINUE_APPROVED");
    const after=(await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.route;
    assert.equal(after.ack_required,true,"precisa de Ciente");
    assert.equal(after.stops.find(x=>x.external_order_id===orderId).is_deferred,true);
    assert.equal(after.stops.filter(x=>x.is_next).length,1,"outra entrega precisa tornar-se proxima");
    const pending=(await pool.query("SELECT count(*)::int AS n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=$1",[orderId])).rows[0];
    assert.equal(pending.n,0,"a decisao nunca confirma entrega");
    const d=(await pool.query("SELECT status FROM dispatches WHERE id=$1",[dispatchId])).rows[0];
    assert.equal(d.status,"ON_ROAD","nao liberou nova saida");
    await must("/api/courier/routes/"+dispatchId+"/ack",cookie,"POST",{route_version:after.route_version},200);
    incidentValidation.continue_without_delivery=true;
    const reversed=await must("/api/admin/delivery-incidents/"+incidentId+"/decision",adminCookie,"POST",
      {action:"REQUIRE_RETRY",reason:"Cliente retornou; tentar novamente"},200);
    assert.equal(reversed.value.incident.status,"OPEN");
    const rechecked=(await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.route;
    assert.equal(rechecked.stops.find(x=>x.external_order_id===orderId).is_deferred,false);
    await must("/api/courier/routes/"+dispatchId+"/ack",cookie,"POST",{route_version:rechecked.route_version},200);
    incidentValidation.retry_restored=true;
  }
  for(const o of batch){
    const confirmation=await must(`/api/courier/anotaai/orders/${o.orderId}/confirm-delivery`,cookie,"POST",{},200);
    assert.equal(confirmation.value.confirmed,true);
  }
  if(i===0){
    const active=Number((await pool.query("SELECT count(*)::int AS n FROM dispatch_delivery_incidents WHERE dispatch_id=$1 AND status IN ('OPEN','CONTINUE_APPROVED')",[dispatchId])).rows[0].n);
    const resolved=Number((await pool.query("SELECT count(*)::int AS n FROM dispatch_delivery_incidents WHERE dispatch_id=$1 AND status='RESOLVED'",[dispatchId])).rows[0].n);
    assert.equal(active,0);
    assert.equal(resolved,1,"confirmacao Anota AI deve encerrar a ocorrencia");
    incidentValidation.real_confirmation_resolves=true;
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
    wave_elapsed:metrics(waveTimes),status_codes:statuses,incident_validation:incidentValidation,
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
  assert.equal(Object.keys(incidentValidation).length,8,"oito verificacoes de ocorrencia Anota AI");
  // iFood falso adicional, fora das 600 entregas Anota AI. Nao chama API real.
  {
    const orderId=run+"_ifood_synthetic",orderNumber="#92004567";
    const fakeDispatch=(await pool.query("INSERT INTO dispatches(dispatch_code,order_number,courier_id) VALUES($1,$2,$3) RETURNING id",
      [run+"_ifood",orderNumber,users[0].id])).rows[0].id;
    await pool.query("INSERT INTO ifood_orders(order_id,display_id,status,order_type,delivered_by) VALUES($1,'92004567','DISPATCHED','DELIVERY','MERCHANT')",[orderId]);
    await pool.query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'ifood')",[fakeDispatch,orderNumber]);
    await pool.query("INSERT INTO dispatch_routes(dispatch_id,route_version,route_status,route,acked_version) VALUES($1,1,'ADMIN',$2::jsonb,1)",
      [fakeDispatch,JSON.stringify({source:"ADMIN_SEQUENCE",duration_minutes:0})]);
    await pool.query("INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id) VALUES($1,1,$2,'ifood',$3)",
      [fakeDispatch,orderNumber,orderId]);
    const path="/api/courier/dispatches/"+fakeDispatch+"/incidents";
    const created=await must(path,cookies[0],"POST",{platform:"ifood",order_id:orderId,reason:"CODE_UNAVAILABLE"},201);
    const incidentId=Number(created.value.incident.id);assert.ok(incidentId>0);
    await must(path,cookies[1],"POST",{platform:"ifood",order_id:orderId,reason:"CODE_UNAVAILABLE"},404);
    const approval=await must("/api/admin/delivery-incidents/"+incidentId+"/decision",adminCookie,"POST",
      {action:"APPROVE_CONTINUE",reason:"Codigo ainda indisponivel, seguir orientacao"},200);
    assert.equal(approval.value.incident.status,"CONTINUE_APPROVED");
    const view=(await must("/api/courier/pre-departure",cookies[0],"GET",null,200)).value.route;
    assert.equal(view.stops[0].is_deferred,true);
    assert.equal(view.stops[0].state,"PENDING");
    assert.equal(view.stops.filter(x=>x.is_next).length,0);
    const noConfirm=await pool.query("SELECT count(*)::int AS n FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",[orderId]);
    assert.equal(noConfirm.rows[0].n,0,"caixa nao deve validar codigo");
    await pool.query("UPDATE ifood_orders SET status='DELIVERED' WHERE order_id=$1",[orderId]);
    const list=await must("/api/admin/delivery-incidents",adminCookie,"GET",null,200);
    assert.ok(!list.value.incidents.some(x=>Number(x.id)===incidentId),"sync deve resolver ocorrencia apos confirmacao de plataforma");
    const resolved=(await pool.query("SELECT status FROM dispatch_delivery_incidents WHERE id=$1",[incidentId])).rows[0];
    assert.equal(resolved.status,"RESOLVED");
    incidentValidation.ifood_no_code_validated=true;
    incidentValidation.external_confirmation_reconciled=true;
  }
  assert.equal(Object.keys(incidentValidation).length,10,"dez verificacoes de ocorrencia");
}finally{await pool.end().catch(()=>{});}
