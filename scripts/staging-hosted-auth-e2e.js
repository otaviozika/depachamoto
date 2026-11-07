/**
 * Staging-only authenticated E2E, runs inside the hosted service after startup.
 * No public testing endpoint. Synthetic orders only; credentials never logged.
 * Production is blocked by APP_ENV + DB name assertions.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const EXPECTED_DB="despachefull_incidentes_homologacao";
const STATUS_WANTED="ON_ROAD";

function assertIsolated() {
  assert.equal(process.env.APP_ENV,"staging","Only APP_ENV=staging is allowed");
  assert.equal(process.env.STAGING_SAFE_MODE,"true","STAGING_SAFE_MODE must be true");
  const db=new URL(String(process.env.DATABASE_URL||""));
  assert.equal(decodeURIComponent(db.pathname.slice(1)),EXPECTED_DB,"Forbidden database: only dedicated free Render staging");
  assert.ok(db.hostname.includes("dbn9n1psrm7s738pu81g"),"Database endpoint is not the approved isolated Render instance");
}
export async function runHostedAuthSmoke({pool,port}) {
  assertIsolated();
  const run="stg-host-"+randomBytes(7).toString("hex");
  const password=randomBytes(35).toString("base64url");
  const hash=await bcrypt.hash(password,10);
  const users=[];
  const completed=[];
  const dispatchIds=[];
  const orderIds=[];
  let previousPreDeparture=null;
  let changedPreDeparture=false;
  const base="http://127.0.0.1:"+Number(port);
  const headers={"content-type":"application/json","accept":"application/json","x-forwarded-proto":"https"};
  async function request(path,cookie="",method="GET",body=null) {
    const r=await fetch(base+path,{method,headers:{...headers,...(cookie?{cookie}:{})},
      ...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const value=await r.json().catch(()=>null);
    return {status:r.status,value,cookie:(r.headers.get("set-cookie")||"").split(";")[0]};
  }
  async function must(path,cookie,method,body,code) {
    const x=await request(path,cookie,method,body);
    assert.equal(x.status,code,path+" expected HTTP "+code+", got "+x.status+
      " ("+String(x.value?.code||x.value?.error||"no error").slice(0,110)+")");
    return x;
  }
  async function createUser(suffix,role) {
    const username=run+"-"+suffix;
    const r=await pool.query(
      "INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,$4,'APPROVED',TRUE,FALSE) RETURNING id",
      ["HOMOLOGACAO SINTETICA "+suffix,username,hash,role]);
    const u={id:Number(r.rows[0].id),username,role};
    users.push(u);return u;
  }
  async function login(user) {
    const res=await must("/api/login","","POST",{username:user.username,password},200);
    assert.ok(res.cookie.startsWith("connect.sid="),"Secure session cookie must be issued");
    return res.cookie;
  }
  async function createAnotaDispatch(courier,n=5) {
    const orders=[];
    const payload={deliveryAddress:{streetName:"Rua Sintetica",streetNumber:"123",
      neighborhood:"Barcelona",city:"Sao Caetano do Sul",state:"SP",
      coordinates:{latitude:-23.625,longitude:-46.555}},customer:{name:"Cliente Sintetico"}};
    for(let i=0;i<n;i++){
      const display=String(81000000+i);
      const orderId=run+"-anota-"+i;
      await pool.query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) VALUES($1,'hosted-staging-only',$2,'READY','DELIVERY',NOW()-INTERVAL '20 minutes',NOW(),$3::jsonb,'Cliente Sintetico')",
        [orderId,display,JSON.stringify(payload)]);
      orders.push({order_number:"#"+display,order_id:orderId});
      orderIds.push(orderId);
    }
    const created=await pool.query("INSERT INTO dispatches(dispatch_code,order_number,courier_id) VALUES($1,$2,$3) RETURNING id",
      [run+"-dispatch-anota",orders[0].order_number,courier.id]);
    const id=Number(created.rows[0].id);dispatchIds.push(id);
    for(let i=0;i<orders.length;i++){
      const o=orders[i];
      await pool.query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'anotaai')",[id,o.order_number]);
    }
    await pool.query("INSERT INTO dispatch_routes(dispatch_id,route_version,route_status,route,acked_version) VALUES($1,1,'ADMIN',$2::jsonb,1)",
      [id,JSON.stringify({source:"ADMIN_SEQUENCE",duration_minutes:12})]);
    for(let i=0;i<orders.length;i++){
      const o=orders[i];
      await pool.query("INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id) VALUES($1,$2,$3,'anotaai',$4)",
        [id,i+1,o.order_number,o.order_id]);
    }
    return {id,orders};
  }
  async function createIfoodDispatch(courier) {
    const orderId=run+"-ifood";
    const orderNumber="#92004567";
    const created=await pool.query("INSERT INTO dispatches(dispatch_code,order_number,courier_id) VALUES($1,$2,$3) RETURNING id",
      [run+"-dispatch-ifood",orderNumber,courier.id]);
    const id=Number(created.rows[0].id);dispatchIds.push(id);
    await pool.query("INSERT INTO ifood_orders(order_id,display_id,status,order_type,delivered_by) VALUES($1,'92004567','DISPATCHED','DELIVERY','MERCHANT')",[orderId]);
    orderIds.push(orderId);
    await pool.query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'ifood')",[id,orderNumber]);
    await pool.query("INSERT INTO dispatch_routes(dispatch_id,route_version,route_status,route,acked_version) VALUES($1,1,'ADMIN',$2::jsonb,1)",
      [id,JSON.stringify({source:"ADMIN_SEQUENCE",duration_minutes:0})]);
    await pool.query("INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id) VALUES($1,1,$2,'ifood',$3)",
      [id,orderNumber,orderId]);
    return {id,order_id:orderId};
  }
  const mark=x=>completed.push(x);
  let error=null;
  try {
    const health=await must("/api/health","","GET",null,200);
    assert.equal(health.value.environment,"staging");
    assert.equal(health.value.database,"connected");
    assert.equal(health.value.stagingSafeMode,true);
    assert.equal(health.value.externalMutationsAllowed,false);
    assert.equal(health.value.ifood?.eventSyncEnabled,false);
    assert.equal(health.value.anotaai?.automaticSyncEnabled,false);
    mark("isolated-health");

    const existing=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='pre_departure_enabled'");
    previousPreDeparture=existing.rows[0]?.setting_value??null;
    await pool.query("INSERT INTO app_settings(setting_key,setting_value) VALUES('pre_departure_enabled','true') ON CONFLICT(setting_key) DO UPDATE SET setting_value='true'");
    changedPreDeparture=true;
    const admin=await createUser("admin","admin");
    const courier1=await createUser("courier-a","courier");
    const courier2=await createUser("courier-b","courier");
    const dispatch=await createAnotaDispatch(courier1,5);
    const ifood=await createIfoodDispatch(courier2);
    const adminCookie=await login(admin);
    const cookie=await login(courier1);
    const cookieOther=await login(courier2);
    mark("3-authenticated-sessions");

    const orig=await must("/api/courier/pre-departure",cookie,"GET",null,200);
    assert.equal(orig.value.incident_feature?.enabled,false);
    assert.equal(orig.value.route?.stops?.length,5);
    const incidentPath="/api/courier/dispatches/"+dispatch.id+"/incidents";
    const payload={platform:"anotaai",order_id:dispatch.orders[0].order_id,reason:"CLIENT_NOT_FOUND"};
    const disabled=await must(incidentPath,cookie,"POST",payload,409);
    assert.equal(disabled.value.code,"INCIDENT_FEATURE_DISABLED");
    mark("fail-closed-when-off");

    await must("/api/admin/delivery-incidents/pilot",adminCookie,"PUT",
      {enabled:true,courier_id:courier1.id,reason:"Piloto de homologacao hospedada"},200);
    assert.equal((await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.incident_feature.enabled,true);
    assert.equal((await must("/api/courier/pre-departure",cookieOther,"GET",null,200)).value.incident_feature.enabled,false);
    const denied=await must(incidentPath,cookieOther,"POST",payload,409);
    assert.equal(denied.value.code,"INCIDENT_FEATURE_DISABLED");
    mark("single-courier-authorization");

    await must(incidentPath,cookie,"POST",{...payload,reason:"CODE_UNAVAILABLE"},400);
    const opened=await must(incidentPath,cookie,"POST",payload,201);
    const incidentId=Number(opened.value.incident?.id);
    assert.ok(incidentId>0);
    const repeated=await must(incidentPath,cookie,"POST",payload,200);
    assert.equal(Number(repeated.value.incident.id),incidentId);
    mark("anota-reason-validation-and-idempotency");

    await must("/api/admin/delivery-incidents",cookie,"GET",null,403);
    const list=await must("/api/admin/delivery-incidents",adminCookie,"GET",null,200);
    assert.ok(list.value.incidents.some(x=>Number(x.id)===incidentId&&x.status==="OPEN"));
    mark("admin-role-enforcement");

    const oldRoute=(await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.route;
    assert.equal(oldRoute.stops.length,5);
    assert.equal(oldRoute.stops.find(x=>x.external_order_id===payload.order_id)?.incident?.status,"OPEN");
    const approved=await must("/api/admin/delivery-incidents/"+incidentId+"/decision",adminCookie,"POST",
      {action:"APPROVE_CONTINUE",reason:"Seguir para proxima entrega do teste"},200);
    assert.equal(approved.value.incident.status,"CONTINUE_APPROVED");
    const next=(await must("/api/courier/pre-departure",cookie,"GET",null,200)).value.route;
    assert.equal(next.ack_required,true);
    assert.equal(next.stops.find(x=>x.external_order_id===payload.order_id)?.is_deferred,true);
    assert.equal(next.stops.filter(x=>x.is_next).length,1);
    assert.equal(next.stops.filter(x=>x.state==="PENDING").length,5);
    const noConfirm=await pool.query("SELECT count(*)::int AS n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=$1",
      [payload.order_id]);
    assert.equal(Number(noConfirm.rows[0].n),0);
    const stillOnRoad=(await pool.query("SELECT status FROM dispatches WHERE id=$1",[dispatch.id])).rows[0];
    assert.equal(stillOnRoad.status,STATUS_WANTED);
    mark("continue-without-false-delivery-or-release");

    const ack=await must("/api/courier/routes/"+dispatch.id+"/ack",cookie,"POST",
      {route_version:next.route_version},200);
    assert.equal(ack.value.route?.ack_required,false);
    mark("courier-route-acknowledgement");

    const relogin=await login(courier1);
    const recovered=(await must("/api/courier/pre-departure",relogin,"GET",null,200)).value.route;
    assert.equal(recovered.ack_required,false);
    assert.equal(recovered.stops.find(x=>x.external_order_id===payload.order_id)?.is_deferred,true);
    mark("reconnect-preserves-route-state");

    await must("/api/admin/delivery-incidents/"+incidentId+"/decision",adminCookie,"POST",
      {action:"REQUIRE_RETRY",reason:"Cliente voltou; tentativa novamente"},200);
    const retry=(await must("/api/courier/pre-departure",relogin,"GET",null,200)).value.route;
    assert.equal(retry.ack_required,true);
    assert.equal(retry.stops.find(x=>x.external_order_id===payload.order_id)?.is_deferred,false);
    await must("/api/courier/routes/"+dispatch.id+"/ack",relogin,"POST",{route_version:retry.route_version},200);
    mark("admin-retry-restores-stop");

    const switchPilot=await must("/api/admin/delivery-incidents/pilot",adminCookie,"PUT",
      {enabled:true,courier_id:courier2.id,reason:"Testar outro piloto iFood sem codigo"},200);
    assert.equal(Number(switchPilot.value.settings.courier_id),courier2.id);
    const former=await must(incidentPath,relogin,"POST",payload,409);
    assert.equal(former.value.code,"INCIDENT_FEATURE_DISABLED");
    const ifoodPath="/api/courier/dispatches/"+ifood.id+"/incidents";
    const missingCode=await must(ifoodPath,cookieOther,"POST",
      {platform:"ifood",order_id:ifood.order_id,reason:"CODE_UNAVAILABLE"},201);
    const ifoodIncidentId=Number(missingCode.value.incident.id);
    await must("/api/admin/delivery-incidents/"+ifoodIncidentId+"/decision",adminCookie,"POST",
      {action:"APPROVE_CONTINUE",reason:"Codigo indisponivel, manter pendente"},200);
    assert.equal((await pool.query("SELECT status FROM dispatches WHERE id=$1",[ifood.id])).rows[0].status,STATUS_WANTED);
    const fakeConfirmed=await pool.query("SELECT count(*)::int AS n FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",
      [ifood.order_id]);
    assert.equal(Number(fakeConfirmed.rows[0].n),0);
    mark("ifood-no-code-without-forged-confirmation");

    await pool.query("UPDATE ifood_orders SET status='DELIVERED' WHERE order_id=$1",[ifood.order_id]);
    const reconciled=await must("/api/admin/delivery-incidents",adminCookie,"GET",null,200);
    assert.ok(!reconciled.value.incidents.some(x=>Number(x.id)===ifoodIncidentId));
    const done=(await pool.query("SELECT status FROM dispatch_delivery_incidents WHERE id=$1",[ifoodIncidentId])).rows[0];
    assert.equal(done.status,"RESOLVED");
    mark("ifood-provider-status-reconciliation");

    const turnOff=await must("/api/admin/delivery-incidents/pilot",adminCookie,"PUT",
      {enabled:false,courier_id:courier2.id,reason:"Encerrar piloto hospedado com seguranca"},200);
    assert.equal(turnOff.value.settings.enabled,false);
    assert.equal((await must("/api/courier/pre-departure",cookieOther,"GET",null,200)).value.incident_feature.enabled,false);
    const blockedAgain=await must(ifoodPath,cookieOther,"POST",
      {platform:"ifood",order_id:ifood.order_id,reason:"CODE_UNAVAILABLE"},409);
    assert.equal(blockedAgain.value.code,"INCIDENT_FEATURE_DISABLED");
    mark("disable-switches-off-immediately");

    console.log("STAGING_HOSTED_AUTH_E2E_PASS "+JSON.stringify({
      run,scenarios:completed.length,checks:completed,synthetic_orders:orderIds.length,
      simulated_couriers:2,production_access:false,external_mutations:false,
      dispatcher_status_still_pending:true,automatic_rollback:true
    }));
  } catch (e) {
    error=e;
    console.error("STAGING_HOSTED_AUTH_E2E_FAIL "+JSON.stringify({
      run,completed,reason:String(e?.message||"unknown").slice(0,300)
    }));
  } finally {
    // Fail-safe, even if assertions throw: no enabled pilot or active fake users.
    try{
      await pool.query("INSERT INTO app_settings(setting_key,setting_value) VALUES('delivery_incidents_enabled','false') ON CONFLICT(setting_key) DO UPDATE SET setting_value='false'");
    }catch(e){console.error("STAGING_E2E_PILOT_DISABLE_ERROR "+String(e?.code||"db_error"));}
    try{
      if(users.length)await pool.query("UPDATE users SET active=FALSE WHERE id=ANY($1::int[])",[users.map(u=>u.id)]);
    }catch(e){console.error("STAGING_E2E_USER_DISABLE_ERROR "+String(e?.code||"db_error"));}
    try{
      if(changedPreDeparture){
        if(previousPreDeparture===null) await pool.query("DELETE FROM app_settings WHERE setting_key='pre_departure_enabled'");
        else await pool.query("UPDATE app_settings SET setting_value=$1 WHERE setting_key='pre_departure_enabled'",[previousPreDeparture]);
      }
    }catch(e){console.error("STAGING_E2E_FLAG_RESTORE_ERROR "+String(e?.code||"db_error"));}
  }
  if(error)throw error;
  return {success:true,scenarios:completed.length};
}
