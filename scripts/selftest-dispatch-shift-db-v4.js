import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql=fs.readFileSync(new URL('../db/migrations/step4_freeze_dispatch_operational_shift.sql',import.meta.url),'utf8');
assert.match(sql,/operational_date date/); assert.match(sql,/shift_code text/);
assert.match(sql,/NEW\.operational_date:=local_ts::date/); assert.match(sql,/NEW\.shift_code:=COALESCE\(NEW\.shift_code,derived_shift\)/);
assert.match(sql,/OLD\.shift_code IS NOT NULL/); assert.match(sql,/immutable once frozen/);
assert.match(sql,/dow=7 AND mins BETWEEN 1080 AND 1410 THEN derived_shift:='DINNER'/); assert.match(sql,/outside an operational shift/);
console.log(JSON.stringify({result:'PASS',feature:'dispatch_shift_db_freeze'}));
