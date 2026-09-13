from pathlib import Path

# server.js: wire safe audit entity handling.
p = Path('server.js')
s = p.read_text()
old_import = 'import { calculateShiftPayment, defaultShiftPaymentRule } from "./lib/payment-shifts.js";'
new_import = old_import + '\nimport { normalizeAuditEntityId } from "./lib/audit-entity.js";'
assert old_import in s
assert 'normalizeAuditEntityId } from "./lib/audit-entity.js"' not in s
s = s.replace(old_import, new_import, 1)

old_audit = '''async function audit(userId, action, entity, entityId, details = {}) {
  await pool.query(
    "INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [userId || null, action, entity, entityId || null, JSON.stringify(details)]
  );
}'''
new_audit = '''async function audit(userId, action, entity, entityId, details = {}) {
  const normalized = normalizeAuditEntityId(entityId, details);
  await pool.query(
    "INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [userId || null, action, entity, normalized.entity_id, JSON.stringify(normalized.details)]
  );
}'''
assert old_audit in s
s = s.replace(old_audit, new_audit, 1)
p.write_text(s)

# Keep CI and Render on the same supported runtime.
p = Path('package.json')
s = p.read_text()
assert '"node": ">=20"' in s
s = s.replace('"node": ">=20"', '"node": "22.x"', 1)
p.write_text(s)

p = Path('package-lock.json')
s = p.read_text()
assert '"node": ">=20"' in s
s = s.replace('"node": ">=20"', '"node": "22.x"', 1)
p.write_text(s)

print('hotfix-step5-final.py: source hardening applied')
