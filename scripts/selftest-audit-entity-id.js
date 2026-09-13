import assert from 'node:assert/strict';
import { normalizeAuditEntityId } from '../lib/audit-entity.js';

const numeric = normalizeAuditEntityId(123, { ok: true });
assert.equal(numeric.entity_id, '123');
assert.deepEqual(numeric.details, { ok: true });

const uuid = '7d64359d-a083-47c6-b7ae-fb45d1ca0239';
const external = normalizeAuditEntityId(uuid, { display_id: '5722' });
assert.equal(external.entity_id, null);
assert.equal(external.details.entity_external_id, uuid);
assert.equal(external.details.display_id, '5722');

const empty = normalizeAuditEntityId(null, { ok: true });
assert.equal(empty.entity_id, null);
assert.deepEqual(empty.details, { ok: true });

console.log(JSON.stringify({ result: 'PASS', feature: 'audit_entity_id_normalization', cases: 3 }));
