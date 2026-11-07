/**
 * Real HTTP + ephemeral local PostgreSQL 16. Faulty ORS is intercepted by
 * scripts/mock-ors-chaos.js; zero external calls, zero real customer orders.
 */
import assert from "node:assert/strict";
import pg from "pg";
import bcrypt from "bcryptjs";
import {performance} from "node:perf_hooks";

const db=new URL(String(process.env.DATABASE_URL||""));
const server=new URL(String(process.env.TARGET_URL||""));
const reqs={APP_ENV:"staging",STAGING_SAFE_MODE:"true",NODE_ENV:"test",
  ROUTE_CHAOS_MOCK_ONLY:"YES",LOAD_TEST_CONFIRM:"STAGING_ONLY_I_UNDERSTAND",
  OPENROUTESERVICE_API_KEY:"CHAOS_SYNTHETIC_STAGING_ONLY"};
for(const [k,v] of Object.entries(reqs))assert.equal(process.env[k],v,"Isolated chaos only: "+k);
assert.ok(["127.0.0.1","localhost"].includes(db.hostname));
assert.ok(["127.0.0.1","localhost"].includes(server.hostname));
assert.equal(db.pathname,"/despachefull_chaos");
assert.equal(server.port,"3000");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:12});
const run="ch"+Math.random().toString(36).slice(2,9);
const password="EphemeralChaosOnly!"+Math.random().toString(36).slice(2);
const origin={latitude:-23.6244855,longitude:-46.5549218};
const modes=[
  {name:"http429",marker:-23.61111,error:"ROUTES_RATE_LIMITED"},
  {name:"http503",marker:-23.62222,error:"ROUTES_SERVICE_FAILED"},
  {name:"network_disconnect",marker:-23.63333,error:"ROUTES_SERVICE_FAILED"},
  {name:"partial_matrix",marker:-23.64444,error:"ROUTE_MATRIX_INCOMPLETE"},
  {name:"provider_timeout",marker:-23.65555,error:"ROUTES_SERVICE_FAILED"},
  {name:"healthy_control",marker:-23.66666,error:null}
];
const results=[],stats={};
async function request(path,cookie="",method="GET",body=null) {
  const response=await fetch(server.origin+path,{
    method,headers:{"content-type":"application/json","accept":"application/json",...(cookie?{cookie}:{})},
    ...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)
  });
  stats[response.status]=(stats[response.status]||0)+1;
  const value=await response.json().catch(()=>({}));
  return {status:response.status,data:value,cookie:(response.headers.get("set-cookie")||"").split(";")[0]};
}
async function must(path,cookie,method,body,code) {
  const x=await request(path,cookie,method,body);
  assert.equal(x.status,code,method+" "+path+" expected "+code+" got "+x.status+
    " code "+String(x.data?.code||x.data?.error||"").slice(0,95));
  return x.data;
}
async function login(username,secret=password) {
  const x=await request("/api/login","","POST",{username,password:secret});
  assert.equal(x.status,200,"test login");
  assert.ok(x.cookie.startsWith("connect.sid="),"session");
  return x.cookie;
}
async function prepare() {
  const health=await must("/api/health","","GET",null,200);
  assert.equal(health.environment,"staging");
  assert.equal(health.database,"connected");
  assert.equal(health.stagingSafeMode,true);
  assert.equal(health.externalMutationsAllowed,false);
  const admin=await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  assert.ok(admin.rows.length,"test admin required");
  const auth=await login(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
  const params=[
    ["pre_departure_enabled","true"],["route_planner_enabled","true"],
    ["address_correction_enabled","false"],
    ["route_store_origin",JSON.stringify({...origin,source:"ADMIN_CONFIRMED",confirmed_at:new Date().toISOString()})]
  ];
  for(const [setting_key,setting_value] of params)await pool.query(
    "INSERT INTO app_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value",
    [setting_key,setting_value]);
  return {auth,adminId:admin.rows[0].id};
}
async function createFixture(index,marker,adminId) {
  const hash=await bcrypt.hash(password,10);
  const username=run+"_"+index;
  const user=(await pool.query(
    "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE) RETURNING id",
    ["Chaos fictitious courier",username,hash])).rows[0];
  const courierId=user.id;
  await pool.query(
    "INSERT INTO courier_attendance(courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason) VALUES($1,'2026-09-29','LUNCH','2026-09-29T15:00:00Z','ADMIN',$2,'Chaos synthetic staging')",
    [courierId,adminId]);
  const orders=[];
  for(let i=0;i<2;i++){
    const orderId=run+"_"+index+"_"+i;
    const display="8"+String(index+1)+String(i+1).padStart(6,"0");
    const lat=i===0?marker:origin.latitude-0.003-index*0.0001;
    const lon=origin.longitude+0.004+index*0.00015+i*0.00009;
    const payload={deliveryAddress:{streetName:"Rua Ficticia",streetNumber:String(101+index*2+i),
      neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP",
      coordinates:{latitude:lat,longitude:lon}},customer:{name:"Fictitious staging client"}};
    await pool.query(
      "INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'chaos-fake-only',$2,'READY','DELIVERY','2026-09-29T15:00:00Z','2026-09-29T15:00:00Z',$3::jsonb,'Cliente Ficticio')",
      [orderId,display,JSON.stringify(payload)]);
    orders.push({id:orderId,display});
  }
  return {courierId,cookie:await login(username),orders};
}
async function exercise(item,index,adminCookie,adminId) {
  const data=await createFixture(index,item.marker,adminId);
  const {cookie,orders}=data;
  const numbers=orders.map(o=>"#"+o.display);
  const selections=numbers.map(order_number=>({order_number,platform:"anotaai"}));
  let pd=(await must("/api/courier/pre-departures",cookie,"POST",
    {order_numbers:numbers,order_count:2,platform_selections:selections},201)).pre_departure;
  assert.equal(pd.counts.checked,0);
  for(const o of pd.orders) {
    pd=(await must("/api/courier/pre-departures/"+pd.id+"/orders/"+o.id+"/check",cookie,"POST",
      {composition_version:pd.composition_version,checked:true},200)).pre_departure;
  }
  const t0=performance.now();
  pd=(await must("/api/courier/pre-departures/"+pd.id+"/route",cookie,"POST",{},200)).pre_departure;
  const routingMs=Math.round(performance.now()-t0);
  if(item.error) {
    assert.equal(pd.status,"BLOCKED","provider failure must block");
    assert.equal(pd.route_status,"NEEDS_ADMIN");
    assert.equal(pd.route,null,"fake route forbidden");
    assert.equal(pd.route_error.code,item.error,"fault "+item.name);
    assert.equal(pd.can_dispatch,false);
    const denied=await request("/api/courier/depart",cookie,"POST",
      {pre_departure_id:pd.id,composition_version:pd.composition_version});
    assert.equal(denied.status,409,"departure blocked until admin override");
    const override=(await must("/api/admin/pre-departures/"+pd.id+"/sequence",adminCookie,"POST",
      {reason:"Provedor falhou no teste de caos: "+item.name},200)).pre_departure;
    assert.equal(override.route_status,"ADMIN");
    assert.equal(override.route.source,"ADMIN_SEQUENCE");
    assert.equal(override.ack_required,true);
    assert.equal(override.can_dispatch,false);
    const unack=await request("/api/courier/depart",cookie,"POST",
      {pre_departure_id:override.id,composition_version:override.composition_version});
    assert.equal(unack.status,409,"cannot depart before acknowledging");
    pd=(await must("/api/courier/pre-departures/"+pd.id+"/ack",cookie,"POST",
      {version:override.version},200)).pre_departure;
    assert.equal(pd.ack_required,false);
    assert.equal(pd.can_dispatch,true);
    const events=(await pool.query("SELECT event FROM pre_departure_events WHERE pre_departure_id=$1",[pd.id])).rows.map(x=>x.event);
    assert.ok(events.includes("ROUTE_NEEDS_ADMIN"));
    assert.ok(events.includes("ADMIN_SEQUENCE"));
    assert.ok(events.includes("ADDRESS_CHANGE_ACKNOWLEDGED"));
  } else {
    assert.equal(pd.route_status,"READY");
    assert.equal(pd.route.source,"ROAD_MATRIX");
    assert.equal(pd.route.stops.length,2);
    assert.equal(pd.can_dispatch,true);
  }
  const sent=await must("/api/courier/depart",cookie,"POST",
    {pre_departure_id:pd.id,composition_version:pd.composition_version},201);
  const dispatchId=Number(sent.dispatch?.id);
  assert.ok(dispatchId>0);
  const routeStatus=(await pool.query("SELECT route_status FROM dispatch_routes WHERE dispatch_id=$1",[dispatchId])).rows[0]?.route_status;
  assert.equal(routeStatus,item.error?"ADMIN":"READY");
  const unfinished=await pool.query(
    "SELECT count(*)::int n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=ANY($1::text[])",[orders.map(o=>o.id)]);
  assert.equal(Number(unfinished.rows[0].n),0,"no fake confirmation");
  assert.equal((await pool.query("SELECT status FROM dispatches WHERE id=$1",[dispatchId])).rows[0].status,"ON_ROAD");
  for(const o of orders){
    const c=await must("/api/courier/anotaai/orders/"+o.id+"/confirm-delivery",cookie,"POST",{},200);
    assert.equal(c.confirmed,true);
  }
  assert.equal((await pool.query("SELECT status FROM dispatches WHERE id=$1",[dispatchId])).rows[0].status,"RELEASED");
  assert.equal(Number((await pool.query(
    "SELECT count(*)::int n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=ANY($1::text[])",[orders.map(o=>o.id)])).rows[0].n),2);
  return {type:item.name,result:"PASS",code:item.error||null,routeMs:routingMs,
    blockedBeforeAdmin:Boolean(item.error),manualFallback:Boolean(item.error),
    acknowledged:Boolean(item.error),noFalseDeliveries:true,
    afterSyntheticConfirm:"RELEASED"};
}
async function runSimultaneousOutage(adminCookie,adminId) {
  // All couriers receive synthetic ORS 429 during the same route-computation wave.
  // Real HTTP and DB reservations; provider API itself is mocked.
  const B=36,fixtures=[];
  for(let i=0;i<B;i++)fixtures.push(await createFixture(i+6,-23.61111,adminId));
  for(const x of fixtures) {
    const nums=x.orders.map(o=>"#"+o.display);
    const selections=nums.map(order_number=>({order_number,platform:"anotaai"}));
    let pd=(await must("/api/courier/pre-departures",x.cookie,"POST",
      {order_numbers:nums,order_count:2,platform_selections:selections},201)).pre_departure;
    for(const order of pd.orders)pd=(await must(
      "/api/courier/pre-departures/"+pd.id+"/orders/"+order.id+"/check",
      x.cookie,"POST",{composition_version:pd.composition_version,checked:true},200)).pre_departure;
    x.pd=pd;
  }
  const start=performance.now();
  const routes=await Promise.all(fixtures.map(x=>
    must("/api/courier/pre-departures/"+x.pd.id+"/route",x.cookie,"POST",{},200)
  ));
  const wallMs=Math.round(performance.now()-start);
  const reasonCounts={};
  for(let i=0;i<B;i++){
    const pd=routes[i].pre_departure;
    assert.equal(pd.status,"BLOCKED","simultaneous outage never sends courier away");
    assert.equal(pd.route_status,"NEEDS_ADMIN");
    assert.equal(pd.route,null);
    assert.equal(pd.can_dispatch,false);
    assert.ok(["ROUTES_RATE_LIMITED","ROUTES_RATE_LIMITED_LOCAL"].includes(pd.route_error?.code),pd.route_error?.code);
    reasonCounts[pd.route_error.code]=(reasonCounts[pd.route_error.code]||0)+1;
    fixtures[i].pd=pd;
  }
  const ids=fixtures.map(x=>x.courierId);
  const before=await pool.query("SELECT count(*)::int n FROM dispatches WHERE courier_id=ANY($1::int[])",[ids]);
  assert.equal(Number(before.rows[0].n),0,"36 blocked routes must not create dispatches");
  const confirmedBefore=await pool.query(
    "SELECT count(*)::int n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=ANY($1::text[])",
    [fixtures.flatMap(x=>x.orders.map(o=>o.id))]);
  assert.equal(Number(confirmedBefore.rows[0].n),0,"No forged deliveries under mass outage");
  const latencies=[];
  for(const x of fixtures){
    const t=performance.now();
    let pd=(await must("/api/admin/pre-departures/"+x.pd.id+"/sequence",adminCookie,"POST",
      {reason:"Autorizacao manual do caixa sob pane simultanea em homologacao"},200)).pre_departure;
    assert.equal(pd.route_status,"ADMIN");
    assert.equal(pd.ack_required,true);
    pd=(await must("/api/courier/pre-departures/"+pd.id+"/ack",x.cookie,"POST",
      {version:pd.version},200)).pre_departure;
    assert.equal(pd.can_dispatch,true);
    const d=await must("/api/courier/depart",x.cookie,"POST",
      {pre_departure_id:pd.id,composition_version:pd.composition_version},201);
    assert.ok(Number(d.dispatch.id)>0);
    latencies.push(Math.round(performance.now()-t));
    for(const order of x.orders){
      const completed=await must("/api/courier/anotaai/orders/"+order.id+"/confirm-delivery",
        x.cookie,"POST",{},200);
      assert.equal(completed.confirmed,true);
    }
    const state=(await pool.query("SELECT status FROM dispatches WHERE id=$1",[d.dispatch.id])).rows[0];
    assert.equal(state.status,"RELEASED");
  }
  const percentile=(vals,p)=>[...vals].sort((a,b)=>a-b)[Math.max(0,Math.ceil(vals.length*p)-1)];
  return {couriers:B,orders:B*2,result:"PASS",mockProvider429:B,
    blockedBeforeOverride:B,manuallyRecovered:B,releasedAfterSyntheticConfirm:B,
    unexpectedConfirmations:0,peakRouteWaveMs:wallMs,
    adminRecoveryPerCourierP95Ms:percentile(latencies,.95),
    routeErrors:reasonCounts};
}
try {
  const {auth,adminId}=await prepare();
  for(const [i,item] of modes.entries()){
    const x=await exercise(item,i,auth,adminId);
    results.push(x);
    console.log("CHAOS_CASE_PASS "+JSON.stringify(x));
  }
  const burst=await runSimultaneousOutage(auth,adminId);
  const reservations=Number((await pool.query(
    "SELECT count(*)::int n FROM route_matrix_quota_ledger WHERE scope='ORS_MATRIX'")).rows[0].n);
  assert.ok(reservations>=modes.length && reservations<=modes.length+burst.couriers,
    "Rate limiter records no more than the attempted Matrix calls");
  assert.equal(results.filter(x=>x.blockedBeforeAdmin).length,5);
  assert.equal(results.length,6);
  console.log("ROUTE_CHAOS_REPORT_START");
  console.log(JSON.stringify({result:"PASS",mode:"REAL_HTTP_POSTGRES16_MOCK_EXTERNAL_ORS",
    scenarios:results.length,blockedThenManual:5,providerLiveCalls:0,
    productionTouched:false,unexpectedConfirmations:0,quotaReservations:reservations,
    burst, statuses:stats,results},null,2));
  console.log("ROUTE_CHAOS_REPORT_END");
} finally {
  await pool.end().catch(()=>{});
}
