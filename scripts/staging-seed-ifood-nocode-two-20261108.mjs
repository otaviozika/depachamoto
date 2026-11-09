/**
 * Fixture de homologação exclusivamente no PostgreSQL isolado do Render.
 * Nunca chama iFood nem altera produção. --check é somente leitura.
 * --apply somente quando o motoboy piloto não possui saída ativa.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const TAG='stg-ifood-nocode-20261108';
const CODE='STG-IF-NOCODE-20261108';
const DB='despachefull_incidentes_homologacao';
const ORDERS=[
  {id:TAG+'-a',number:'88110871',streetNo:'171',dLat:0.00227,dLon:0.00061},
  {id:TAG+'-b',number:'88110872',streetNo:'172',dLat:-0.00136,dLon:0.00237}
];
const mode=process.argv[2];
assert.ok(['--check','--apply'].includes(mode),'Select --check or --apply');
assert.equal(process.env.APP_ENV,'staging','This script is staging-only');
assert.equal(process.env.STAGING_SAFE_MODE,'true','Staging safe mode required');
const url=new URL(process.env.DATABASE_URL||'');
assert.equal(decodeURIComponent(url.pathname.slice(1)),DB,'Unexpected database');
assert.ok(url.hostname.includes('dbn9n1psrm7s738pu81g'),'Unexpected PostgreSQL host');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
 ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,max:1,connectionTimeoutMillis:7000});
let c,transaction=false;
const outcome={status:'BLOCKED',mode,platform:'ifood',numbers:ORDERS.map(o=>o.number),
  productionTouched:false,externalCalls:0};
try{
 c=await pool.connect();
 assert.equal((await c.query('SELECT current_database() AS db')).rows[0].db,DB);
 await c.query('BEGIN'); transaction=true;
 await c.query("SELECT pg_advisory_xact_lock(hashtext('staging-ifood-nocode-20261108'))");
 const flags=Object.fromEntries((await c.query(
  "SELECT setting_key,setting_value FROM app_settings WHERE setting_key=ANY($1::text[])",
  [['delivery_incidents_enabled','delivery_incidents_pilot_courier_id',
    'pre_departure_enabled','route_planner_enabled','route_store_origin']]
 )).rows.map(x=>[x.setting_key,x.setting_value]));
 assert.equal(flags.delivery_incidents_enabled,'true','Pilot disabled');
 assert.equal(flags.pre_departure_enabled,'true','Pre-departure disabled');
 assert.notEqual(flags.route_planner_enabled,'true','Disable auto-routing before fixture');
 const courierId=Number(flags.delivery_incidents_pilot_courier_id);
 assert.ok(Number.isSafeInteger(courierId)&&courierId>0,'No pilot courier');
 assert.equal((await c.query(
  "SELECT count(*)::int n FROM users WHERE id=$1 AND role='courier' AND active AND approval_status='APPROVED'",
  [courierId])).rows[0].n,1,'Pilot courier not active and approved');
 const origin=JSON.parse(flags.route_store_origin||'null');
 assert.equal(origin?.source,'ADMIN_CONFIRMED','Store origin not approved');
 assert.ok(Number(origin.latitude)>-24&&Number(origin.latitude)<-23
  &&Number(origin.longitude)>-47&&Number(origin.longitude)<-46,'Invalid store coordinates');
 outcome.pilotCourierId=courierId;

 const previous=(await c.query('SELECT id,courier_id,status FROM dispatches WHERE dispatch_code=$1',[CODE])).rows[0];
 if(previous){
  assert.equal(Number(previous.courier_id),courierId,'Conflicting prior dispatch');
  const stops=(await c.query(
   "SELECT s.order_number,s.platform,s.external_order_id,o.is_test FROM dispatch_route_stops s JOIN ifood_orders o ON o.order_id=s.external_order_id WHERE s.dispatch_id=$1 ORDER BY s.sequence",
   [previous.id])).rows;
  assert.equal(stops.length,2,'Incomplete existing fixture');
  for(let i=0;i<2;i++){
   assert.equal(stops[i].order_number,'#'+ORDERS[i].number);
   assert.equal(stops[i].platform,'ifood');
   assert.equal(stops[i].external_order_id,ORDERS[i].id);
   assert.equal(stops[i].is_test,true);
  }
  Object.assign(outcome,{status:'ALREADY_SEEDED',dispatchId:Number(previous.id),dispatchStatus:previous.status});
 }else{
  assert.equal((await c.query("SELECT count(*)::int n FROM dispatches WHERE courier_id=$1 AND status='ON_ROAD'",[courierId])).rows[0].n,0,
   'Pilot courier has an active dispatch; finish it before test');
  assert.equal((await c.query(
   "SELECT count(*)::int n FROM pre_departures WHERE courier_id=$1 AND status=ANY($2::text[])",
   [courierId,['DRAFT','AWAITING_CHECK','PARTIALLY_CHECKED','CHECKED','ROUTE_READY','BLOCKED']])).rows[0].n,0,
   'Pilot courier has an unfinished pre-departure');
  const ids=ORDERS.map(o=>o.id),numbers=ORDERS.map(o=>o.number);
  assert.equal((await c.query(
   'SELECT count(*)::int n FROM ifood_orders WHERE order_id=ANY($1::text[]) OR display_id=ANY($2::text[])',
   [ids,numbers])).rows[0].n,0,'Conflicting iFood order ID');
  assert.equal((await c.query(
   'SELECT count(*)::int n FROM anotaai_orders WHERE display_id=ANY($1::text[])',
   [numbers])).rows[0].n,0,'Conflicting AnotaAI number');
  assert.equal((await c.query(
   "SELECT count(*)::int n FROM active_order_locks WHERE platform='ifood' AND order_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date AND order_number=ANY($1::text[])",
   [numbers.map(n=>'#'+n)])).rows[0].n,0,'Conflicting lock');

  if(mode==='--check'){
   outcome.status='READY_TO_APPLY';
  }else{
   const d=(await c.query(
    "INSERT INTO dispatches(dispatch_code,order_number,courier_id,registration_source,admin_reason,departed_at,operational_date,shift_code,status,operational_stage) VALUES($1,$2,$3,'STAGING_FIXTURE','Homologacao iFood sem codigo',NOW(),(NOW() AT TIME ZONE 'America/Sao_Paulo')::date,'DINNER','ON_ROAD','EN_ROUTE') RETURNING id",
    [CODE,'#'+ORDERS[0].number,courierId])).rows[0];
   const dispatchId=Number(d.id);
   for(let i=0;i<ORDERS.length;i++){
    const o=ORDERS[i],number='#'+o.number;
    const address={streetName:'Rua de Homologacao (ficticia)',streetNumber:o.streetNo,
      neighborhood:'Barcelona',city:'Sao Caetano do Sul',state:'SP',coordinates:{
      latitude:Number((Number(origin.latitude)+o.dLat).toFixed(7)),
      longitude:Number((Number(origin.longitude)+o.dLon).toFixed(7))}};
    const payload={customer:{name:'CLIENTE TESTE IFOOD '+(i+1)+' - NAO ENTREGAR'},
      delivery:{deliveryAddress:address,deliveredBy:'MERCHANT'},deliveryAddress:address};
    await c.query(
     "INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by,is_test,order_created_at,payload) VALUES($1,$2,'staging-only-merchant','DISPATCHED','DELIVERY','MERCHANT',TRUE,NOW(),$3::jsonb)",
     [o.id,o.number,JSON.stringify(payload)]);
    await c.query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'ifood')",[dispatchId,number]);
    await c.query(
     "INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number,ifood_dispatch_status) VALUES($1,$2,$3,'SENT')",
     [o.id,dispatchId,number]);
    await c.query(
     "INSERT INTO active_order_locks(order_number,order_date,platform,dispatch_id,courier_id) VALUES($1,(NOW() AT TIME ZONE 'America/Sao_Paulo')::date,'ifood',$2,$3)",
     [number,dispatchId,courierId]);
   }
   const stops=ORDERS.map((o,i)=>({order_number:'#'+o.number,platform:'ifood',
      external_order_id:o.id,sequence:i+1}));
   await c.query(
    "INSERT INTO dispatch_routes(dispatch_id,route_version,route_status,route,acked_version) VALUES($1,1,'ADMIN',$2::jsonb,1)",
    [dispatchId,JSON.stringify({source:'ADMIN_SEQUENCE',duration_minutes:10,stops})]);
   for(let i=0;i<ORDERS.length;i++) await c.query(
    "INSERT INTO dispatch_route_stops(dispatch_id,sequence,order_number,platform,external_order_id) VALUES($1,$2,$3,'ifood',$4)",
    [dispatchId,i+1,'#'+ORDERS[i].number,ORDERS[i].id]);
   await c.query(
    "INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES(NULL,'STAGING_SYNTHETIC_IFOOD_FIXTURE_CREATED','dispatch',$1,$2::jsonb)",
    [dispatchId,JSON.stringify({tag:TAG,numbers,providerCalls:0})]);
   assert.equal((await c.query(
    "SELECT count(*)::int n FROM dispatch_route_stops s JOIN ifood_orders o ON o.order_id=s.external_order_id AND o.is_test=TRUE JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id AND l.dispatch_id=s.dispatch_id WHERE s.dispatch_id=$1 AND s.platform='ifood' AND o.status='DISPATCHED' AND l.ifood_dispatch_status='SENT'",
    [dispatchId])).rows[0].n,2,'Fixture integrity failed');
   Object.assign(outcome,{status:'SEEDED',dispatchId,dispatchStatus:'ON_ROAD'});
  }
 }
 if(mode==='--apply'&&outcome.status==='SEEDED')await c.query('COMMIT');
 else await c.query('ROLLBACK');
 transaction=false;
}catch(e){
 if(transaction)await c.query('ROLLBACK').catch(()=>{});
 outcome.status='BLOCKED';
 outcome.reason=String(e.message||e).slice(0,200);
 process.exitCode=1;
}finally{c?.release();await pool.end();}
console.log('STAGING_SYNTHETIC_IFOOD_NOCODE '+JSON.stringify(outcome));