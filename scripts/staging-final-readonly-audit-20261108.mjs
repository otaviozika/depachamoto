/**
 * Read-only final staging audit 2026-11-08. Never mutates records or settings.
 * Executed once through staging-only startup with strict DB isolation checks.
 */
import assert from "node:assert/strict";
import pg from "pg";
const env=process.env;
assert.equal(env.APP_ENV,"staging","APP_ENV must be staging");
assert.equal(env.STAGING_SAFE_MODE,"true","safe mode must be on");
const url=new URL(String(env.DATABASE_URL||""));
assert.equal(decodeURIComponent(url.pathname.slice(1)),"despachefull_incidentes_homologacao");
assert.ok(url.hostname.includes("dbn9n1psrm7s738pu81g"),"DB instance mismatch");
const pool=new pg.Pool({connectionString:env.DATABASE_URL,
  ssl:env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,
  max:2,connectionTimeoutMillis:7000,statement_timeout:10000});
try{
  const read=async(sql,params=[])=>Number((await pool.query(sql,params)).rows[0]?.n??-1);
  const db=(await pool.query("SELECT current_database() AS n")).rows[0].n;
  assert.equal(db,"despachefull_incidentes_homologacao");
  const settings=(await pool.query(
    "SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [["route_planner_enabled","pre_departure_enabled","delivery_incidents_enabled","address_correction_enabled","route_store_origin"]]
  )).rows;
  const flags=Object.fromEntries(settings.map(x=>[x.setting_key,x.setting_value]));
  const physical=(await pool.query(
    "SELECT display_id,page_id,status FROM anotaai_orders WHERE display_id=ANY($1::text[]) ORDER BY display_id",
    [["88110801","88110802"]])).rows;
  const counts={
    physical_navigation_orders:physical.length,
    active_automated_test_users:await read("SELECT COUNT(*)::int AS n FROM users WHERE username LIKE 'stg-host-%' AND active"),
    e2e_anota_orders_remaining:await read("SELECT COUNT(*)::int AS n FROM anotaai_orders WHERE page_id='hosted-staging-only'"),
    e2e_ifood_orders_remaining:await read("SELECT COUNT(*)::int AS n FROM ifood_orders WHERE order_id LIKE 'stg-host-%'"),
    e2e_dispatches_remaining:await read("SELECT COUNT(*)::int AS n FROM dispatches WHERE dispatch_code LIKE 'stg-host-%'"),
    stage4_orders_remaining:await read("SELECT COUNT(*)::int AS n FROM anotaai_orders WHERE page_id='staging-stage4-only'"),
    route_matrix_budget_last_24h:await read("SELECT COUNT(*)::int AS n FROM route_matrix_quota_ledger WHERE scope='ORS_MATRIX' AND attempted_at >= NOW()-INTERVAL '24 hours'")
  };
  assert.equal(flags.route_planner_enabled,"false","Route planner inadvertently enabled");
  assert.equal(flags.delivery_incidents_enabled,"false","Pilot incident flag still enabled");
  assert.equal(counts.active_automated_test_users,0);
  assert.equal(counts.e2e_anota_orders_remaining,0);
  assert.equal(counts.e2e_ifood_orders_remaining,0);
  assert.equal(counts.e2e_dispatches_remaining,0);
  assert.equal(counts.stage4_orders_remaining,0);
  assert.equal(counts.physical_navigation_orders,2);
  assert.ok(physical.every(o=>o.page_id==="physical-nav-20261108"),"Wrong navigation fixture");
  assert.ok(counts.route_matrix_budget_last_24h<=450,"Local ORS Matrix budget exceeded");
  console.log("FINAL_STAGING_AUDIT_PASS "+JSON.stringify({
    date:"2026-11-08",mode:"READ_ONLY",db_isolated:true,
    externalPlatformMutations:false,productionTouched:false,
    settings:{routePlannerEnabled:flags.route_planner_enabled,incidentPilotEnabled:flags.delivery_incidents_enabled,
      preDepartureEnabled:flags.pre_departure_enabled,addressCorrectionEnabled:flags.address_correction_enabled,
      storeOriginConfirmed:(()=>{try{return JSON.parse(flags.route_store_origin).source==="ADMIN_CONFIRMED"}catch{return false}})()},
    physicalOrderIdentifiers:physical.map(x=>({display_id:x.display_id,status:x.status})),
    counts
  }));
}catch(e){
  console.error("FINAL_STAGING_AUDIT_FAIL "+JSON.stringify({
    code:String(e.code||"ASSERTION_FAILED"),reason:String(e.message||"unknown").slice(0,240)
  }));
  process.exitCode=1;
}finally{await pool.end()}
