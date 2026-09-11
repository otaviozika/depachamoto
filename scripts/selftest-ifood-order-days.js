import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

// Real production SQL/functions; isolated PostgreSQL, synthetic data and fake iFood.
// Transactions are serialized because PGlite exposes one connection. This is not
// a substitute for a multi-instance PostgreSQL load test.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const schema = source.split('await pool.query(`')[1].split('`);')[0];
const migration = schema.slice(schema.indexOf('-- Preserve existing locks'), schema.indexOf('CREATE TABLE IF NOT EXISTS ifood_dispatch_jobs'));
const db = new PGlite();
await db.exec(schema.replace(migration, ''));
let tail = Promise.resolve();
const query = async (sql, args = []) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
  const result = await db.query(sql, args);
  return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
};
const pool = { query, connect: async () => {
  const previous = tail; let release;
  tail = new Promise(r => { release = r; }); await previous;
  return { query, release };
} };
const today = (await query("SELECT to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day")).rows[0].day;
const noon = new Date(today + 'T12:00:00-03:00');
const yesterday = new Date(+noon - 86400000).toISOString().slice(0, 10);
let clock = +noon;
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
const fetched = [];
const context = vm.createContext({ pool, console, Date: TestDate, process: { env: { IFOOD_MERCHANT_ID: 'shop' } },
  io: { emit() {} }, auditBestEffort: async () => {},
  normalizeIfoodLifecycleStatus: v => String(v || '').toUpperCase(),
  getOperationalSlaSettings: async () => ({ route: {1:25,2:30,3:35,4:40,5:45}, returnMinutes:15 }),
  getCourierAttendance: async () => ({ checked_out_at: null }), getSPDate: async () => today,
  setImmediate: () => {},
  orderArraySql: a => `(SELECT json_agg(order_number) FROM dispatch_orders WHERE dispatch_id=${a}.id) AS order_numbers`,
  upsertIfoodOrderFromDetails: async () => {},
  fetchIfoodOrderDetails: async id => {
    fetched.push(id);
    const row = (await query('SELECT * FROM ifood_orders WHERE order_id=$1', [id])).rows[0];
    return { id, merchant:{id:row.merchant_id}, orderType:row.order_type, delivery:{deliveredBy:row.delivered_by} };
  }
});
function include(start, end) {
  const at = source.indexOf(start); assert.ok(at >= 0, start);
  vm.runInContext(source.slice(at, source.indexOf(end, at)), context);
}
include('function canonicalIfoodOrderStatus', 'async function refreshIfoodOrderClassificationForDeparture');
include('function orderDateSP', 'async function ifoodOrderAlreadyStored');
include('function normalizeOrders', 'const orderArraySql');
include('async function inspectOrders', 'async function notificationEnabled');
include('async function createDispatchTransaction', 'async function checkTimeNotifications');
include('function operationalRouteSlaMinutes', 'function operationalTiming');
include('async function addRouteOrder', "app.post('/api/courier/route/orders'");
await query("INSERT INTO users(id,name,username,password_hash,role,active,approval_status) VALUES(1,'Admin','admin','test','admin',true,'APPROVED')");
for (let id = 2; id <= 30; id++) await query("INSERT INTO users(id,name,username,password_hash,role,active,approval_status) VALUES($1,$2,$2,'test','courier',true,'APPROVED')", [id, 'courier-'+id]);
const add = async (id, number, day = today, status = 'CONFIRMED', merchant = 'shop') => query(`INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by,order_created_at,last_event_at)
  VALUES($1,$2,$3,$4,'DELIVERY','MERCHANT',$5::timestamptz,NOW())`, [id,number,merchant,status,day+'T10:00:00-03:00']);
const inspect = (number, options) => context.inspectIfoodOrdersForDeparture(['#'+number], options);
const create = (courierId, links, options={}) => context.createDispatchTransaction({actorUserId:1,courierId,orders:links.map(x=>x.order_number),source:'COURIER',ifoodLinks:links,...options});
const finish = async id => { await query("UPDATE dispatches SET status='RELEASED' WHERE id=$1",[id]); await query('DELETE FROM active_order_locks WHERE dispatch_id=$1',[id]); };
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS '+name); }

