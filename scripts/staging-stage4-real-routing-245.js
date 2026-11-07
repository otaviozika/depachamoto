/**
 * Stage 4: isolated staging route-engine smoke with real ORS Matrix (2,3,5 synthetic stops),
 * bag-check gates, rejected early dispatch, admin fallback and rollback.
 * Runs once via temporary staging-only npm start. No iFood/AnotaAI writes.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { createPreDepartureService } from "../lib/pre-departure-service.js";
import { createQuotaManagedTravelClient } from "../lib/route-quota.js";

const DB_NAME = "despachefull_incidentes_homologacao";
const HOST_FRAGMENT = "dbn9n1psrm7s738pu81g";
const env = process.env;
const url = new URL(String(env.DATABASE_URL || ""));
assert.equal(env.APP_ENV, "staging", "FORBIDDEN: not staging");
assert.equal(env.STAGING_SAFE_MODE, "true", "FORBIDDEN: staging safety not enabled");
assert.equal(decodeURIComponent(url.pathname.slice(1)), DB_NAME, "FORBIDDEN: wrong database");
assert.ok(url.hostname.includes(HOST_FRAGMENT), "FORBIDDEN: wrong database host");
assert.ok(env.OPENROUTESERVICE_API_KEY?.trim(), "ORS key missing");
assert.notEqual(String(env.ROUTE_PROVIDER || "").toLowerCase(), "google", "Expected ORS");
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 4,
  connectionTimeoutMillis: 12000
});
const tag = "s4-" + randomBytes(5).toString("hex");
const created = {users: [], orders: [], preDepartures: []};
const report = {result:"PENDING", mode:"STAGING_SERVICE_REAL_ORS", cases:[], realMatrixExpected:3,
  productionTouched:false, customerDataUsed:false, externalPlatformMutations:false,
  appFlagsChanged:false, directDispatchesCreated:0};
let error = null;

// Wrap ONLY this test's query view: route_planner=true for test methods, without
// changing any app_settings entry visible to real staging users.
function virtualSettings(sql, result) {
  if (!String(sql).includes("SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY")) return result;
  const rows = result.rows.filter(row => row.setting_key !== "route_planner_enabled");
  rows.push({setting_key:"route_planner_enabled",setting_value:"true"});
  return {...result, rows, rowCount:rows.length};
}
const isolatedPool = {
  query: async (...args) => virtualSettings(args[0], await pool.query(...args)),
  connect: async () => {
    const client = await pool.connect();
    return {query:async (...args)=>virtualSettings(args[0],await client.query(...args)),release:()=>client.release()};
  }
};
const describeOrder = (_platform, payload) => {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  const a = value?.deliveryAddress || {};
  const latitude = Number(a?.coordinates?.latitude),longitude=Number(a?.coordinates?.longitude);
  return {
    navigation:{latitude,longitude,address:"ENDERECO SINTETICO PARA TESTE",address_complete:true},
    fields:{street:"Rua Teste Ficticia",number:"123",neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP"},
    customer_name:"CLIENTE SINTETICO - NAO ENTREGAR"
  };
};
const service = createPreDepartureService({pool:isolatedPool,describeOrder,env,
  routesClientFactory:()=>createQuotaManagedTravelClient({env,pool:isolatedPool})});
const failClient = createPreDepartureService({pool:isolatedPool,describeOrder,env,
  routesClientFactory:()=>({provider:"openrouteservice",async travelMatrix(){
    throw Object.assign(new Error("Synthetic ORS 429"),{status:503,code:"ROUTES_RATE_LIMITED"});
  }})});
const pinOffsets = [
  [0.0007,0.0006],[-0.0005,0.0012],[0.0015,-0.0007],
  [-0.0014,-0.0007],[0.0001,-0.0019],[0.0021,0.0013],
  [-0.0022,0.0008]
];
function assertRoute(v,n) {
  assert.equal(v.status,"ROUTE_READY","Route not ready: "+String(v.route_error?.code || v.status));
  assert.equal(v.can_dispatch,true,"Dispatch eligibility not established");
  assert.equal(v.route?.provider,"openrouteservice","Real ORS provider not selected");
  assert.equal(v.route?.source,"ROAD_MATRIX","A real road-time matrix was not used");
  assert.equal(v.route?.stops?.length,n,"Wrong stop count");
  const permutations = [0,1,2,6,24,120][n];
  assert.equal(v.route?.evaluated,permutations,"Not all permutations were evaluated");
  assert.ok(Number(v.route?.duration_minutes)>0,"Missing ETA");
  assert.ok(Number(v.route?.fastest_duration_minutes)>0,"Missing fastest ETA");
  const extra = Number(v.route.duration_minutes)-Number(v.route.fastest_duration_minutes);
  const allowed = Math.min(Number(v.route.fastest_duration_minutes)*0.10,3);
  assert.ok(extra<=allowed+0.21,"Suggested route violates 10%/3 min limit");
  assert.equal(new Set(v.route.stops.map(x=>x.external_order_id)).size,n,"Duplicate stop");
  assert.ok(v.route.stops.every(x=>Number.isFinite(Number(x.latitude)) && Number.isFinite(Number(x.longitude))),"Missing navigation pin");
  assert.ok(v.orders.every(x=>x.checked && x.navigation?.latitude && x.navigation?.longitude),"Unchecked bag or absent navigation");
}
async function seedCase(n, group, origin) {
  const hash=await bcrypt.hash(randomBytes(28).toString("base64url"),8);
  const usr=await pool.query("INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',true,false) RETURNING id",
    ["HOMOLOGACAO ETAPA 4",tag+"-courier-"+group,hash]);
  const courierId=Number(usr.rows[0].id);created.users.push(courierId);
  const links=[];
  for(let i=0;i<n;i++){
    const k = (group * 10 + i) % pinOffsets.length;
    const d=pinOffsets[k];
    // Unique synthetic coordinates avoid cache replays and customer locations.
    const point={latitude:origin.latitude+d[0]+group*0.000013+i*0.000009,
      longitude:origin.longitude+d[1]+group*0.000011-i*0.000007};
    const orderId=tag+"-anota-"+group+"-"+i;
    const display=String(88000000+Math.floor(Math.random()*9000000));
    const orderNumber="#"+display;
    const payload={deliveryAddress:{streetName:"Rua Teste Ficticia",streetNumber:"123",
      neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP",coordinates:point},
      customer:{name:"CLIENTE SINTETICO - NAO ENTREGAR"}};
    await pool.query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'staging-stage4-only',$2,'READY','DELIVERY',NOW()-($3::int * INTERVAL '1 minute'),NOW(),$4::jsonb,'CLIENTE SINTETICO - NAO ENTREGAR')",
      [orderId,display,8+i*7,JSON.stringify(payload)]);
    created.orders.push(orderId);
    links.push({platform:"anotaai",order_id:orderId,order_number:orderNumber});
  }
  const pd=await service.create({courierId,links});
  created.preDepartures.push(pd.id);
  assert.equal(pd.counts.total,n);
  assert.equal(pd.counts.checked,0);
  return {courierId,pd};
}
async function checkBags(courierId,pd) {
  for (const row of pd.orders) {
    pd=await service.setCheck({courierId,id:pd.id,orderId:row.id,compositionVersion:pd.composition_version,checked:true});
  }
  assert.equal(pd.counts.checked,pd.counts.total);
  return pd;
}
try {
  const identity=await pool.query("SELECT current_database() AS name");
  assert.equal(identity.rows[0]?.name,DB_NAME);
  const flags=await pool.query("SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [["pre_departure_enabled","route_planner_enabled","address_correction_enabled","delivery_incidents_enabled"]]);
  assert.ok(!flags.rows.find(x=>x.setting_key==="route_planner_enabled"&&x.setting_value==="true"),
    "Route planner already enabled in staging: avoid changing active operation");
  const saved=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='route_store_origin'");
  assert.equal(saved.rowCount,1,"Admin did not confirm store origin");
  const origin=JSON.parse(saved.rows[0].setting_value);
  assert.equal(origin.source,"ADMIN_CONFIRMED","Origin not explicitly confirmed by admin");
  assert.ok(Number.isFinite(Number(origin.latitude)) && Number.isFinite(Number(origin.longitude)));
  for (const n of [2,3,5]){
    const started=Date.now();
    const {courierId,pd:initial}=await seedCase(n,n,origin);
    await assert.rejects(()=>service.computeRoute(initial.id,{courierId}),
      e=>e.code==="PRE_DEPARTURE_CHECK_PENDING","Early route calculation must be blocked");
    const checked=await checkBags(courierId,initial);
    const calculated=await service.computeRoute(checked.id,{courierId});
    assertRoute(calculated,n);
    const prepared=await service.prepareDispatch({courierId,id:calculated.id,compositionVersion:calculated.composition_version});
    assert.equal(prepared.order_numbers.length,n,"Prepared dispatch has wrong number of orders");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM dispatches WHERE courier_id=$1",[courierId])).rows[0].n,0,
      "Test must not create actual dispatch");
    await service.cancel({actorUserId:courierId,courierId,id:calculated.id,reason:"End of synthetic Stage 4 case"});
    report.cases.push({orders:n,permutations:calculated.route.evaluated,
      source:calculated.route.source,provider:calculated.route.provider,
      duration_minutes:calculated.route.duration_minutes,
      fastest_minutes:calculated.route.fastest_duration_minutes,
      matrix_elements:calculated.route.matrix_elements,
      planned:true,bag_checks:n,early_departure_blocked:true,
      dispatch_prepared:true,dispatch_created:false,ms:Date.now()-started});
  }
  const adminHash=await bcrypt.hash(randomBytes(28).toString("base64url"),8);
  const adminUser=await pool.query("INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'admin','APPROVED',true,false) RETURNING id",
    ["HOMOLOGACAO ETAPA 4 ADMIN",tag+"-admin",adminHash]);
  const adminId=Number(adminUser.rows[0].id);created.users.push(adminId);
  const {courierId,pd:initial}=await seedCase(2,11,origin);
  const checked=await checkBags(courierId,initial);
  const blocked=await failClient.computeRoute(checked.id,{courierId});
  assert.equal(blocked.status,"BLOCKED","ORS 429 must fail closed");
  assert.equal(blocked.route_status,"NEEDS_ADMIN");
  assert.equal(blocked.route_error?.code,"ROUTES_RATE_LIMITED");
  assert.equal(blocked.can_dispatch,false);
  const manual=await failClient.adminSequence({adminId,id:blocked.id,reason:"Synthetic provider unavailable; admin sequence"});
  assert.equal(manual.route.source,"ADMIN_SEQUENCE");
  assert.equal(manual.ack_required,true);
  const ack=await failClient.acknowledge({courierId,id:manual.id,version:manual.version});
  assert.equal(ack.ack_required,false);
  assert.equal(ack.can_dispatch,true);
  await failClient.cancel({actorUserId:courierId,courierId,id:ack.id,reason:"End of synthetic fallback"});
  report.fallback={simulated_error:"429",blocked_without_provider:true,manual_override_audited:true,
    courier_ack_required:true,dispatched:false};
  report.result="PASS";
} catch (e) {
  error=e;
  console.error("STAGING_STAGE4_ROUTE_FAIL "+JSON.stringify({
    cases:report.cases,reason:String(e?.message||e?.code||"unknown").slice(0,300),error_code:String(e?.code||"UNKNOWN"),stack:String(e?.stack||"").split("\n").slice(0,4).join(" | ").slice(0,500)}));
} finally {
  // Remove only fixtures belonging to this unique test run. Never touch real accounts.
  try {
    for(const id of created.preDepartures) {
      await pool.query("UPDATE pre_departure_orders SET active=false,released_at=COALESCE(released_at,NOW()),release_reason=COALESCE(release_reason,'STAGE4_CLEANUP') WHERE pre_departure_id=$1 AND active",[id]);
      await pool.query("DELETE FROM pre_departures WHERE id=$1",[id]);
    }
    if(created.orders.length) await pool.query("DELETE FROM anotaai_orders WHERE order_id=ANY($1::text[])",[created.orders]);
    if(created.users.length) await pool.query("UPDATE users SET active=false WHERE id=ANY($1::int[])",[created.users]);
    const remaining=created.orders.length ? (await pool.query("SELECT count(*)::int AS n FROM anotaai_orders WHERE order_id=ANY($1::text[])",[created.orders])).rows[0].n : 0;
    assert.equal(remaining,0,"Synthetic orders not fully deleted");
    console.log("STAGING_STAGE4_CLEANUP_OK "+JSON.stringify({orders:created.orders.length,users_disabled:created.users.length,
      predpartures_deleted:created.preDepartures.length,remaining_orders:remaining,flags_modified:false}));
  } catch (e) {
    error=error||e;
    console.error("STAGING_STAGE4_CLEANUP_FAIL "+String(e?.code||e?.message||"unknown").slice(0,180));
  }
  await pool.end().catch(()=>{});
}
if(error){process.exitCode=1;}
else console.log("STAGING_STAGE4_ROUTE_PASS "+JSON.stringify(report));
