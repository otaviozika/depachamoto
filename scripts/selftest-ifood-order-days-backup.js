import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const sql = fs.readFileSync(new URL('./backup-ifood-order-days.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const schema = source.split('await pool.query(`')[1].split('`);')[0];
const migration = schema.slice(schema.indexOf('-- Preserve existing locks'), schema.indexOf('CREATE TABLE IF NOT EXISTS ifood_dispatch_jobs'));
const db = new PGlite();
try {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await db.exec(schema.replace(migration, ''));
  await db.exec(`INSERT INTO users(id,name,username,password_hash,role)
    VALUES(1,'Test','test','test','courier');
    INSERT INTO dispatches(id,dispatch_code,order_number,courier_id,departed_at)
    VALUES(1,'test','#1234',1,'2026-09-11T02:30:00Z');
    INSERT INTO active_order_locks(order_number,dispatch_id,courier_id)
    VALUES('#1234',1,1);`);
  const original = (await db.query('TABLE public.active_order_locks')).rows;
  await db.exec(sql);
  assert.deepEqual((await db.query('TABLE public.active_order_locks')).rows, original);
  assert.deepEqual((await db.query('TABLE despachefull_pre_ifood_days.locks')).rows, original);
  assert.equal((await db.query('SELECT lock_count::int AS n FROM despachefull_pre_ifood_days.info')).rows[0].n, 1);
  console.log('PASS snapshot copies all locks and leaves production tables intact');

  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('TABLE despachefull_pre_ifood_days.locks'), e => e.code === '42501');
    await db.exec('RESET ROLE');
  }
  const rls = (await db.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace='despachefull_pre_ifood_days'::regnamespace AND relkind='r'")).rows;
  assert.equal(rls.length, 2);
  assert.ok(rls.every(row => row.relrowsecurity));
  console.log('PASS API roles cannot access snapshot; RLS enabled on both tables');

  await assert.rejects(db.exec(sql), e => e.code === '42P06');
  await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('TABLE despachefull_pre_ifood_days.locks')).rows, original);
  console.log('PASS repeat attempt preserves the original snapshot');

  await db.exec(migration);
  assert.deepEqual((await db.query('TABLE despachefull_pre_ifood_days.locks')).rows, original);
  assert.equal((await db.query('SELECT order_date::text AS day FROM active_order_locks')).rows[0].day, '2026-09-10');
  await db.exec('DELETE FROM dispatches WHERE id=1');
  assert.equal((await db.query('TABLE public.active_order_locks')).rows.length, 0);
  assert.deepEqual((await db.query('TABLE despachefull_pre_ifood_days.locks')).rows, original);
  console.log('PASS migration and subsequent cascading deletes cannot change snapshot');

  // Recovery exercise in isolation only. Never copy stale locks over a live route.
  await db.exec(`CREATE SCHEMA recovery_test;
    CREATE TABLE recovery_test.locks (LIKE despachefull_pre_ifood_days.locks INCLUDING ALL);
    INSERT INTO recovery_test.locks SELECT * FROM despachefull_pre_ifood_days.locks;
    ALTER TABLE recovery_test.locks ADD PRIMARY KEY(order_number);`);
  assert.deepEqual((await db.query('TABLE recovery_test.locks')).rows, original);
  console.log('PASS original lock values recover into an isolated table');

  await db.exec('DROP SCHEMA despachefull_pre_ifood_days CASCADE');
  await assert.rejects(db.exec(sql), /Esquema diferente/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regnamespace('despachefull_pre_ifood_days') AS ns")).rows[0].ns, null);
  console.log('PASS unexpected schema aborts without leaving partial snapshot');
} finally {
  await db.close();
}
