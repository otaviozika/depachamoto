import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

// Execute production functions and SQL against isolated PostgreSQL (WASM).
// PGlite has one connection; the pool serializes transactions. This exercises
// constraints and rollback, but is not a multi-instance advisory-lock load test.
const source = fs.readFileSync(new URL('../server.js', import.meta.url),'utf8');
const db = new PGlite();
const schema = source.split('await pool.query(`')[1].split('`);')[0];
await db.exec(schema);
let tail=Promise.resolve();
const query=async(sql,args=[])=>{
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:1};
  const result=await db.query(sql,args);return {...result,rowCount:result.rows.length || result.affectedRows || 0};
};
const pool={query,connect:async()=>{
  const previous=tail;let release;tail=new Promise(r=>release=r);await previous;
  return {query,release};
}};
const context=vm.createContext({pool,console,Date,process,Set,Map,
  io:{emit(){}},
  getCurrentOperationalShift:d=>({operational_date:d.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),shift_code:'LUNCH',shift_label:'Almoço'}),
  shiftLabel:s=>s==='LUNCH'?'Almoço':'Janta',
  auditBestEffort:async()=>{},
  normalizeIfoodLifecycleStatus:v=>String(v||'').toUpperCase(),
  getOperationalSlaSettings:async()=>({route:{1:25,2:30,3:35,4:40,5:45},returnMinutes:15}),
  orderArraySql:a=>`(SELECT json_agg(order_number) FROM dispatch_orders WHERE dispatch_id=${a}.id) AS order_numbers`,
  upsertIfoodOrderFromDetails:async()=>{},
  fetchIfoodOrderDetails:async id=>{const row=(await query('SELECT * FROM ifood_orders WHERE order_id=$1',[id])).rows[0];return {id,merchant:{id:row.merchant_id},orderType:row.order_type,delivery:{deliveredBy:row.delivered_by}}}
});
function include(start,end){vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context)}
include('function canonicalIfoodOrderStatus','async function refreshIfoodOrderClassificationForDeparture');
include('function orderDateSP','async function getAvailableIfoodOrders');
include('function normalizeOrders','const orderArraySql');
include('function validateDepartureCount','async function addRouteOrder');
include('async function createDispatchTransaction','async function checkTimeNotifications');
include('function operationalRouteSlaMinutes','function operationalTiming');
include('async function getCourierDeliveryCount','async function buildPaymentRow');
include('async function getDispatchProgressMap','function decorateOperationalDispatches');
include('async function markDispatchReturning','async function maybeAutoMarkDispatchReturning');
await query("INSERT INTO users(id,name,username,password_hash,role) VALUES(1,'Admin','admin','test','admin'),(2,'A','a','test','courier'),(3,'B','b','test','courier'),(4,'C','c','test','courier')");
const add=async(id,status='CONFIRMED',type='DELIVERY',by='MERCHANT',merchant='shop')=>query(`INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by,order_created_at) VALUES($1,$1,$5,$2,$3,$4,NOW())`,[id,status,type,by,merchant]);
const link=id=>({order_id:id,order_number:'#'+id});
const create=(courierId,ids,options={})=>context.createDispatchTransaction({actorUserId:1,courierId,orders:ids.map(x=>'#'+x),source:'COURIER',ifoodLinks:ids.map(link),...options});
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
await test('quantidade exata e sem campos vazios ou duplicados',async()=>{
  for(let n=1;n<=5;n++)context.validateDepartureCount({order_count:n,order_numbers:Array.from({length:n},(_,i)=>String(i+1))});
  for(const body of [{},{order_count:0,order_numbers:[]},{order_count:6,order_numbers:['1']},{order_count:2,order_numbers:['1']},{order_count:2,order_numbers:['1','']},{order_count:2,order_numbers:['1','#1']},{order_count:'1',order_numbers:['1']}])assert.throws(()=>context.validateDepartureCount(body));
});
await test('proteções iFood e exceção exclusiva de recuperação',async()=>{
  for(const [id,status,type,by] of [['a','CONFIRMED','DELIVERY','MERCHANT'],['b','DISPATCHED','DELIVERY','MERCHANT'],['c','CONFIRMED','TAKEOUT','MERCHANT'],['d','CONFIRMED','DELIVERY','IFOOD'],['e','CANCELLED','DELIVERY','MERCHANT'],['f','CONCLUDED','DELIVERY','MERCHANT'],['g','PLACED','DELIVERY','MERCHANT'],['h','CONFIRMED','DELIVERY','UNKNOWN']])await add(id,status,type,by);
  for(const id of ['b','c','d','e','f','g','h'])assert.equal((await context.inspectIfoodOrdersForDeparture(['#'+id])).accepted.length,0);
  assert.equal((await context.inspectIfoodOrdersForDeparture(['#a'])).accepted.length,1);
  assert.equal((await context.inspectIfoodOrdersForDeparture(['#b'],{recovery:true})).accepted.length,1);
  for(const id of ['a','c','d','e','f','g','h'])assert.equal((await context.inspectIfoodOrdersForDeparture(['#'+id],{recovery:true})).accepted.length,0);
});
let first;
await test('adicionar mantém saída, horário e soma pedidos/pagamento',async()=>{
  first=(await create(2,['a'])).dispatch;
  await add('i');const next=(await create(2,['i'],{append:true})).dispatch;
  assert.equal(next.id,first.id);assert.equal(+new Date(next.departed_at),+new Date(first.departed_at));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM dispatch_orders WHERE dispatch_id=$1',[first.id])).rows[0].n,2);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM ifood_dispatch_jobs')).rows[0].n,2);
  const today=(await query("SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date::text AS day")).rows[0].day;
  assert.equal(await context.getCourierDeliveryCount(2,today),2);
});
await test('recuperação anexa sem job de dispatch e com auditoria',async()=>{
  const next=(await create(2,['b'],{recovery:true,adminReason:'Esqueceu de registrar'})).dispatch;
  assert.equal(next.id,first.id);
  assert.equal((await query("SELECT * FROM ifood_dispatch_jobs WHERE ifood_order_id='b'")).rows.length,0);
  assert.equal((await query("SELECT ifood_dispatch_status FROM ifood_dispatch_links WHERE ifood_order_id='b'")).rows[0].ifood_dispatch_status,'DISPATCHED');
  assert.equal((await query("SELECT details FROM audit_logs WHERE action='EXTERNAL_DISPATCH_LINKED'")).rows[0].details.recovered_departure,false);
});
await test('recuperação sem rota preserva horário informado e tabelas de entrega',async()=>{
  await add('j','DISPATCHED');const when=new Date(Date.now()-3600000).toISOString();
  const result=(await create(3,['j'],{recovery:true,source:'ADMIN_RECOVERED',adminReason:'Saída esquecida',departedAt:when})).dispatch;
  assert.equal(result.registration_source,'ADMIN_RECOVERED');assert.equal(+new Date(result.departed_at),+new Date(when));
  assert.equal((await query("SELECT d.courier_id FROM ifood_dispatch_links l JOIN dispatches d ON d.id=l.dispatch_id WHERE l.ifood_order_id='j'")).rows[0].courier_id,3);
});
await test('duplicidade faz rollback integral inclusive auditoria',async()=>{
  const before=(await query('SELECT COUNT(*)::int AS n FROM audit_logs')).rows[0].n;
  await assert.rejects(create(3,['b'],{recovery:true}));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM audit_logs')).rows[0].n,before);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM dispatch_orders WHERE order_number='#b'")).rows[0].n,1);
});
await test('concorrência: mesmo UUID gera somente um vínculo',async()=>{
  await add('k');const results=await Promise.allSettled([create(2,['k'],{append:true}),create(3,['k'],{append:true})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ifood_dispatch_links WHERE ifood_order_id='k'")).rows[0].n,1);
});
await test('limite da rota e bloqueio de segunda saída',async()=>{
  await add('l');await create(2,['l'],{append:true});await add('m');
  await assert.rejects(create(2,['m'],{append:true}),/máximo 5/);
  await assert.rejects(create(2,['m']),/saída em andamento/);
});
await test('rota retornando, rota inexistente e mudança de status bloqueiam',async()=>{
  await query("UPDATE dispatches SET operational_stage='RETURNING' WHERE courier_id=3");
  await assert.rejects(create(3,['m'],{append:true}),/retornando/);
  await assert.rejects(create(4,['m'],{append:true}),/Não há rota/);
  await assert.rejects(create(4,['e']),/mudou no iFood/);
});
await test('falha de auditoria desfaz recuperação inteira',async()=>{
  await add('n','DISPATCHED');
  await assert.rejects(context.createDispatchTransaction({actorUserId:999,courierId:4,orders:['#n'],source:'ADMIN_RECOVERED',recovery:true,ifoodLinks:[link('n')]}));
  assert.equal((await query("SELECT * FROM ifood_dispatch_links WHERE ifood_order_id='n'")).rows.length,0);
  assert.equal((await query('SELECT * FROM dispatches WHERE courier_id=4')).rows.length,0);
});
await test('pagamento fechado bloqueia apenas o turno do vínculo',async()=>{
  await query("INSERT INTO courier_payments(payment_date,courier_id,shift_code,status) VALUES((NOW() AT TIME ZONE 'America/Sao_Paulo')::date,4,'LUNCH','PAID')");
  await assert.rejects(create(4,['n'],{recovery:true}),/pagamento de .*revisado ou pago/);
  assert.equal((await query("SELECT * FROM ifood_dispatch_links WHERE ifood_order_id='n'")).rows.length,0);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM courier_payments WHERE courier_id=4 AND shift_code='DINNER'")).rows[0].n,0);
});
await test('outra loja e falha da consulta iFood bloqueiam',async()=>{
  const saved=process.env.IFOOD_MERCHANT_ID;process.env.IFOOD_MERCHANT_ID='other-shop';
  try{assert.equal((await context.inspectIfoodOrdersForDeparture(['#m'])).accepted.length,0)}finally{if(saved===undefined)delete process.env.IFOOD_MERCHANT_ID;else process.env.IFOOD_MERCHANT_ID=saved}
  context.fetchIfoodOrderDetails=async()=>{throw Error('iFood indisponível')};
  await assert.rejects(context.inspectIfoodOrdersForDeparture(['#m']),/indisponível/);
});
await test('retorno revalida pedidos depois de adquirir a trava da rota',async()=>{
  assert.equal(await context.markDispatchReturning(first.id,{source:'AUTO_IFOOD_CONCLUDED'}),null);
  await assert.rejects(context.markDispatchReturning(first.id,{source:'COURIER_MANUAL'}),/entregas pendentes/);
  await query("UPDATE ifood_orders SET status='CONCLUDED' WHERE order_id IN (SELECT ifood_order_id FROM ifood_dispatch_links WHERE dispatch_id=$1)",[first.id]);
  assert.equal((await context.markDispatchReturning(first.id,{source:'AUTO_IFOOD_CONCLUDED'})).operational_stage,'RETURNING');
});
await db.close();console.log(JSON.stringify({result:'PASS',tests:count}));
