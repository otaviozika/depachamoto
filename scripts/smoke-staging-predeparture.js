// Homologacao HTTP da nova pre-saida com 40 motoboys reais no PostgreSQL efemero.
// NUNCA use com producao: bloqueia quaisquer URLs, databases ou flags fora do staging isolado.
import pg from "pg";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import { operationalShiftAt } from "../lib/operational-shift.js";

const host = new URL(String(process.env.TARGET_URL || ""));
const dbUrl = new URL(String(process.env.DATABASE_URL || ""));
const isLocal = x => ["localhost","127.0.0.1","::1"].includes(x);
if (process.env.APP_ENV !== "staging" || process.env.STAGING_SAFE_MODE !== "true" ||
    process.env.LOAD_TEST_CONFIRM !== "STAGING_ONLY_I_UNDERSTAND" ||
    !isLocal(host.hostname) || !isLocal(dbUrl.hostname) ||
    String(process.env.NODE_ENV) === "production") {
  throw new Error("ABORTADO: este smoke so aceita staging seguro e banco/servidor locais.");
}
const target = host.origin;
const fixedNow = String(process.env.OPERATIONAL_NOW_OVERRIDE || "");
const fixed = new Date(fixedNow);
if (!Number.isFinite(fixed.getTime())) throw new Error("OPERATIONAL_NOW_OVERRIDE invalido.");
const shift = operationalShiftAt(fixed, { required: true });
const N = Math.max(2,Math.min(40,Number(process.env.PRE_DEPARTURE_COURIERS || 40)));
const run = String(Date.now()).slice(-8);
const password = "StagingPreDepartureOnly987!";
const key = String(process.env.LOAD_TEST_KEY || "");
const pool = new pg.Pool({ connectionString: dbUrl.toString(), ssl: false, max: 20 });
const courierIds = [];
const latencies = [];
const failures = [];
const statusCounts = {};
const report = { result: "PENDING", profile: { couriers: N, ordersPerCourier: 2 },
  counts: { created: 0, bagsChecked: 0, routesReady: 0, departed: 0, replayed: 0, blockedSecondDeparture: 0 },
  verification: {}, failures: [] };

