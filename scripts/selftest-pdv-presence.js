import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const checks = [
  ['version 3.5.1', pkg.version === '3.5.1' && /const VERSION = "3\.5\.1"/.test(server)],
  ['polling endpoint exists', /events:polling/.test(server)],
  ['merchant filter exists', /x-polling-merchants/.test(server)],
  ['automatic polling remains 30s', /30 \* 1000/.test(server)],
  ['PDV polling does not send excludeHeartbeat=true', !/url\.searchParams\.set\("excludeHeartbeat",\s*"true"\)/.test(server)],
  ['PDV rationale documented', /PDV\/Food: NÃO usar excludeHeartbeat/.test(server)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
