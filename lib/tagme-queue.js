import crypto from "node:crypto";

export function authorizedTagme(req, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const provided = req.get("authorization") || "";
  const expected = "Bearer " + secret;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}

export function parseTagmeCount(payload) {
  // Contract proposed for Tagme homologation; no personal data is retained.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { event_id, occurred_at, waiting_groups } = payload;
  if (typeof event_id !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(event_id)) return null;
  if (typeof occurred_at !== "string" || !/^\d{4}-\d\d-\d\dT/.test(occurred_at)) return null;
  const time = Date.parse(occurred_at);
  if (!Number.isFinite(time) || Math.abs(Date.now()-time)>24*3600*1000) return null;
  if (!Number.isSafeInteger(waiting_groups) || waiting_groups<0 || waiting_groups>1000) return null;
  return {eventId:event_id, occurredAt:new Date(time).toISOString(), count:waiting_groups};
}