function assert(condition, message) { if(!condition) throw new Error(message); }
function elapsedMs(p) {
  const sorted = latencies.slice().sort((a,b)=>a-b);
  return sorted.length?Number(sorted[Math.floor((sorted.length-1)*p)].toFixed(1)):0;
}
async function call(path, cookie="", options={}) {
  const begin = performance.now();
  const res = await fetch(target+path, {
    ...options,
    headers: { "content-type":"application/json", "x-load-test-key":key,
      ...(cookie?{cookie}:{}), ...(options.headers||{}) }
  });
  latencies.push(performance.now()-begin);
  statusCounts[res.status] = (statusCounts[res.status]||0)+1;
  const body = await res.json().catch(()=>({}));
  return { status: res.status, body, cookie: (res.headers.get("set-cookie")||"").split(";")[0] };
}
function post(path,cookie,body){return call(path,cookie,{method:"POST",body:JSON.stringify(body)});}
async function createTestData() {
  const hash = await bcrypt.hash(password,10);
  const admin = (await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  assert(admin,"Admin de staging nao encontrado.");
  for(let i=0;i<N;i++){
    const user = (await pool.query(
      "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE) RETURNING id",
      ["Staging Pre "+i,"pds_"+run+"_"+i,hash])).rows[0];
    courierIds.push(Number(user.id));
    await pool.query(
      "INSERT INTO courier_attendance(courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason) VALUES($1,$2::date,$3,$4::timestamptz,'ADMIN',$5,'Staging pre-departure')",
      [user.id,shift.operational_date,shift.shift_code,fixedNow,admin.id]);
    for(let j=0;j<2;j++){
      const display = "6"+run.slice(-5)+String(i+1).padStart(2,"0")+String(j+1);
      const orderId = "staging-pre-"+run+"-"+i+"-"+j;
      const lat = -23.6244+i*0.00004+j*0.00007;
      const lon = -46.5549+i*0.00003+j*0.00006;
      const payload = {deliveryAddress:{streetName:"Rua Teste",streetNumber:String(100+i*2+j),
        neighborhood:"Barcelona",city:"São Caetano do Sul",state:"SP",
        coordinates:{latitude:lat,longitude:lon}},customer:{name:"Cliente Sintetico"}};
      await pool.query(
        "INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'staging-fake-page',$2,'READY','DELIVERY',$3::timestamptz,$3::timestamptz,$4::jsonb,'Cliente Sintetico')",
        [orderId,display,fixedNow,JSON.stringify(payload)]);
    }
  }
}
async function runCourier(index) {
  const courierId = courierIds[index];
  const username = "pds_"+run+"_"+index;
  try {
    const auth = await post("/api/login","",{username,password});
    assert(auth.status===200 && auth.cookie,"login"+index+":"+auth.status+":"+JSON.stringify(auth.body).slice(0,130));
    const cookie = auth.cookie;
    const orders = [0,1].map(j=>"#6"+run.slice(-5)+String(index+1).padStart(2,"0")+String(j+1));
    const selection = orders.map(order_number=>({order_number,platform:"anotaai"}));
    const created = await post("/api/courier/pre-departures",cookie,{
      order_numbers:orders,order_count:2,platform_selections:selection
    });
    assert(created.status===201,"create"+index+":"+created.status+":"+JSON.stringify(created.body).slice(0,200));
    let pd = created.body.pre_departure;
    assert(pd && pd.counts.total===2 && pd.counts.checked===0,"preliminary-count");
    report.counts.created++;
    const premature = await post("/api/courier/depart",cookie,{
      pre_departure_id:pd.id,composition_version:pd.composition_version
    });
    assert(premature.status===409,"unverified-departure-not-blocked:"+index+":"+premature.status);
    for(const row of pd.orders) {
      const r = await post("/api/courier/pre-departures/"+pd.id+"/orders/"+row.id+"/check",cookie,
        {composition_version:pd.composition_version,checked:true});
      assert(r.status===200,"check"+index+":"+r.status+":"+JSON.stringify(r.body).slice(0,170));
      pd = r.body.pre_departure;
      report.counts.bagsChecked++;
    }
    assert(pd.counts.checked===2,"all-bags-not-confirmed");
    const planned = await post("/api/courier/pre-departures/"+pd.id+"/route",cookie,{});
    assert(planned.status===200,"plan"+index+":"+planned.status+":"+JSON.stringify(planned.body).slice(0,200));
    pd = planned.body.pre_departure;
    assert(pd.status==="ROUTE_READY" && pd.can_dispatch===true && pd.route?.source==="TYPED_ORDER",
      "no-free-provider-must-use-typed-order");
    report.counts.routesReady++;
    const sent = await post("/api/courier/depart",cookie,{
      pre_departure_id:pd.id,composition_version:pd.composition_version
    });
    assert(sent.status===201,"depart"+index+":"+sent.status+":"+JSON.stringify(sent.body).slice(0,200));
    const dispatchId = Number(sent.body?.dispatch?.id);
    assert(dispatchId>0,"dispatch-id-missing");
    report.counts.departed++;
    const replay = await post("/api/courier/depart",cookie,{
      pre_departure_id:pd.id,composition_version:pd.composition_version
    });
    assert(replay.status===200 && replay.body?.duplicate===true &&
      Number(replay.body?.dispatch?.id)===dispatchId,"idempotency:"+index+":"+replay.status);
    report.counts.replayed++;
    const blocked = await post("/api/courier/pre-departures",cookie,{
      order_numbers:orders,order_count:2,platform_selections:selection
    });
    assert(blocked.status===409,"second-departure-should-block:"+index+":"+blocked.status);
    report.counts.blockedSecondDeparture++;
  } catch(e) {
    failures.push("courier-"+index+": "+String(e.message).slice(0,350));
  }
}
try {
  const health = await call("/api/health");
  assert(health.status===200 && health.body?.environment==="staging" &&
    health.body?.stagingSafeMode===true && health.body?.externalMutationsAllowed===false,
    "Health do staging nao garante protecao externa");
  await createTestData();
  await pool.query(
    "INSERT INTO app_settings(setting_key,setting_value) VALUES('pre_departure_enabled','true'),('route_planner_enabled','false'),('address_correction_enabled','false') ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value");
  await Promise.all(courierIds.map((_,i)=>runCourier(i)));
  const ids = courierIds;
  const check = await pool.query(
    "SELECT (SELECT count(*) FROM pre_departures WHERE courier_id=ANY($1::int[]) AND status='DISPATCHED')::int AS pre, "+
    "(SELECT count(*) FROM dispatches WHERE courier_id=ANY($1::int[]))::int AS dispatches, "+
    "(SELECT count(*) FROM dispatch_routes r JOIN dispatches d ON d.id=r.dispatch_id WHERE d.courier_id=ANY($1::int[]))::int AS routes, "+
    "(SELECT count(*) FROM dispatch_route_stops s JOIN dispatches d ON d.id=s.dispatch_id WHERE d.courier_id=ANY($1::int[]))::int AS stops, "+
    "(SELECT count(*) FROM anotaai_dispatch_links l JOIN dispatches d ON d.id=l.dispatch_id WHERE d.courier_id=ANY($1::int[]))::int AS links",
    [ids]);
  report.verification = check.rows[0];
  const counts = report.counts,db=report.verification;
  if(counts.created!==N||counts.bagsChecked!==2*N||counts.routesReady!==N||
    counts.departed!==N||counts.replayed!==N||counts.blockedSecondDeparture!==N||
    db.pre!==N||db.dispatches!==N||db.routes!==N||db.stops!==2*N||db.links!==2*N)
    failures.push("Expected exact counts in pre-departure/dispatch/route/links: "+JSON.stringify({counts,db}));
  report.result = failures.length?"FAIL":"PASS";
  report.http = {requests:latencies.length,byStatus:statusCounts,p50ms:elapsedMs(0.5),p95ms:elapsedMs(0.95),p99ms:elapsedMs(0.99)};
  report.failures=failures.slice(0,20);
  fs.writeFileSync("staging-predeparture-report.json",JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
  if(failures.length) process.exitCode=1;
} finally {
  await pool.end();
}
