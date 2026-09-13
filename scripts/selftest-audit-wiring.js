import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /import \{ normalizeAuditEntityId \} from "\.\/lib\/audit-entity\.js";/);
assert.match(server, /const normalized = normalizeAuditEntityId\(entityId, details\);/);
assert.match(server, /normalized\.entity_id/);
assert.match(server, /JSON\.stringify\(normalized\.details\)/);
console.log(JSON.stringify({ result: 'PASS', feature: 'audit_normalization_wiring', checks: 4 }));
