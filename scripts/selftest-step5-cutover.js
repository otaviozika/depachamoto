import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

assert.match(server, /BETWEEN \$2::date AND LEAST\(\$3::date,\(\$4::date-1\)\)/, 'legacy period must stop before cutover');
assert.match(server, /BETWEEN GREATEST\(\$2::date,\$4::date\) AND \$3::date/, 'shift-aware period must start at cutover');
assert.match(server, /rows\.unshift\(\.\.\.legacyRows\)/, 'legacy and shift-aware rows must be combined');
assert.match(server, /d\.operational_date AS payment_date,d\.shift_code/, 'post-cutover delivery counting must use frozen operational date + shift');
assert.match(server, /shift_code IS NULL AND payment_date BETWEEN/, 'legacy payment rows must remain isolated from shift rows');

console.log(JSON.stringify({ result: 'PASS', feature: 'step5_cutover_hybrid_period', checks: 5 }));
