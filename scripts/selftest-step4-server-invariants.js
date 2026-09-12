import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
assert.match(source,/active_order_locks\(order_number,dispatch_id,courier_id,order_date\)/,'date-scoped order lock must remain');
assert.match(source,/async function assignCompletedIfoodOrder/,'completed iFood assignment must remain');
assert.match(source,/'RELEASED','COMPLETED','COMPLETED_ORDER_ASSIGNED'/,'completed assignment must not reopen delivery');
assert.match(source,/const effectiveDeparture = existingRoute\?\.departed_at \|\| departedAt \|\| new Date\(\)\.toISOString\(\)/,'append/recovery keeps effective departure source');
console.log(JSON.stringify({result:'PASS',feature:'step4_server_invariants'}));
