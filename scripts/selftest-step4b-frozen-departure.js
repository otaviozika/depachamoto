import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql=fs.readFileSync(new URL('../db/migrations/step4b_harden_dispatch_shift_freeze.sql',import.meta.url),'utf8');
assert.match(sql,/NEW\.departed_at IS DISTINCT FROM OLD\.departed_at/,'departed_at must be immutable after shift freeze');
assert.match(sql,/NEW\.operational_date := COALESCE\(NEW\.operational_date, local_ts::date\)/,'explicit recovery operational date must be preserved');
assert.match(sql,/NEW\.shift_code := COALESCE\(NEW\.shift_code, derived_shift\)/,'explicit recovery shift must be preserved');
console.log(JSON.stringify({result:'PASS',feature:'frozen_dispatch_departure'}));