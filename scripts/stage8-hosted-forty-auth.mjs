/**
 * Live hosted Stage8-only authenticated and pre-departure test.
 * Runs INSIDE the approved isolated Render service, using loopback and an
 * explicitly allowlisted independent Supabase project. Never public.
 * No provider calls, no production or pilot DB access.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import bcrypt from "bcryptjs";
import { getCurrentOperationalShift } from "../lib/operational-shift.js";

function guard() {
  assert.equal(process.env.APP_ENV,"staging");
  assert.equal(process.env.STAGING_SAFE_MODE,"true");
  assert.equal(process.env.STAGE8_ISOLATED,"true");
  assert.equal(process.env.NODE_ENV,"production");
  assert.equal(process.env.STAGING_HOSTED_E2E_RUN,"yes");
  const u=new URL(String(process.env.DATABASE_URL||""));
  assert.ok(["postgres:","postgresql:"].includes(u.protocol));
  assert.ok(u.hostname.endsWith(".pooler.supabase.com"));
  assert.equal(u.port,"5432");
  assert.equal(u.pathname,"/postgres");
  assert.ok(decodeURIComponent(u.username).endsWith(".yubiztqoaunkbexrfwhq"));
}
const ptile=(xs,q)=>{if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y);return Number(a[Math.ceil(q*a.length)-1].toFixed(2));};
const metrics=xs=>({n:xs.length,p50_ms:ptile(xs,.5),p95_ms:ptile(xs,.95),p99_ms:ptile(xs,.99),max_ms:ptile(xs,1)});
export async function runStage8FortyAuthenticated({pool,port}) {
  guard();
  const healthBase="http://127.0.0.1:"+Number(port);
  const run="stage8-40-"+randomBytes(6).toString("hex");
  const password=randomBytes(32).toString("base64url");
  const hash=await bcrypt.hash(password,10);
  const users=[],createdOrders=[],createdPreDepartures=[];
  const phases={login:[],me:[],predeparture_read:[],predeparture_create:[]};
  const waves=[],checks=[];
  const headers={"content-type":"application/json","accept":"application/json","x-forwarded-proto":"https"};
  let oldRoutePlanner=null,routePlannerChanged=false,clean=true;
  const fetchLocal=async(path,{cookie="",method="GET",body=null,timeout=45000}={})=>{
    const started=performance.now();
    const res=await fetch(healthBase+path,{method,
      headers:{...headers,...(cookie?{cookie}:{})},
      ...(body===null?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(timeout),redirect:"error"});
    const data=await res.json().catch(()=>null);
    return {status:res.status,data,cookie:(res.headers.get("set-cookie")||"").split(";")[0],
      elapsed:performance.now()-started};
  };
  const must=async(path,opts,status)=>{
    const r=await fetchLocal(path,opts);
    assert.equal(r.status,status,"HTTP "+status+" expected for "+path+", got "+r.status+
      " "+String(r.data?.code||"").slice(0,50));
    return r;
  };
  const batch=async(items,limit,fn)=>{
    const out=[];
    for(let i=0;i<items.length;i+=limit)
      out.push(...await Promise.all(items.slice(i,i+limit).map(fn)));
    return out;
  };
  const adminId=Number((await pool.query("SELECT id FROM users WHERE active=TRUE AND role='admin' ORDER BY id LIMIT 1")).rows[0]?.id);
  assert.ok(adminId,"requires approved synthetic admin on isolated database");
  const before=(await must("/api/health",{},200)).data;
  assert.equal(before.environment,"staging");
  assert.equal(before.stagingSafeMode,true);
  assert.equal(before.externalMutationsAllowed,false);
  assert.equal(before.database,"connected");
  checks.push("safe-host-isolation");
  try{
    const seed=Array.from({length:40},(_,i)=>i);
    await batch(seed,8,async i=>{
      const username=run+"-"+i;
      const q=await pool.query(
        "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE) RETURNING id",
        ["TESTE ISOLADO "+i,username,hash]);
      users[i]={id:Number(q.rows[0].id),username,cookie:""};
    });
    checks.push("40-independent-synthetic-accounts");
    await batch(users,8,async u=>{
      const r=await must("/api/login",{method:"POST",body:{username:u.username,password}},200);
      assert.ok(r.cookie.startsWith("connect.sid="),"missing secure session cookie");
      u.cookie=r.cookie;phases.login.push(r.elapsed);
    });
    assert.equal(users.filter(u=>u.cookie).length,40);
    checks.push("40-real-authenticated-sessions");

    for(const [i,u] of users.entries()) {
      if(i>=5)break;
      const me=await must("/api/me",{cookie:u.cookie},200);
      assert.equal(Number(me.data.user?.id),u.id);
      phases.me.push(me.elapsed);
    }
    await batch(users.slice(5),10,async u=>{
      const me=await must("/api/me",{cookie:u.cookie},200);
      assert.equal(Number(me.data.user?.id),u.id);
      phases.me.push(me.elapsed);
    });
    checks.push("authenticated-session-id-isolation");

    for(const n of [5,15,30,40]){
      const a=await Promise.all(users.slice(0,n).map(u=>fetchLocal("/api/courier/pre-departure",{cookie:u.cookie})));
      assert.ok(a.every(x=>x.status===200),"unexpected status during "+n+"-client authenticated wave");
      const t=a.map(x=>x.elapsed);
      phases.predeparture_read.push(...t);
      waves.push({clients:n,stats:metrics(t),unexpected_5xx:a.filter(x=>x.status>=500).length});
    }
    checks.push("5-15-30-40-authenticated-concurrent-reads");

    // Physical shift override is enabled only on Stage8 and expires automatically.
    const shift=getCurrentOperationalShift();
    assert.ok(shift && shift.shift_code,"temporary safe shift override is required");
    for(const u of users.slice(0,4)){
      await pool.query(
        "INSERT INTO courier_attendance(courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason) VALUES($1,$2,$3,NOW(),'ADMIN',$4,'STAGE8 ISOLATED SYNTHETIC')",
        [u.id,shift.operational_date,shift.shift_code,adminId]);
    }
    checks.push("synthetic-attendance-only");

    oldRoutePlanner=(await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='route_planner_enabled'")).rows[0]?.setting_value??null;
    await pool.query("INSERT INTO app_settings(setting_key,setting_value) VALUES('route_planner_enabled','false') ON CONFLICT(setting_key) DO UPDATE SET setting_value='false'");
    routePlannerChanged=true;
    const sizes=[2,3,5],cases=[];
    let counter=0;
    for(let j=0;j<sizes.length;j++){
      const count=sizes[j],data=[];
      for(let k=0;k<count;k++){
        const display=String(84000000+100*j+counter);
        const orderId=run+"-order-"+counter++;
        const payload={deliveryAddress:{streetName:"Rua Sintetica",streetNumber:String(200+k),
          neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP",
          coordinates:{latitude:-23.625,longitude:-46.555}},customer:{name:"Cliente Sintetico"}};
        await pool.query(
          "INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'stage8-only',$2,'READY','DELIVERY',NOW(),NOW(),$3::jsonb,'Cliente Sintetico')",
          [orderId,display,JSON.stringify(payload)]);
        createdOrders.push(orderId);
        data.push({order_number:"#"+display,platform:"anotaai"});
      }
      cases.push(data);
    }
    for(let i=0;i<cases.length;i++){
      const u=users[i],selection=cases[i],numbers=selection.map(o=>o.order_number);
      const body={order_numbers:numbers,order_count:numbers.length,platform_selections:selection};
      const c=await must("/api/courier/pre-departures",{cookie:u.cookie,method:"POST",body},201);
      phases.predeparture_create.push(c.elapsed);
      assert.equal(c.data.pre_departure?.counts?.total,sizes[i]);
      createdPreDepartures.push(Number(c.data.pre_departure.id));
      const same=await must("/api/courier/pre-departures",{cookie:u.cookie,method:"POST",body},200);
      assert.equal(Number(same.data.pre_departure.id),Number(c.data.pre_departure.id));
      const forbidden=await must("/api/courier/pre-departures",{cookie:users[3].cookie,method:"POST",body},409);
      assert.ok(forbidden.status===409);
      const part=c.data.pre_departure.orders[0];
      const checked=await must("/api/courier/pre-departures/"+c.data.pre_departure.id+"/orders/"+part.id+"/check",
        {cookie:u.cookie,method:"POST",body:{composition_version:c.data.pre_departure.composition_version,checked:true}},200);
      assert.ok(checked.data.pre_departure);
      const cancelled=await must("/api/courier/pre-departures/"+c.data.pre_departure.id+"/cancel",
        {cookie:u.cookie,method:"POST",body:{reason:"STAGE8 TEST COMPLETE"}},200);
      assert.ok(cancelled.data.pre_departure);
    }
    checks.push("predeparture-2-3-5-pairs-triples-quintets");
    checks.push("idempotent-retries-and-cross-courier-409");
    checks.push("check-bags-and-cancel-rollback");

    // Revocation, refresh and canceled request do not produce a fake delivery.
    const revoked=users[1];
    await pool.query("UPDATE users SET active=FALSE WHERE id=$1",[revoked.id]);
    await must("/api/me",{cookie:revoked.cookie},401);
    const relogin=await must("/api/login",{cookie:users[2].cookie,method:"POST",
      body:{username:users[2].username,password}},200);
    await must("/api/me",{cookie:relogin.cookie},200);
    const aborter=new AbortController();
    aborter.abort();
    await assert.rejects(fetch(healthBase+"/api/me",{headers:{cookie:users[2].cookie},signal:aborter.signal}),{ name:"AbortError" });
    await must("/api/me",{cookie:users[2].cookie},200);
    await must("/api/logout",{cookie:users[0].cookie,method:"POST",body:{}},200);
    await must("/api/me",{cookie:users[0].cookie},401);
    checks.push("account-revocation-reconnect-logout-request-abort");

    const after=await must("/api/health",{},200);
    assert.equal(after.data.database,"connected");
    assert.equal(after.data.externalMutationsAllowed,false);
    const active=(await pool.query("SELECT count(*)::int AS n FROM dispatches WHERE courier_id=ANY($1::int[])",[users.map(x=>x.id)])).rows[0].n;
    assert.equal(Number(active),0,"test must not create deliveries");
    checks.push("zero-provider-writes-zero-dispatches");
    const report={result:"PASS",hosted:true,environment:"isolated Render Free with isolated Supabase Free",
      concurrent_authenticated_couriers:40,waves,login:metrics(phases.login),
      session_me:metrics(phases.me),predeparture_reads:metrics(phases.predeparture_read),
      predeparture_creations:metrics(phases.predeparture_create),
      predeparture_sizes:sizes,expected_409:3,unexpected_5xx:0,
      checks,synthetic_orders:createdOrders.length,
      mobile_physical_test:false,real_provider_calls:0,production_touched:false};
    console.log("STAGE8_HOSTED_40_AUTH_PASS "+JSON.stringify(report));
    return report;
  }catch(e){
    console.error("STAGE8_HOSTED_40_AUTH_FAIL "+JSON.stringify({
      completed_checks:checks,reason:String(e?.message||e).slice(0,220)}));
    throw e;
  }finally{
    // Only records tagged by this unique run and its user IDs. No global deletes.
    const cleanup=async(label,fn)=>{
      try{await fn();}catch(e){clean=false;console.error("STAGE8_FORTY_CLEANUP_FAIL "+label+" "+String(e.code||"db_error"));}
    };
    if(users.length){
      await cleanup("deactivate",()=>pool.query("UPDATE users SET active=FALSE WHERE id=ANY($1::int[])",[users.filter(Boolean).map(x=>x.id)]));
      await cleanup("predepartures",()=>pool.query("DELETE FROM pre_departures WHERE courier_id=ANY($1::int[])",[users.filter(Boolean).map(x=>x.id)]));
      await cleanup("attendance",()=>pool.query("DELETE FROM courier_attendance WHERE courier_id=ANY($1::int[])",[users.filter(Boolean).map(x=>x.id)]));
    }
    if(createdOrders.length)await cleanup("orders",()=>pool.query("DELETE FROM anotaai_orders WHERE order_id=ANY($1::text[])",[createdOrders]));
    if(routePlannerChanged)await cleanup("route_flag",()=>oldRoutePlanner===null?
      pool.query("DELETE FROM app_settings WHERE setting_key='route_planner_enabled'"):
      pool.query("UPDATE app_settings SET setting_value=$1 WHERE setting_key='route_planner_enabled'",[oldRoutePlanner]));
    console.log("STAGE8_HOSTED_40_AUTH_CLEANUP "+JSON.stringify({success:clean,users_disabled:users.length,order_count:createdOrders.length,production_touched:false}));
    if(!clean)process.exitCode=1; // explicit operational alert, never silently claim cleanup success
  }
}
