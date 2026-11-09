/**
 * One-time, idempotent physical Waze/Maps pilot seeding. Staging ONLY.
 * Stays under 2 synthetic Anota AI records; does not touch users, dispatches,
 * feature flags, production, real platform APIs or any customer data.
 * Called once from temporarily configured npm start; immediately restored.
 */
import assert from "node:assert/strict";
import pg from "pg";

const EXPECTED_DB="despachefull_incidentes_homologacao";
const TAG="physical-nav-20261108";
const IDENTITIES=[
  {order_id:TAG+"-a",display_id:"88110801",latitude_delta:0.00211,longitude_delta:0.00077},
  {order_id:TAG+"-b",display_id:"88110802",latitude_delta:-0.00177,longitude_delta:0.00265}
];
const env=process.env;
assert.equal(env.APP_ENV,"staging","Seeding forbidden outside staging");
assert.equal(env.STAGING_SAFE_MODE,"true","Safe mode required");
const url=new URL(String(env.DATABASE_URL||""));
assert.equal(decodeURIComponent(url.pathname.slice(1)),EXPECTED_DB,"Wrong database");
assert.ok(url.hostname.includes("dbn9n1psrm7s738pu81g"),"Wrong PostgreSQL host");
const pool=new pg.Pool({
  connectionString:env.DATABASE_URL,
  ssl:env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,
  max:2,connectionTimeoutMillis:7000
});
let client;
try{
  client=await pool.connect();
  assert.equal((await client.query("SELECT current_database() AS db")).rows[0].db,EXPECTED_DB);
  const settings=(await client.query(
    "SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])",
    [["route_store_origin","pre_departure_enabled","route_planner_enabled"]]
  )).rows;
  const flags=Object.fromEntries(settings.map(x=>[x.setting_key,x.setting_value]));
  assert.equal(flags.pre_departure_enabled,"true","Pre-departure is not available");
  const origin=JSON.parse(flags.route_store_origin||"null");
  assert.equal(origin?.source,"ADMIN_CONFIRMED","Confirmed store origin required");
  const lat=Number(origin.latitude),lon=Number(origin.longitude);
  assert.ok(Number.isFinite(lat)&&Number.isFinite(lon),"Store coordinates missing");
  assert.ok(lat>-24 && lat<-23 && lon>-47&&lon<-46,"Origin outside ABC region");
  await client.query("BEGIN");
  // Fail rather than touching somebody else's order with the same number.
  const existing=(await client.query(
    "SELECT order_id,display_id,page_id FROM anotaai_orders WHERE display_id=ANY($1::text[])",
    [IDENTITIES.map(x=>x.display_id)]
  )).rows;
  for(const row of existing){
    assert.equal(row.page_id,TAG,"Conflicting display number - refused");
    assert.ok(IDENTITIES.some(x=>x.order_id===row.order_id),"Conflicting external order - refused");
  }
  let added=0;
  for(const [idx,entry] of IDENTITIES.entries()){
    const dest={latitude:Number((lat+entry.latitude_delta).toFixed(7)),
      longitude:Number((lon+entry.longitude_delta).toFixed(7))};
    const payload={
      deliveryAddress:{
        streetName:"Rua de Homologacao (coordenadas de teste)",
        streetNumber:String(101+idx),
        neighborhood:"Barcelona",
        city:"Sao Caetano do Sul",
        state:"SP",
        coordinates:dest
      },
      customer:{name:"CLIENTE DE TESTE - NAO ENTREGAR"}
    };
    const r=await client.query(
      "INSERT INTO anotaai_orders(order_id,page_id,display_id,status,order_type,remote_created_at,remote_updated_at,payload,customer_name) "+
      "VALUES($1,$2,$3,'READY','DELIVERY',NOW()-INTERVAL '18 minutes',NOW(),$4::jsonb,'CLIENTE DE TESTE - NAO ENTREGAR') "+
      "ON CONFLICT(order_id) DO NOTHING RETURNING order_id",
      [entry.order_id,TAG,entry.display_id,JSON.stringify(payload)]);
    added+=r.rowCount;
    const verify=(await client.query(
      "SELECT order_id,page_id,display_id,status,order_type,payload->'deliveryAddress'->'coordinates' AS coordinates "+
      "FROM anotaai_orders WHERE order_id=$1",
      [entry.order_id])).rows[0];
    assert.equal(verify?.display_id,entry.display_id);
    assert.equal(verify?.page_id,TAG);
    assert.equal(verify?.status,"READY","Refuse already consumed test order");
    assert.equal(verify?.order_type,"DELIVERY");
    assert.deepEqual(verify?.coordinates,dest);
  }
  await client.query("COMMIT");
  console.log("STAGING_PHYSICAL_NAV_2_SEED_RESULT "+JSON.stringify({
    status:"PASS",orders:IDENTITIES.map(x=>x.display_id),inserted:added,
    reused:IDENTITIES.length-added,
    platform:"anotaai",routePlannerEnabled:flags.route_planner_enabled==="true",
    fakeAddresses:true,coordinates:"STORE_RELATIVE_TEST_PINS",
    productionTouched:false,externalProviderCalls:0,customerDataUsed:false
  }));
}catch(error){
  if(client){try{await client.query("ROLLBACK")}catch{}}
  console.error("STAGING_PHYSICAL_NAV_2_SEED_RESULT "+JSON.stringify({
    status:"FAIL",code:String(error.code||"VALIDATION_ERROR"),message:String(error.message||"error").slice(0,180)
  }));
  process.exitCode=1;
}finally{
  client?.release();
  await pool.end();
}
