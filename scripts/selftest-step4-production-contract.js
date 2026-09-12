import assert from 'node:assert/strict';
import { operationalShiftAt } from '../lib/operational-shift.js';
const sp=x=>new Date(`${x}-03:00`);
assert.equal(operationalShiftAt(sp('2026-09-18T12:35:00'))?.shift_code,'LUNCH');
assert.equal(operationalShiftAt(sp('2026-09-18T19:00:00'))?.shift_code,'DINNER');
assert.equal(operationalShiftAt(sp('2026-09-20T12:00:00')),null);
assert.equal(operationalShiftAt(sp('2026-09-18T16:00:00')),null);
console.log(JSON.stringify({result:'PASS',feature:'step4_production_contract'}));
