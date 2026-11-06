import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {deliveryContext,include,plain} from './egress-test-support.js';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8'),db=new PGlite();
await db.exec(source.split('await pool.query(`')[1].split('`);')[0]);
const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
await query("INSERT INTO users(id,name,username,password_hash,role) VALUES(1,'Admin','admin','synthetic','admin'),(2,'A','a','synthetic','courier'),(3,'B','b','synthetic','courier')");
let handler,mode='valid',apiCalls=0,gate=null,seq=0,tests=0;
const events=[],audits=[];
const context=deliveryContext(source,query);
Object.assign(context,{auth(){},courierOnly(){},deliveryCodeLimiter(){},asyncRoute:fn=>fn,app:{post:(_, ...args)=>{handler=args.at(-1);}},
  touchPresence:async()=>{},markConfirmedIncident:async()=>0,ifoodConfigured:()=>true,ifoodMerchantAllowed:id=>id==='synthetic-shop',IFOOD_ORDER_BASE:'https://ifood.test.invalid',
  ifoodSafeError:e=>e.message,auditBestEffort:async(...args)=>audits.push(args),emitRealtime:(event,body)=>events.push({event,body:plain(body)}),
  maybeAutoMarkDispatchReturning:async()=>{},setImmediate(){},syncIfoodOnce:async()=>{},assertExternalMutationAllowed(){},createNotification:async()=>{},
  ifoodApi:async(url,options)=>{apiCalls++;if(gate)await gate;
    if(mode==='unavailable')throw Object.assign(Error('Synthetic unavailable'),{statusCode:503});
    if(String(url).endsWith('/verifyDeliveryCode')){const code=JSON.parse(options.body).code;return {response:{status:200},body:{valid:code==='1234'}};}
    assert.match(url,/\/dispatch$/);return {response:{status:202},body:{}};
  }
});
include(context,source,'function normalizeDeliveryCode(','function deliveryConfirmationLabel(');
const start=source.indexOf('app.post("/api/courier/ifood/orders/:orderId/verify-delivery"'),end=source.indexOf('\n}));',start)+6;
assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),context);
include(context,source,'let ifoodDispatchWorkerRunning = false;','async function processIfoodDispatchByOrder(');
async function fixture({status='DISPATCHED',by='MERCHANT',merchant='synthetic-shop',link='DISPATCHED',hours=1}={}){
  const id='if-flow-'+(++seq),dispatch=(await query("INSERT INTO dispatches(dispatch_code,order_number,courier_id,status,departed_at) VALUES($1,$1,2,'RELEASED',NOW()-($2::int*INTERVAL '1 hour')) RETURNING id",[id,hours])).rows[0];
  await query("INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by) VALUES($1,$1,$2,$3,'DELIVERY',$4)",[id,merchant,status,by]);
  await query("INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number,ifood_dispatch_status) VALUES($1,$2,$1,$3)",[id,dispatch.id,link]);
  return {id,dispatch:dispatch.id};
}
async function verify(f,{courier=2,code='1234'}={}){
  const res={code:200,status(n){this.code=n;return this;},json(body){this.body=plain(body);return this;}};
  await handler({params:{orderId:f.id},body:{code},session:{user:{id:courier}}},res);return res;
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
    assert.equal(events.length,2);for(const e of events)assert.equal(e.body.courier_id,2);
    const before=apiCalls;assert.equal((await verify(f)).body.already_confirmed,true);assert.equal(apiCalls,before);
    assert.equal(JSON.stringify(audits).includes('1234'),false);
  });
  await test('temporary API failure remains retryable and never marks a delivery verified',async()=>{
    const f=await fixture();mode='unavailable';assert.equal((await verify(f)).code,503);
    assert.equal((await query('SELECT status FROM ifood_delivery_confirmations WHERE ifood_order_id=$1',[f.id])).rows[0].status,'FAILED');mode='valid';assert.equal((await verify(f)).code,200);
  });
  await test('two simultaneous confirmations acquire one claim and call the remote API once',async()=>{
    const f=await fixture(),before=apiCalls;let release;gate=new Promise(r=>{release=r;});const first=verify(f);
    for(let n=0;n<100&&apiCalls===before;n++)await new Promise(r=>setTimeout(r,5));assert.equal(apiCalls,before+1);
    const second=await verify(f);assert.equal(second.code,409);assert.equal(second.body.code,'DELIVERY_CONFIRMATION_PROCESSING');release();assert.equal((await first).code,200);gate=null;assert.equal(apiCalls,before+1);
  });
  await test('accepted and retrying dispatch workers identify the affected courier',async()=>{
    for(const remoteMode of ['valid','unavailable']){
      const f=await fixture({status:'CONFIRMED',link:'PENDING'});
      await query("INSERT INTO ifood_dispatch_jobs(ifood_order_id,dispatch_id,status,attempts) VALUES($1,$2,'PROCESSING',1)",[f.id,f.dispatch]);
      mode=remoteMode;events.length=0;const result=await context.processClaimedIfoodDispatchJob({ifood_order_id:f.id,attempts:1});
      assert.equal(remoteMode==='valid'?result.accepted:result.retry,true);assert.equal(events.length,1);assert.equal(events[0].body.courier_id,2);
    }
  });
  console.log(JSON.stringify({result:'PASS',scenarios:tests,syntheticExternalApi:true}));
}finally{await db.close();}
