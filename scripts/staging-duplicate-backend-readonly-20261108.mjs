/**
 * Isolated, read-only backend negative test for already-linked Anota AI orders.
 * Invokes the SAME createPreDepartureService.create() business guard as the
 * authenticated API, without a browser or external provider call.
 *
 * PostgreSQL session is set default_transaction_read_only=on so even if the
 * guard regresses, the script CANNOT create a pre-departure or dispatch.
 * Run one time via temporary staging-only npm start and restore immediately.
 */
import assert from "node:assert/strict";
import pg from "pg";
import {createPreDepartureService} from "../lib/pre-departure-service.js";

const env=process.env;
const EXPECTED_DB="despachefull_incidentes_homologacao";
const HOST_PART="dbn9n1psrm7s738pu81g";
const ids=["88110811","88110812"];
assert.equal(env.APP_ENV,"staging","Only staging APP_ENV is permitted");
assert.equal(env.STAGING_SAFE_MODE,"true","Staging safe mode must be true");
const url=new URL(String(env.DATABASE_URL||""));
assert.equal(decodeURIComponent(url.pathname.slice(1)),EXPECTED_DB,"Wrong database");
assert.ok(url.hostname.includes(HOST_PART),"Wrong isolated database instance");

const pool=new pg.Pool({
  connectionString:env.DATABASE_URL,
  ssl:env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,
  options:"-c default_transaction_read_only=on",
  max:2,connectionTimeoutMillis:7000,statement_timeout:9000
});
try {
  const flags=await pool.query("SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro");
  assert.equal(flags.rows[0].db,EXPECTED_DB);
  assert.equal(flags.rows[0].ro,"on","Read-only session required");
  const rows=(await pool.query(`
    SELECT o.order_id,o.display_id,l.dispatch_id,d.courier_id,d.status AS dispatch_status,
           d.return_source,
           (SELECT COUNT(*)::int FROM anotaai_delivery_confirmations c
             WHERE c.anotaai_order_id=o.order_id AND c.dispatch_id=l.dispatch_id) AS confirmations,
           (SELECT COUNT(*)::int FROM active_order_locks a
             WHERE a.order_number='#'||o.display_id AND a.platform='anotaai'
             AND a.dispatch_id=l.dispatch_id) AS active_locks
    FROM anotaai_orders o
    JOIN anotaai_dispatch_links l ON l.anotaai_order_id=o.order_id
    JOIN dispatches d ON d.id=l.dispatch_id
    WHERE o.display_id=ANY($1::text[])
    ORDER BY o.display_id
  `,[ids])).rows;
  assert.equal(rows.length,2,"Both real staging fixture links must exist");
  for (let i=0;i<2;i++){
    const row=rows[i];
    assert.equal(row.display_id,ids[i]);
    assert.equal(row.dispatch_status,"RELEASED","Expected admin-released test sortie");
    assert.equal(row.return_source,"ADMIN_PENDING_DELIVERIES_OVERRIDE","Expected exceptional release");
    assert.equal(row.confirmations,0,"Never confirm fake deliveries");
    assert.equal(row.active_locks,1,"Pending order lock must be retained");
  }
  assert.equal(rows[0].dispatch_id,rows[1].dispatch_id,"Both orders should be from same test sortie");
  assert.equal(rows[0].courier_id,rows[1].courier_id,"Both orders should belong to same test courier");
  const courierId=Number(rows[0].courier_id);
  assert.ok(Number.isSafeInteger(courierId)&&courierId>0);

  const count=async()=>Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM pre_departures WHERE courier_id=$1",
    [courierId])).rows[0].n);
  const before=await count();
  const service=createPreDepartureService({pool,describeOrder:async()=>{throw new Error("not needed");},
    audit:async()=>{throw new Error("Unexpected audit write");},
    emitRealtime:()=>{throw new Error("Unexpected realtime mutation");},env});
  const checks=[];
  for(const row of rows) {
    let error=null;
    try{
      await service.create({courierId,links:[{
        platform:"anotaai",order_id:row.order_id,
        order_number:"#"+row.display_id
      }]});
    }catch(e){error=e}
    assert.ok(error,"Unexpectedly accepted duplicate order "+row.display_id);
    assert.equal(error.status,409,"Expected backend 409 for "+row.display_id);
    assert.equal(error.code,"ORDER_ALREADY_ACTIVE","Expected duplicate error code "+row.display_id);
    checks.push({order:row.display_id,status:409,code:error.code});
  }
  assert.equal(await count(),before,"Pre-departure count changed");
  for(const row of rows) {
    const ver=(await pool.query(`
      SELECT COUNT(*)::int AS links,
        (SELECT COUNT(*)::int FROM anotaai_delivery_confirmations c
         WHERE c.anotaai_order_id=$1 AND c.dispatch_id=$2) AS confirmations,
        (SELECT COUNT(*)::int FROM active_order_locks a
         WHERE a.dispatch_id=$2 AND a.order_number=$3 AND a.platform='anotaai') AS active_locks
      FROM anotaai_dispatch_links WHERE anotaai_order_id=$1 AND dispatch_id=$2
    `,[row.order_id,row.dispatch_id,"#"+row.display_id])).rows[0];
    assert.equal(ver.links,1);
    assert.equal(ver.confirmations,0);
    assert.equal(ver.active_locks,1);
  }
  console.log("STAGING_BACKEND_DUPLICATE_READONLY_PASS "+JSON.stringify({
    db:EXPECTED_DB,dbReadOnly:true,
    validationLayer:"createPreDepartureService.create()",
    checks,linksRetained:true,activeOrderLocksRetained:true,
    confirmationsCreated:0,preDeparturesCreated:0,
    routeProviderCalls:0,productionTouched:false
  }));
}catch(error){
  console.error("STAGING_BACKEND_DUPLICATE_READONLY_FAIL "+JSON.stringify({
    code:String(error.code||"ASSERTION_FAILED"),
    message:String(error.message||"error").slice(0,220)
  }));
  process.exitCode=1;
}finally {await pool.end()}
