import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
assert.equal(pkg.engines?.node, '22.x');
assert.equal(lock.packages?.['']?.engines?.node, '22.x');
console.log(JSON.stringify({ result: 'PASS', feature: 'node_runtime_pin', node: '22.x' }));
