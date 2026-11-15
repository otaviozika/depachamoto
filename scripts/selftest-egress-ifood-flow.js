import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {deliveryContext,include,plain} from './egress-test-support.js';
import {
  createIfoodDeliveryConfirmation, ifoodDeliveryConfirmationSchema,
  recordIfoodDeliveryCodeVerifiedEvent, claimIfoodDeliveryEffects, finishIfoodDeliveryEffects
} from '../lib/ifood-delivery-confirmation.js';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8'),db=new PGlite();
await db.exec(source.split('await pool.query(`')[1].split('`);')[0]);
await db.exec(ifoodDeliveryConfirmationSchema);
let queryCount=0;
const query=async(sql,args=[])=>{queryCount++;const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
await query("INSERT INTO users(id,name,username,password_hash,role) VALUES(1,'Admin','admin','synthetic','admin'),(2,'A','a','synthetic','courier'),(3,'B','b','synthetic','courier')");
let mode='valid',apiCalls=0,gate=null,seq=0,tests=0,externalBlocked=false,benchmark=false;
const events=[];
const context=deliveryContext(source,query);
Object.assign(context,{
  touchPresence:async()=>{},markConfirmedIncident:async()=>0,ifoodConfigured:()=>true,ifoodMerchantAllowed:id=>id==='synthetic-shop',IFOOD_ORDER_BASE:'https://ifood.test.invalid',
  ifoodSafeError:e=>e.message,auditBestEffort:async()=>{},emitRealtime:(event,body)=>events.push({event,body:plain(body)}),
  maybeAutoMarkDispatchReturning:async()=>{},setImmediate(){},syncIfoodOnce:async()=>{},assertExternalMutationAllowed(){},createNotification:async()=>{},
  ifoodApi:async(url,options)=>{apiCalls++;if(gate)await gate;
    if(mode==='unavailable')throw Object.assign(Error('Synthetic unavailable'),{statusCode:503});
    if(String(url).endsWith('/verifyDeliveryCode')){const code=JSON.parse(options.body).code;return {response:{status:200},body:{valid:code==='1234'}};}
    assert.match(url,/\/dispatch$/);return {response:{status:202},body:{}};
  }
});
const service=createIfoodDeliveryConfirmation({
  pool:{query}, canonicalStatus:context.canonicalIfoodOrderStatus,
  isConfigured:()=>true, isMerchantAllowed:id=>id==='synthetic-shop', normalizeCode:String,
  assertExternalMutationAllowed:()=>{if(externalBlocked)throw Error('STAGING_SAFE_MODE')},
  emitRealtime:context.emitRealtime, onEffectsReady(){},
  verifyCode:async(id,code)=>{
    apiCalls++;
    if(benchmark)await wait(20);
    if(gate)await gate;
    if(mode==='unavailable')throw Object.assign(Error('Synthetic outage'),{statusCode:503});
    if(mode==='timeout')throw Object.assign(Error('Synthetic timeout'),{name:'TimeoutError'});
    if(mode==='rejected')throw Object.assign(Error('Synthetic rejection'),{statusCode:422});
    if(mode==='empty')return {response:{status:200},body:null};
    return {response:{status:200},body:{valid:code==='1234'}};
  }
});
include(context,source,'let ifoodDispatchWorkerRunning = false;','async function processIfoodDispatchByOrder(');
async function fixture({status='DISPATCHED',by='MERCHANT',merchant='synthetic-shop',link='DISPATCHED',hours=1,courier=2,dispatchId=null}={}){
  const id='if-flow-'+(++seq),dispatch=dispatchId?{id:dispatchId}:(await query("INSERT INTO dispatches(dispatch_code,order_number,courier_id,status,departed_at) VALUES($1,$1,$3,'RELEASED',NOW()-($2::int*INTERVAL '1 hour')) RETURNING id",[id,hours,courier])).rows[0];
  await query("INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by) VALUES($1,$1,$2,$3,'DELIVERY',$4)",[id,merchant,status,by]);
  await query("INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number,ifood_dispatch_status) VALUES($1,$2,$1,$3)",[id,dispatch.id,link]);
  return {id,dispatch:dispatch.id};
}
async function verify(f,{courier=2,code='1234',check=false,handler=service.verify}={}){
  const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=plain(body);return this;}};
  await (check?service.status:handler)({params:{orderId:f.id},body:{code},session:{user:{id:courier}}},res);return res;
}
async function test(name,fn){await fn();tests++;console.log('PASS '+name);}
try {
  await test('ownership, code format, merchant, fleet, cancellation and 48-hour guards precede the API call',async()=>{
    const before=apiCalls,f=await fixture();assert.equal((await verify(f,{courier:3})).code,404);assert.equal((await verify(f,{code:'xx'})).code,400);
    assert.equal((await verify(await fixture({merchant:'other'}))).code,403);assert.equal((await verify(await fixture({by:'IFOOD'}))).code,409);
    assert.equal((await verify(await fixture({status:'CANCELLED'}))).code,409);assert.equal((await verify(await fixture({hours:49}))).code,404);
    assert.equal((await verify(await fixture({status:'CONFIRMED',link:'PENDING'}))).code,409);assert.equal(apiCalls,before);
  });
  await test('invalid code can retry, valid code emits only to its courier, and replay is idempotent',async()=>{
    const f=await fixture();assert.equal((await verify(f,{code:'9999'})).code,422);events.length=0;
    const valid=await verify(f);assert.equal(valid.code,200);assert.equal(valid.body.verified,true);
    assert.equal(events.length,1);for(const e of events)assert.equal(e.body.courier_id,2);
    const before=apiCalls;assert.equal((await verify(f)).body.already_confirmed,true);assert.equal(apiCalls,before);
    const stored=(await query('SELECT last_response FROM ifood_delivery_confirmations WHERE ifood_order_id=$1',[f.id])).rows[0];
    assert.equal(JSON.stringify(stored).includes('1234'),false);
  });
  await test('provider outage or timeout reconciles without re-sending the code',async()=>{
    for(const failure of ['unavailable','timeout']){
      const f=await fixture(),before=apiCalls;
      mode=failure;
      assert.equal((await verify(f)).code,202);
      assert.equal((await verify(f,{check:true})).body.retry_allowed,false);
      assert.equal((await verify(f)).code,202);
      assert.equal(apiCalls,before+1);
      assert.equal((await query('SELECT status FROM ifood_delivery_confirmations WHERE ifood_order_id=$1',[f.id])).rows[0].status,'RECONCILING');
      await query("UPDATE ifood_delivery_confirmations SET last_attempt_at=NOW()-INTERVAL '36 seconds' WHERE ifood_order_id=$1",[f.id]);
      await query("UPDATE ifood_sync_state SET last_successful_poll_started_at=NOW()-INTERVAL '40 seconds'");
      assert.equal((await verify(f,{check:true})).body.retry_allowed,false);
      await query("UPDATE ifood_sync_state SET last_successful_poll_started_at=NOW()");
      assert.equal((await verify(f,{check:true})).body.retry_allowed,true);
      mode='valid';
      assert.equal((await verify(f)).body.verified,true);
    }
  });
  await test('empty HTTP 200 confirms immediately and never causes another POST',async()=>{
    const f=await fixture(),before=apiCalls;mode='empty';
    const first=await verify(f);
    assert.equal(first.code,200);
    assert.equal(first.body.verified,true);
    assert.equal((await verify(f,{check:true,courier:3})).code,404);
    assert.equal((await verify(f,{check:true})).body.verified,true);
    assert.equal((await verify(f)).body.already_confirmed,true);
    assert.equal(apiCalls,before+1);
    mode='valid';
  });
  await test('422 followed by CONCLUDED is idempotent; concurrent late 422 preserves verified state',async()=>{
    const f=await fixture(),before=apiCalls;mode='rejected';
    assert.equal((await verify(f)).code,202);
    await query("UPDATE ifood_orders SET status='CONCLUDED' WHERE order_id=$1",[f.id]);
    assert.equal((await verify(f,{check:true})).body.state,'CONCLUDED');
    assert.equal((await verify(f)).body.concluded,true);
    assert.equal(apiCalls,before+1);

    const race=await fixture();
    let release;gate=new Promise(r=>{release=r;});const post=verify(race);
    for(let n=0;n<100&&apiCalls===before+1;n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(apiCalls,before+2);
    await recordIfoodDeliveryCodeVerifiedEvent({query},race.id,new Date());
    release();gate=null;
    assert.equal((await post).body.verified,true);
    const persisted=(await query("SELECT status,last_http_status FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",[race.id])).rows[0];
    assert.deepEqual(persisted,{status:'VERIFIED',last_http_status:422});
    mode='valid';
  });
  await test('staging guard runs before a claim or external request',async()=>{
    const before=apiCalls,f=await fixture();
    externalBlocked=true;
    await assert.rejects(verify(f),/STAGING_SAFE_MODE/);
    externalBlocked=false;
    assert.equal(apiCalls,before);
    assert.equal((await query("SELECT * FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",[f.id])).rows.length,0);
  });
  await test('queued operational effects survive a lost worker and can be retried',async()=>{
    const pending=await claimIfoodDeliveryEffects({query});
    assert.ok(pending.length>0);
    assert.equal((await claimIfoodDeliveryEffects({query})).some(x=>x.ifood_order_id===pending[0].ifood_order_id),false);
    await query("UPDATE ifood_delivery_confirmations SET effects_due_at=NOW()-INTERVAL '1 second' WHERE ifood_order_id=$1",[pending[0].ifood_order_id]);
    const retried=(await claimIfoodDeliveryEffects({query})).find(x=>x.ifood_order_id===pending[0].ifood_order_id);
    assert.ok(retried);
    await finishIfoodDeliveryEffects({query},pending[0]);
    assert.equal((await query("SELECT effects_due_at IS NOT NULL AS pending FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",[retried.ifood_order_id])).rows[0].pending,true);
    await finishIfoodDeliveryEffects({query},retried);
    assert.equal((await query("SELECT effects_due_at IS NULL AS cleared FROM ifood_delivery_confirmations WHERE ifood_order_id=$1",[retried.ifood_order_id])).rows[0].cleared,true);
  });
  await test('deliveries in the same dispatch can be confirmed in any order',async()=>{
    const first=await fixture(),second=await fixture({dispatchId:first.dispatch});
    assert.equal((await verify(second)).body.verified,true);
    assert.equal((await verify(first)).body.verified,true);
  });
  await test('two simultaneous confirmations acquire one claim and call the remote API once',async()=>{
    const f=await fixture(),before=apiCalls;let release;gate=new Promise(r=>{release=r;});const first=verify(f);
    for(let n=0;n<100&&apiCalls===before;n++)await new Promise(r=>setTimeout(r,5));assert.equal(apiCalls,before+1);
    const second=await verify(f);assert.equal(second.code,202);assert.equal(second.body.state,'PROCESSING');release();assert.equal((await first).code,200);gate=null;assert.equal(apiCalls,before+1);
  });
  await test('accepted and retrying dispatch workers identify the affected courier',async()=>{
    for(const remoteMode of ['valid','unavailable']){
      const f=await fixture({status:'CONFIRMED',link:'PENDING'});
      await query("INSERT INTO ifood_dispatch_jobs(ifood_order_id,dispatch_id,status,attempts) VALUES($1,$2,'PROCESSING',1)",[f.id,f.dispatch]);
      mode=remoteMode;events.length=0;const result=await context.processClaimedIfoodDispatchJob({ifood_order_id:f.id,attempts:1});
      assert.equal(remoteMode==='valid'?result.accepted:result.retry,true);assert.equal(events.length,1);assert.equal(events[0].body.courier_id,2);
    }
  });
  await test('600 synthetic deliveries, up to 40 couriers in parallel',async()=>{
    mode='valid';
    await query("INSERT INTO users(id,name,username,password_hash,role) SELECT id,'Courier','synthetic-'||id,'synthetic','courier' FROM generate_series(4,41) AS id");
    const orders=await Promise.all(Array.from({length:40},async(_,i)=>{
      const courier=i+2;
      const first=await fixture({courier});
      const rest=await Promise.all(Array.from({length:14},()=>fixture({courier,dispatchId:first.dispatch})));
      return {courier, orders:[first,...rest].reverse()};
    }));
    async function run(handler){
      const before=apiCalls,queriesBefore=queryCount,latencies=[];
      await Promise.all(orders.map(async({courier,orders:deliveries})=>{
        for(const order of deliveries){
          const started=performance.now();
          const response=await verify(order,{courier,handler});
          latencies.push(performance.now()-started);
          assert.equal(response.body.verified,true);
        }
      }));
      assert.equal(apiCalls,before+600);
      latencies.sort((a,b)=>a-b);
      return {orders:600,couriers:40,sql_per_order:(queryCount-queriesBefore)/600,
        p50_ms:+latencies[299].toFixed(2),p95_ms:+latencies[569].toFixed(2)};
    }
    benchmark=process.argv.includes('--benchmark');
    if(benchmark){
      const old=execFileSync('git',['show','0de040a61b5e3ca09f0f2654a03bdc4b0911d6c9:server.js'],{encoding:'utf8'});
      let oldHandler;
      Object.assign(context,{auth(){},courierOnly(){},deliveryCodeLimiter(){},asyncRoute:fn=>fn,
        app:{post:(_, ...args)=>{oldHandler=args.at(-1)}},
        ifoodApi:async()=>{apiCalls++;await wait(20);return {response:{status:200},body:{valid:true}}}
      });
      include(context,old,'function normalizeDeliveryCode(','function deliveryConfirmationLabel(');
      const start=old.indexOf('app.post("/api/courier/ifood/orders/:orderId/verify-delivery"');
      vm.runInContext(old.slice(start,old.indexOf('\n}));',start)+5),context);
      console.log('IFOOD_LOAD_BASELINE '+JSON.stringify(await run(oldHandler)));
      await query('DELETE FROM ifood_delivery_confirmations WHERE ifood_order_id=ANY($1::text[])',
        [orders.flatMap(group=>group.orders.map(order=>order.id))]);
    }
    console.log('IFOOD_LOAD '+JSON.stringify(await run(service.verify)));
  });
  console.log(JSON.stringify({result:'PASS',scenarios:tests,syntheticExternalApi:true}));
}finally{await db.close();}
