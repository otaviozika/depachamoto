/**
 * Concurrency validation for delivery incidents, independent of the one-courier
 * HTTP pilot gate. Executed ONLY against the ephemeral local GitHub Actions
 * PostgreSQL seeded by the Friday-600 workflow. Zero external provider calls.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import pg from "pg";
import bcrypt from "bcryptjs";
import { createDeliveryIncidentService } from "../lib/delivery-incidents.js";
import { createPreDepartureService } from "../lib/pre-departure-service.js";

const target=new URL(String(process.env.TARGET_URL||""));
const database=new URL(String(process.env.DATABASE_URL||""));
assert.equal(process.env.APP_ENV,"staging");
assert.equal(process.env.STAGING_SAFE_MODE,"true");
assert.equal(process.env.LOAD_TEST_CONFIRM,"STAGING_ONLY_I_UNDERSTAND");
assert.equal(process.env.FRIDAY_MOCK_ORS_ONLY,"YES");
assert.equal(process.env.OPENROUTESERVICE_API_KEY,"FRIDAY_SYNTHETIC_STAGING_ONLY");
assert.notEqual(process.env.NODE_ENV,"production");
assert.ok(["localhost","127.0.0.1"].includes(target.hostname));
assert.ok(["localhost","127.0.0.1"].includes(database.hostname));
assert.equal(decodeURIComponent(database.pathname.slice(1)),"despachefull_staging");

const N=40, pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:24,connectionTimeoutMillis:15000});
const run="inc_race_"+Date.now().toString(36);
const users=[],dispatches=[],ifoodOrders=[],anotaOrders=[],latency={};
const events=[],notified=[];
let adminId=null,failed=false,finalReport=null;
const incidents=createDeliveryIncidentService({pool,
  audit:async()=>{},notify:async note=>{notified.push(note);},
  emitRealtime:(type,payload)=>{events.push({type,change:payload?.change});}
});
const routes=createPreDepartureService({pool,
  describeOrder:()=>({customer_name:"CLIENTE SINTETICO - NAO ENTREGAR",
    navigation:{latitude:-23.6245,longitude:-46.5549,address:"Rua Ficticia, Sao Caetano do Sul",address_complete:true}}),
  audit:async()=>{},emitRealtime:()=>{}
});
function ms(start){return Math.round((performance.now()-start)*100)/100;}
function p95(xs){const a=[...xs].sort((x,y)=>x-y);return a.length?a[Math.ceil(a.length*.95)-1]:null;}
function assertSafeCode(e,code){return e?.code===code;}
async function expectedFailure(task,code){
  await assert.rejects(task,e=>assertSafeCode(e,code),"Expected "+code);
}
async function phase(name,fnList){
  const t=performance.now();
  const settled=await Promise.allSettled(fnList.map(fn=>fn()));
  const errors=settled.map((r,i)=>r.status==="rejected"?{index:i,error:String(r.reason?.message||r.reason).slice(0,180)}:null).filter(Boolean);
  latency[name]={count:fnList.length,elapsed_ms:ms(t),p95_ms:p95(settled.filter(x=>x.status==="fulfilled").map(x=>x.value?.elapsed_ms).filter(x=>Number.isFinite(x)))};
  if(errors.length)throw new Error(name+" failed "+JSON.stringify(errors.slice(0,5)));
  return settled.map(x=>x.value);
}
async function timed(fn){const t=performance.now();const result=await fn();return {result,elapsed_ms:ms(t)};}
async function seed(){
  assert.equal((await pool.query("SELECT current_database() AS db")).rows[0].db,"despachefull_staging");
  adminId=Number((await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0]?.id);
  assert.ok(Number.isInteger(adminId)&&adminId>0);
  const hash=await bcrypt.hash("SyntheticNeverUsed-OnlyForDB-987654",7);
  for(let i=0;i<N;i++){
    const u=(await pool.query(
      "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE) RETURNING id",
      ["INCIDENTE TESTE SINTETICO "+i,run+"_"+i,hash])).rows[0];
    users.push(Number(u.id));
    const platform=i%2===0?"ifood":"anotaai";
    const number="#"+String(97000000+i);
    const dispatchId=Number((await pool.query(
      "INSERT INTO dispatches(dispatch_code,order_number,courier_id) VALUES($1,$2,$3) RETURNING id",
      [run+"_dispatch_"+i,number,u.id])).rows[0].id);
    dispatches.push({id:dispatchId,courierId:Number(u.id),platform,ids:[]});
    await pool.query("INSERT INTO dispatch_routes(dispatch_id,route_version,route_status,route,acked_version) VALUES($1,1,'ADMIN',$2::jsonb,1)",
      [dispatchId,JSON.stringify({source:"ADMIN_SEQUENCE",duration_minutes:0})]);
    for(let j=0;j<2;j++){
      const orderId=run+"_order_"+i+"_"+j;
      const n="#"+String(97000000+i)+"-"+j;
      dispatches[i].ids.push(orderId);
      if(platform==="ifood"){
        ifoodOrders.push(orderId);
        await pool.query("INSERT INTO ifood_orders(order_id,display_id,status,order_type,delivered_by,is_test) VALUES($1,$2,'DISPATCHED','DELIVERY','MERCHANT',TRUE)",[orderId,n.slice(1)]);
      } else {
        anotaOrders.push(orderId);
        await pool.query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,customer_name) VALUES($1,'incident-race-ephemeral',$2,'READY','DELIVERY','CLIENTE TESTE')",[orderId,n.slice(1)]);
      }
      await pool.query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,$3)",[dispatchId,n,platform]);
      await pool.query("INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id) VALUES($1,$2,$3,$4,$5)",[dispatchId,j+1,n,platform,orderId]);
    }
  }
  assert.equal(dispatches.length,40);
}
async function runTests(){
  const reports=[];
  for(const d of dispatches)for(let x=0;x<3;x++)reports.push(async()=>timed(()=>incidents.report({
    courierId:d.courierId,dispatchId:d.id,platform:d.platform,orderId:d.ids[0],
    reason:d.platform==="ifood"?"CODE_UNAVAILABLE":"CLIENT_NOT_FOUND"
  })));
  const results=await phase("120_concurrent_reports",reports);
  assert.equal(results.filter(x=>x.result.created).length,40,"Exactly one new incident per order");
  assert.equal(results.filter(x=>!x.result.created).length,80,"Duplicate reports must be idempotent");
  const incidentIds=new Map();
  for(const r of results)incidentIds.set(Number(r.result.incident.dispatch_id),Number(r.result.incident.id));
  assert.equal(incidentIds.size,40);
  await phase("40_courier_cross_isolation",dispatches.map((d,i)=>async()=>timed(()=>expectedFailure(
    ()=>incidents.report({courierId:dispatches[(i+1)%N].courierId,dispatchId:d.id,
      platform:d.platform,orderId:d.ids[0],reason:"CLIENT_NOT_FOUND"}),"INCIDENT_DISPATCH_NOT_FOUND"))));
  await phase("20_anota_code_rejections",dispatches.filter(d=>d.platform==="anotaai").map(d=>async()=>timed(()=>expectedFailure(
    ()=>incidents.report({courierId:d.courierId,dispatchId:d.id,platform:d.platform,orderId:d.ids[0],reason:"CODE_UNAVAILABLE"}),"INCIDENT_CODE_ONLY_IFOOD"))));
  const decisions=[];
  for(const d of dispatches)for(let k=0;k<3;k++)decisions.push(async()=>timed(()=>incidents.decide({
    adminId,incidentId:incidentIds.get(d.id),action:"APPROVE_CONTINUE",reason:"Teste concorrente: liberar proxima parada"
  })));
  const approvals=await phase("120_concurrent_admin_approvals",decisions);
  assert.equal(approvals.filter(x=>x.result.changed).length,40,"Only one approval change per incident");
  assert.equal(approvals.filter(x=>!x.result.changed).length,80);
  const approvedViews=await phase("40_approved_route_reads",dispatches.map(d=>async()=>timed(async()=>{
    const v=await routes.dispatchRouteView(d.id);
    assert.equal(v.route_version,2);
    assert.equal(v.ack_required,true);
    assert.equal(v.stops[0].state,"PENDING");
    assert.equal(v.stops[0].is_deferred,true);
    assert.equal(v.stops[1].is_next,true);
    assert.equal(v.counts.delivered,0);
    return v;
  })));
  assert.equal(approvedViews.length,40);
  await phase("40_stale_ack_rejections_v1",dispatches.map(d=>async()=>timed(()=>expectedFailure(
    ()=>routes.acknowledgeRoute({courierId:d.courierId,dispatchId:d.id,routeVersion:1}),"ROUTE_VERSION_CONFLICT"))));
  await phase("40_valid_acks_v2",dispatches.map(d=>async()=>timed(async()=>{
    const v=await routes.acknowledgeRoute({courierId:d.courierId,dispatchId:d.id,routeVersion:2});
    assert.equal(v.ack_required,false);
    assert.equal(v.acked_version,2);
  })));
  const retries=[];
  for(const d of dispatches)for(let k=0;k<2;k++)retries.push(async()=>timed(()=>incidents.decide({
    adminId,incidentId:incidentIds.get(d.id),action:"REQUIRE_RETRY",reason:"Teste concorrente: retornar ao endereco original"
  })));
  const retried=await phase("80_concurrent_admin_retries",retries);
  assert.equal(retried.filter(x=>x.result.changed).length,40);
  assert.equal(retried.filter(x=>!x.result.changed).length,40);
  await phase("40_stale_ack_rejections_v2",dispatches.map(d=>async()=>timed(()=>expectedFailure(
    ()=>routes.acknowledgeRoute({courierId:d.courierId,dispatchId:d.id,routeVersion:2}),"ROUTE_VERSION_CONFLICT"))));
  await phase("40_restored_route_checks",dispatches.map(d=>async()=>timed(async()=>{
    const v=await routes.dispatchRouteView(d.id);
    assert.equal(v.route_version,3);
    assert.equal(v.ack_required,true);
    assert.equal(v.stops[0].is_next,true);
    assert.equal(v.stops[0].is_deferred,false);
    assert.equal(v.stops[1].is_next,false);
    assert.equal(v.counts.pending,2);
  })));
  await phase("40_valid_acks_v3",dispatches.map(d=>async()=>timed(async()=>{
    const v=await routes.acknowledgeRoute({courierId:d.courierId,dispatchId:d.id,routeVersion:3});
    assert.equal(v.ack_required,false);
  })));
  const checks=(await pool.query(
    "SELECT (SELECT count(*)::int FROM dispatch_delivery_incidents WHERE dispatch_id=ANY($1::bigint[])) incidents,"+
    "(SELECT count(*)::int FROM ifood_delivery_confirmations WHERE ifood_order_id=ANY($2::text[])) ifood_confirmed,"+
    "(SELECT count(*)::int FROM anotaai_delivery_confirmations WHERE anotaai_order_id=ANY($3::text[])) anota_confirmed,"+
    "(SELECT count(*)::int FROM dispatches WHERE id=ANY($1::bigint[]) AND status='ON_ROAD') on_road",
    [dispatches.map(d=>d.id),ifoodOrders,anotaOrders])).rows[0];
  assert.equal(checks.incidents,40);
  assert.equal(checks.ifood_confirmed,0);
  assert.equal(checks.anota_confirmed,0);
  assert.equal(checks.on_road,40,"No courier was released by incident decisions");
  // Provider events are synthetic SQL updates, not iFood/Anota AI API calls.
  await pool.query("UPDATE ifood_orders SET status='DELIVERED' WHERE order_id=ANY($1::text[])",
    [dispatches.filter(d=>d.platform==="ifood").map(d=>d.ids[0])]);
  await pool.query("UPDATE anotaai_orders SET status='FINISHED' WHERE order_id=ANY($1::text[])",
    [dispatches.filter(d=>d.platform==="anotaai").map(d=>d.ids[0])]);
  const pending=await incidents.list({includeResolved:false,limit:100});
  assert.equal(pending.length,0,"All 40 incidents must reconcile after synthetic provider confirmations");
  const count=(await pool.query("SELECT count(*)::int AS n FROM dispatch_delivery_incidents WHERE dispatch_id=ANY($1::bigint[]) AND status='RESOLVED'",
    [dispatches.map(d=>d.id)])).rows[0].n;
  assert.equal(count,40);
  assert.equal(notified.length,40,"One notification for each new incident");
  assert.equal(events.filter(e=>e.change==="DELIVERY_INCIDENT_OPENED").length,40);
  return {checks,confirmed_by_synthetic_provider:count};
}
try{
  const t=performance.now();
  await seed();
  const result=await runTests();
  finalReport={result:"PASS",couriers:40,synthetic_orders:80,unique_incidents:40,
    concurrent_report_calls:120,concurrent_approval_calls:120,concurrent_retry_calls:80,
    no_external_provider_calls:true,environment:"ephemeral local PostgreSQL",
    duration_ms:ms(t),latency,assertions:result};
  console.log("INCIDENT_CONCURRENCY_40_PASS "+JSON.stringify(finalReport));
}catch(e){
  failed=true;
  console.error("INCIDENT_CONCURRENCY_40_FAIL "+JSON.stringify({
    error:String(e?.stack||e).slice(0,1300),run,latency,created_dispatches:dispatches.length
  }));
}finally{
  // CI database is ephemeral, but verify that synthetic fixture removal succeeds.
  try{
    if(dispatches.length){
      const ids=dispatches.map(d=>d.id);
      await pool.query("DELETE FROM dispatches WHERE id=ANY($1::bigint[])",[ids]);
      const remaining=(await pool.query("SELECT count(*)::int AS n FROM dispatch_delivery_incidents WHERE dispatch_id=ANY($1::bigint[])",[ids])).rows[0].n;
      assert.equal(remaining,0,"No orphan incidents after dispatch delete");
    }
    if(ifoodOrders.length)await pool.query("DELETE FROM ifood_orders WHERE order_id=ANY($1::text[])",[ifoodOrders]);
    if(anotaOrders.length)await pool.query("DELETE FROM anotaai_orders WHERE order_id=ANY($1::text[])",[anotaOrders]);
    if(users.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[users]);
    console.log("INCIDENT_CONCURRENCY_40_CLEANUP_OK "+JSON.stringify({dispatches:dispatches.length,orders:ifoodOrders.length+anotaOrders.length}));
  }catch(e){failed=true;console.error("INCIDENT_CONCURRENCY_40_CLEANUP_FAIL "+String(e?.message||e).slice(0,400));}
  await pool.end();
}
if(failed)process.exitCode=1;
