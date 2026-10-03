import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { normalizeAnotaAiOrder } from '../lib/anotaai.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(source.split('await pool.query(`')[1].split('`);')[0]);
const calls = [], deferred = [], remote = new Map(), failures = new Map();
const beforeResponses = new Map();
const notifications = new Map();
const query = async (sql, params = []) => {
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
async function change(action, id) {
  calls.push({ action, id });
  if (beforeResponses.has(id)) await beforeResponses.get(id)();
  const failure = failures.get(id + ':' + action);
  if (failure === 'before') throw Object.assign(new Error('Plataforma indisponível'), { statusCode: 503 });
  if (action === 'FINALIZE') assert.equal(remote.get(id), 2, 'FINALIZE cannot skip the READY step');
  remote.set(id, action === 'READY' ? 2 : 3);
  if (failure === 'after') throw new TypeError('Resposta perdida depois da mudança');
  return { success: true };
}
let confirm;
const context = vm.createContext({
  Date, console: { warn() {}, error() {} }, normalizeAnotaAiOrder,
  pool: { query }, STAGING_SAFE_MODE: false,
  anotaAiConfigured: () => true, anotaAiSafeError: error => error.message,
  assertExternalMutationAllowed: () => { assert.equal(context.STAGING_SAFE_MODE, false); },
  anotaAiClient: {
    readyOrder: async (_, id) => change('READY', id),
    finalizeOrder: async (_, id) => change('FINALIZE', id),
    getOrder: async (_, id) => ({ _id: id, check: remote.get(id), type: 'DELIVERY' })
  },
  setImmediate: fn => deferred.push(fn), syncAnotaAiOnce: async () => {},
  emitRealtime() {}, auditBestEffort: async () => {},
  createNotification: async value => notifications.set(value.uniqueKey, value),
  touchPresence: async () => {}, maybeAutoMarkDispatchReturning: async () => {},
  auth() {}, courierOnly() {}, asyncRoute: fn => fn,
  app: { post: (_, ...handlers) => { confirm = handlers.at(-1); } }
});
function include(start, end) {
  const at = source.indexOf(start), to = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, start);
  vm.runInContext(source.slice(at, to), context);
}
include('function validAnotaAiDate(', 'function findNestedAnotaAiField(');
include('let anotaAiDispatchWorkerRunning = false;', '\nconst IFOOD_AUTH_URL');
include('function parseJsonPayload(', 'function normalizeDeliveryCode(');
include('async function getCourierAnotaAiDeliveries(', 'async function acknowledgeIfoodEvents(');
include('async function getDispatchProgressMap(', 'function decorateOperationalDispatches(');
include('app.post("/api/courier/anotaai/orders/:orderId/confirm-delivery"', 'app.get("/api/courier/ifood/deliveries"');
let sequence = 0, tests = 0;
async function test(name, run) { await run(); tests++; console.log('PASS ' + name); }
async function fixture(check = 1) {
  const n = ++sequence, id = 'stage-' + n;
  await query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Teste',$2,'test','courier')", [n, id]);
  const dispatch = (await query("INSERT INTO dispatches(dispatch_code,order_number,courier_id) VALUES($1,$2,$3) RETURNING id", [id,'#'+n,n])).rows[0];
  await query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status,status_code,order_type) VALUES($1,'test-page',$2,$3,$4,'DELIVERY')", [id,String(n),normalizeAnotaAiOrder({ check }).status,check]);
  await query("INSERT INTO anotaai_dispatch_links(anotaai_order_id,dispatch_id,local_order_number) VALUES($1,$2,$3)", [id,dispatch.id,'#'+n]);
  await query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'anotaai')", [dispatch.id,'#'+n]);
  remote.set(id,check);
  return { id, courier: n, dispatch: dispatch.id };
}
const state = async f => (await query(`SELECT a.status,a.status_code,l.* FROM anotaai_orders a JOIN anotaai_dispatch_links l ON l.anotaai_order_id=a.order_id WHERE a.order_id=$1`, [f.id])).rows[0];
const actions = f => calls.filter(call => call.id === f.id).map(call => call.action);
const due = f => query('UPDATE anotaai_dispatch_links SET next_attempt_at=NOW() WHERE anotaai_order_id=$1', [f.id]);
async function deliver(f, courier = f.courier) {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await confirm({ params: { orderId: f.id }, session: { user: { id: courier } } },response);
  return response;
}
try {
  await test('saída envia READY, permanece em rota e só FINALIZE após confirmar a entrega', async () => {
    const f = await fixture();
    await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f), ['READY']);
    assert.equal((await state(f)).status, 'READY');
    assert.equal((await state(f)).status_code, 2);
    assert.equal((await context.getCourierAnotaAiDeliveries(f.courier)).current.length, 1);
    assert.equal((await context.getDispatchProgressMap([f.dispatch])).get(Number(f.dispatch)).resolved_orders, 0);
    assert.equal((await deliver(f,99999)).code,404);
    assert.equal((await deliver(f)).code,200);
    assert.equal((await state(f)).anotaai_dispatch_status,'PENDING');
    assert.equal((await state(f)).attempts,0);
    assert.equal((await state(f)).retry_cycle,2);
    await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f), ['READY','FINALIZE']);
    assert.equal((await state(f)).status, 'FINISHED');
    assert.equal((await state(f)).status_code,3);
    assert.equal((await state(f)).anotaai_dispatch_status,'SENT');
    assert.equal((await context.getCourierAnotaAiDeliveries(f.courier)).completed.length,1);
    assert.equal((await context.getDispatchProgressMap([f.dispatch])).get(Number(f.dispatch)).resolved_orders,1);
    await deliver(f); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f), ['READY','FINALIZE']);
  });
  await test('confirmação antecipada conserva a sequência READY → FINALIZE', async () => {
    const f = await fixture(); await deliver(f);
    await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),['READY']);
    assert.equal((await state(f)).anotaai_dispatch_status,'PENDING');
    assert.equal((await state(f)).retry_cycle,2);
    await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),['READY','FINALIZE']);
  });
  await test('READY já aplicado externamente não duplica o aviso', async () => {
    const f = await fixture(2); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),[]); await deliver(f);
    await context.runAnotaAiDispatchWorkerOnce(); assert.deepEqual(actions(f),['FINALIZE']);
  });
  await test('pedido já finalizado permanece finalizado e não reabre etapas', async () => {
    const f = await fixture(3); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),[]); assert.equal((await state(f)).status_code,3);
  });
  for (const action of ['READY','FINALIZE']) {
    await test(action+' com resposta perdida reconcilia sem duplicar a mudança',async () => {
      const f = await fixture();
      if (action==='FINALIZE') { await context.runAnotaAiDispatchWorkerOnce(); await deliver(f); }
      failures.set(f.id+':'+action,'after');
      await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).anotaai_dispatch_status,'SENT');
      await context.runAnotaAiDispatchWorkerOnce();
      assert.deepEqual(actions(f),action==='READY'?['READY']:['READY','FINALIZE']);
    });
    await test(action+' com falha externa fica pendente e tenta novamente na etapa correta',async () => {
      const f = await fixture();
      if (action==='FINALIZE') { await context.runAnotaAiDispatchWorkerOnce(); await deliver(f); }
      failures.set(f.id+':'+action,'before');
      await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).anotaai_dispatch_status,'FAILED');
      assert.equal((await state(f)).status,action==='READY'?'PRODUCTION':'READY');
      failures.delete(f.id+':'+action); await due(f);
      await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).anotaai_dispatch_status,'SENT');
      assert.deepEqual(actions(f),action==='READY'?['READY','READY']:['READY','FINALIZE','FINALIZE']);
      if(action==='READY') { await deliver(f); await context.runAnotaAiDispatchWorkerOnce(); }
    });
    await test(action+' respeita limite, DEAD e confirmação repetida não reabre tentativas',async () => {
      const f = await fixture();
      if (action==='FINALIZE') { await context.runAnotaAiDispatchWorkerOnce(); await deliver(f); }
      await query('UPDATE anotaai_dispatch_links SET attempts=7 WHERE anotaai_order_id=$1',[f.id]);
      failures.set(f.id+':'+action,'before');
      await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).attempts,8);
      assert.equal((await state(f)).anotaai_dispatch_status,'DEAD');
      await deliver(f); await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).attempts,8);
      assert.equal((await state(f)).anotaai_dispatch_status,'DEAD');
      assert.equal(actions(f).filter(value=>value===action).length,1);
      // Same admin replay contract as production: keep the completed READY marker.
      await query("UPDATE anotaai_dispatch_links SET anotaai_dispatch_status='FAILED',attempts=0,retry_cycle=retry_cycle+1,next_attempt_at=NOW() WHERE anotaai_order_id=$1 AND anotaai_dispatch_status='DEAD'",[f.id]);
      failures.delete(f.id+':'+action); await context.runAnotaAiDispatchWorkerOnce();
      assert.equal(actions(f).at(-1),action);
      if(action==='READY') await context.runAnotaAiDispatchWorkerOnce();
    });
  }
  await test('dois cliques simultâneos geram uma confirmação e uma finalização',async () => {
    const f = await fixture(); await context.runAnotaAiDispatchWorkerOnce();
    await Promise.all([deliver(f),deliver(f)]);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM anotaai_delivery_confirmations WHERE anotaai_order_id=$1',[f.id])).rows[0].n,1);
    assert.equal((await state(f)).retry_cycle,2);
    await context.runAnotaAiDispatchWorkerOnce(); assert.deepEqual(actions(f),['READY','FINALIZE']);
  });
  await test('reinício depois de salvar a confirmação recupera a finalização durável',async () => {
    const f = await fixture(); await context.runAnotaAiDispatchWorkerOnce();
    await query('INSERT INTO anotaai_delivery_confirmations(anotaai_order_id,dispatch_id,courier_id) VALUES($1,$2,$3)',[f.id,f.dispatch,f.courier]);
    await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),['READY','FINALIZE']);
  });
  await test('poll atrasado de produção não perde a confirmação nem pula READY',async () => {
    const f = await fixture(); await context.runAnotaAiDispatchWorkerOnce();
    await query("UPDATE anotaai_orders SET status='PRODUCTION',status_code=1 WHERE order_id=$1",[f.id]);
    await deliver(f); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),['READY','FINALIZE']);
    assert.equal((await state(f)).status,'FINISHED');
  });
  await test('poll atrasado após finalizar não reabre a finalização já aplicada',async () => {
    const f = await fixture(); await context.runAnotaAiDispatchWorkerOnce();
    await deliver(f); await context.runAnotaAiDispatchWorkerOnce();
    await query("UPDATE anotaai_orders SET status='READY',status_code=2 WHERE order_id=$1",[f.id]);
    await deliver(f); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),['READY','FINALIZE']);
    assert.equal((await state(f)).anotaai_dispatch_status,'SENT');
  });
  for (const failed of [false,true]) {
    await test('resposta '+(failed?'de falha':'de sucesso')+' de execução antiga não sobrescreve uma nova tentativa',async () => {
      const f = await fixture();
      beforeResponses.set(f.id,async () => {
        await query("UPDATE anotaai_dispatch_links SET attempts=attempts+1,processing_started_at=processing_started_at+INTERVAL '1 second' WHERE anotaai_order_id=$1",[f.id]);
      });
      if(failed) failures.set(f.id+':READY','before');
      await context.runAnotaAiDispatchWorkerOnce();
      assert.equal((await state(f)).anotaai_dispatch_status,'PROCESSING');
      assert.equal((await state(f)).attempts,2);
      assert.equal((await state(f)).status,'PRODUCTION');
      beforeResponses.delete(f.id); failures.delete(f.id+':READY');
      // Finish this fixture as the current owner so later scenarios remain isolated.
      await query("UPDATE anotaai_dispatch_links SET anotaai_dispatch_status='SENT',processing_started_at=NULL WHERE anotaai_order_id=$1",[f.id]);
    });
  }
  await test('cancelados não recebem saída ou finalização',async () => {
    const f = await fixture(4); await context.runAnotaAiDispatchWorkerOnce();
    assert.deepEqual(actions(f),[]); assert.equal((await deliver(f)).code,409);
  });
  await test('homologação segura bloqueia ambas as operações externas',async () => {
    const f = await fixture(); const before=calls.length; context.STAGING_SAFE_MODE=true;
    await context.runAnotaAiDispatchWorkerOnce(); assert.equal(calls.length,before);
    assert.equal((await state(f)).attempts,0); context.STAGING_SAFE_MODE=false;
  });
  console.log(JSON.stringify({ result:'PASS', tests, externalNetworkCalls:0 }));
} finally { await db.close(); }
