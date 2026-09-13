export function normalizeAuditEntityId(entityId, details = {}) {
  if (entityId === null || entityId === undefined || entityId === '') {
    return { entity_id: null, details: details || {} };
  }

  const raw = String(entityId).trim();
  if (/^\d+$/.test(raw)) {
    return { entity_id: raw, details: details || {} };
  }

  return {
    entity_id: null,
    details: { ...(details || {}), entity_external_id: raw }
  };
}