// Seed the old schema first, including a departure after midnight for yesterday's order.
await add('old-1234','1234',yesterday,'DISPATCHED');
await query("INSERT INTO dispatches(id,dispatch_code,order_number,courier_id,departed_at) VALUES(100,'legacy','#1234',2,$1::timestamptz),(101,'manual','#manual',3,$2::timestamptz)", [today+'T00:05:00-03:00',yesterday+'T23:50:00-03:00']);
await query("INSERT INTO dispatch_orders(dispatch_id,order_number) VALUES(100,'#1234'),(101,'#manual')");
await query("INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number) VALUES('old-1234',100,'#1234')");
await query("INSERT INTO active_order_locks(order_number,dispatch_id,courier_id) VALUES('#1234',100,2),('#manual',101,3)");
await test('migração preserva vínculos, data iFood e fallback manual; pode repetir', async () => {
  await db.exec(migration); await db.exec(migration);
  const rows = (await query('SELECT order_date::text AS day FROM active_order_locks')).rows;
  assert.equal(rows.length,2); assert.ok(rows.every(x=>x.day===yesterday));
  assert.equal((await query('SELECT * FROM ifood_dispatch_links')).rows.length,1);
});
await test('dia de São Paulo muda à meia-noite local, não à meia-noite UTC', async () => {
  assert.equal(context.orderDateSP('2026-09-11T02:59:59Z'),'2026-09-10');
  assert.equal(context.orderDateSP('2026-09-11T03:00:00Z'),'2026-09-11');
  assert.equal(context.orderDateSP(null),null);
});
await add('new-1234','1234');
await test('atualização tardia e trava antiga não bloqueiam o número de hoje', async () => {
  await query("UPDATE ifood_orders SET last_event_at=NOW()+INTERVAL '1 day' WHERE order_id='old-1234'");
  const result = await inspect('1234'); assert.equal(result.accepted[0].order_id,'new-1234');
  assert.equal(fetched.at(-1),'new-1234');
  const conflicts = await context.inspectOrders(['#1234'],result.accepted);
  assert.equal(conflicts.active.length,0); assert.equal(conflicts.recent.length,0);
  assert.ok((await context.getAvailableIfoodOrders('1234')).some(x=>x.orderId==='new-1234'));
  await create(4,result.accepted);
  assert.equal((await query("SELECT * FROM active_order_locks WHERE order_number='#1234'")).rows.length,2);
});
await test('mesmo dia bloqueia saída duplicada; rollback preserva histórico', async () => {
  const result = await inspect('1234'); assert.equal(result.blocked[0].code,'IFOOD_ORDER_ALREADY_LINKED');
  assert.equal((await context.inspectOrders(['#1234'])).active.length,1);
  await add('same-day-1234','1234');
  await assert.rejects(create(5,[{order_id:'same-day-1234',order_number:'#1234'}]), e=>e.code==='23505');
  assert.equal((await query('SELECT * FROM dispatches WHERE courier_id=5')).rows.length,0);
  assert.equal((await query("SELECT * FROM ifood_dispatch_links WHERE ifood_order_id='same-day-1234'")).rows.length,0);
});
await test('UUID segue único após chegada e mesmo se a data for alterada', async () => {
  const id=(await query("SELECT dispatch_id FROM ifood_dispatch_links WHERE ifood_order_id='new-1234'")).rows[0].dispatch_id;
  await finish(id);
  await query("UPDATE ifood_orders SET order_created_at=$1::timestamptz WHERE order_id='new-1234'",[new Date(+noon+86400000).toISOString()]);
  await assert.rejects(create(5,[{order_id:'new-1234',order_number:'#1234'}]), e=>e.code==='IFOOD_ORDER_ALREADY_LINKED');
  await query("UPDATE ifood_orders SET order_created_at=$1::timestamptz WHERE order_id='new-1234'",[noon.toISOString()]);
  assert.equal((await query("SELECT * FROM ifood_dispatch_links WHERE ifood_order_id='new-1234'")).rows.length,1);
});
await test('número antigo sozinho nunca é escolhido como pedido de hoje', async () => {
  await add('only-old','2222',yesterday);
  assert.equal((await inspect('2222')).blocked[0].code,'IFOOD_ORDER_DAY_NOT_FOUND');
  assert.equal((await context.getAvailableIfoodOrders('2222')).length,0);
});
await test('dois candidatos ativos no mesmo dia e outra loja continuam bloqueados', async () => {
  await add('amb-a','3333'); await add('amb-b','3333');
  assert.equal((await inspect('3333')).blocked[0].code,'IFOOD_ORDER_AMBIGUOUS');
  await add('foreign','4444',today,'CONFIRMED','other');
  assert.equal((await inspect('4444')).blocked[0].code,'IFOOD_MERCHANT_MISMATCH');
  assert.equal((await context.getAvailableIfoodOrders('4444')).length,0);
});
await test('recuperação do Admin usa data informada e não reenvia dispatch', async () => {
  await add('recovery-old','5555',yesterday,'DISPATCHED');
  await add('recovery-today','5555',today,'DISPATCHED');
  const old=(await inspect('5555',{recovery:true,referenceAt:yesterday+'T23:55:00-03:00'})).accepted;
  await create(6,old,{recovery:true,departedAt:yesterday+'T23:55:00-03:00'});
  const req={session:{user:{id:1}},body:{courier_id:7,order_numbers:['5555'],reason:'Saída pelo gestor',departed_at:today+'T11:00:00-03:00'}};
  const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await context.addRouteOrder(req,res,true); assert.equal(res.code,201,JSON.stringify(res.body));
  assert.equal((await query("SELECT dispatch_id FROM ifood_dispatch_links WHERE ifood_order_id='recovery-today'")).rows[0].dispatch_id,res.body.dispatch.id);
  assert.equal((await query("SELECT * FROM ifood_dispatch_jobs WHERE ifood_order_id LIKE 'recovery-%'")).rows.length,0);
});
await test('adicionar à rota após meia-noite usa dia do pedido e mantém horário da saída', async () => {
  await add('route-old','6666',yesterday);
  const old=(await inspect('6666',{referenceAt:yesterday+'T23:00:00-03:00'})).accepted;
  const route=(await create(8,old,{departedAt:yesterday+'T23:55:00-03:00'})).dispatch;
  await add('append-old','7777',yesterday);
  await create(9,(await inspect('7777',{referenceAt:yesterday+'T23:00:00-03:00'})).accepted);
  await add('append-today','7777');
  const req={session:{user:{id:8}},body:{order_numbers:['7777']}};
  const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await context.addRouteOrder(req,res,false); assert.equal(res.code,201,JSON.stringify(res.body));
  assert.equal(res.body.dispatch.id,route.id); assert.equal(+new Date(res.body.dispatch.departed_at),+new Date(route.departed_at));
  assert.equal((await query("SELECT order_date::text AS day FROM active_order_locks WHERE dispatch_id=$1 AND order_number='#7777'",[route.id])).rows[0].day,today);
});
await test('histórico de ontem não gera aviso de 12h; repetição hoje ainda avisa', async () => {
  const old=await context.createDispatchTransaction({actorUserId:1,courierId:10,orders:['#history'],source:'ADMIN',departedAt:yesterday+'T23:50:00-03:00'});
  await finish(old.dispatch.id); clock=+new Date(today+'T00:10:00-03:00');
  assert.equal((await context.inspectOrders(['#history'])).recent.length,0);
  const current=await context.createDispatchTransaction({actorUserId:1,courierId:10,orders:['#history'],source:'ADMIN'});
  await finish(current.dispatch.id);
  assert.equal((await context.inspectOrders(['#history'])).recent.length,1); clock=+noon;
});
await test('duas tentativas simultâneas têm um único vínculo e job', async () => {
  await add('race','8888'); const links=(await inspect('8888')).accepted;
  const results=await Promise.allSettled([create(11,links),create(12,links)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await query("SELECT * FROM ifood_dispatch_links WHERE ifood_order_id='race'")).rows.length,1);
  assert.equal((await query("SELECT * FROM ifood_dispatch_jobs WHERE ifood_order_id='race'")).rows.length,1);
});
await test('inicialização recompõe travas por dia e pode repetir sem duplicá-las', async () => {
  const start=source.indexOf('INSERT INTO active_order_locks(order_number,dispatch_id,courier_id,order_date)\nSELECT');
  const sql=source.slice(start,source.indexOf('`);',start));
  await db.exec(sql); const before=(await query('SELECT COUNT(*)::int AS n FROM active_order_locks')).rows[0].n;
  await db.exec(sql); assert.equal((await query('SELECT COUNT(*)::int AS n FROM active_order_locks')).rows[0].n,before);
});
await db.close(); console.log(JSON.stringify({result:'PASS',tests:count}));
