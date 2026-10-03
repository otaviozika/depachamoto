import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { normalizeAnotaAiOrder } from '../lib/anotaai.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(source.match(/CREATE TABLE IF NOT EXISTS anotaai_orders \([\s\S]*?\n\);/)[0]);
await db.exec(source.match(/CREATE TABLE IF NOT EXISTS anotaai_sync_state \([\s\S]*?\n\);/)[0]);
const full = {
  _id: 'address-test', shortReference: '1234', check: 1, type: 'DELIVERY',
  createdAt: '2026-10-01T18:00:00Z', updatedAt: '2026-10-01T18:01:00Z',
  customer: { name: 'Cliente teste' }, items: [{ name: 'Hambúrguer' }],
  deliveryAddress: { streetName: 'Rua de Teste', streetNumber: '100',
    city: 'São Caetano do Sul', state: 'SP', coordinates: { latitude: -23.6, longitude: -46.5 } }
};
const summary = { _id: full._id, check: 1, updatedAt: full.updatedAt, salesChannel: 'anotaai' };
let fetched = 0;
const context = vm.createContext({
  console, Date, normalizeAnotaAiOrder,
  pool: { query: (sql, params) => db.query(sql, params) },
  anotaAiClient: {
    listOrders: async () => ({ info: { docs: [summary], count: 1, limit: 100 } }),
    getOrder: async () => { fetched++; return full; }
  },
  createNotification: async () => {}, anotaAiSafeError: error => error.message
});
function include(start, end) {
  const at = source.indexOf(start), to = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at);
  vm.runInContext(source.slice(at, to), context);
}
include('function validAnotaAiDate(', 'async function syncAnotaAiOnce(');
const row = async () => (await db.query('SELECT * FROM anotaai_orders WHERE order_id=$1', [full._id])).rows[0];
try {
  await context.upsertAnotaAiOrder('test-page', normalizeAnotaAiOrder(full));
  // Repeated unchanged polls must preserve details without fetching the same order again.
  await context.syncAnotaAiPage('test-page');
  await context.syncAnotaAiPage('test-page');
  assert.equal(fetched, 0);
  assert.deepEqual((await row()).payload.deliveryAddress, full.deliveryAddress);
  assert.deepEqual((await row()).payload.items, full.items);
  assert.equal((await row()).customer_name, 'Cliente teste');

  // A new full payload replaces the old address; do not merge stale street numbers/pins.
  const changed = { ...full, check: 2, deliveryAddress: { ...full.deliveryAddress, streetNumber: '222', coordinates: null } };
  await context.upsertAnotaAiOrder('test-page', normalizeAnotaAiOrder(changed));
  assert.deepEqual((await row()).payload.deliveryAddress, changed.deliveryAddress);
  assert.equal((await row()).status, 'READY');

  // Repair the summary-only payload produced by old deployments, then stop refetching.
  await db.query('UPDATE anotaai_orders SET payload=$1::jsonb,status_code=1 WHERE order_id=$2', [JSON.stringify(summary), full._id]);
  await context.syncAnotaAiPage('test-page');
  assert.equal(fetched, 1);
  assert.deepEqual((await row()).payload.deliveryAddress, full.deliveryAddress);
  await context.syncAnotaAiPage('test-page');
  assert.equal(fetched, 1);

  // Historical concluded orders are not rehydrated by every automatic poll.
  await db.query('UPDATE anotaai_orders SET payload=$1::jsonb,status_code=3 WHERE order_id=$2', [JSON.stringify({ ...summary, check: 3 }), full._id]);
  summary.check = 3;
  await context.syncAnotaAiPage('test-page');
  assert.equal(fetched, 1);
  console.log('PASS Anota AI address: PostgreSQL summary preservation, updated addresses, one-time active recovery and no historical refetch');
} finally {
  await db.close();
}
