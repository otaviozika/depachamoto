import assert from "node:assert/strict";
import { anotaAiPageIdFromTokens, createAnotaAiClient, normalizeAnotaAiOrder } from "../lib/anotaai.js";

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

const linkedToken = jwt({ idpartner: "partner-1", idpage: "page-123" });
const calls = [];
let oauthCount = 0;
let listCount = 0;
const fetchImpl = async (url, options = {}) => {
  const entry = { url: String(url), options };
  calls.push(entry);
  if (entry.url.endsWith("/oauth-client/token")) {
    oauthCount += 1;
    const form = new URLSearchParams(options.body);
    assert.equal(options.method, "POST");
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), "client-id");
    assert.equal(form.get("client_secret"), "client-secret");
    return new Response(JSON.stringify({ accessToken: `access-${oauthCount}`, expiresIn: 3600 }), { status: 200 });
  }
  if (entry.url.includes("/ping/list")) {
    listCount += 1;
    assert.equal(options.headers["x-page-id"], "page-123");
    assert.match(options.headers["User-Agent"], /^DespacheFull\/3\.6\.1/);
    if (listCount === 1) return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
    return new Response(JSON.stringify({ success: true, info: { docs: [{ _id: "order-1", check: 1 }], count: 1, limit: 100, currentpage: 1 } }), { status: 200 });
  }
  if (entry.url.includes("/ping/get/order-1")) {
    return new Response(JSON.stringify({ success: true, info: { _id: "order-1", check: 2, number: "51", customer: { name: "Cliente" }, createdAt: "2026-09-17T12:00:00.000Z" } }), { status: 200 });
  }
  if (entry.url.endsWith("/integration-partner/linkpage-by-token")) {
    const body = JSON.parse(options.body);
    assert.equal(body.pageToken, "store-key");
    assert.equal(body.active, true);
    return new Response(JSON.stringify({ success: true, message: "linked", info: { token: linkedToken } }), { status: 200 });
  }
  throw new Error(`Unexpected request: ${entry.url}`);
};

const client = createAnotaAiClient({
  clientId: "client-id",
  clientSecret: "client-secret",
  userAgent: "DespacheFull/3.6.1 (test; Node.js/22)",
  fetchImpl
});

assert.equal(client.configured(), true);
const listed = await client.listOrders("page-123");
assert.equal(listed.info.docs[0]._id, "order-1");
assert.equal(oauthCount, 2, "401 must renew the OAuth token exactly once");

const details = await client.getOrder("page-123", "order-1");
const normalized = normalizeAnotaAiOrder(details.info);
assert.deepEqual({
  id: normalized.orderId,
  display: normalized.displayId,
  status: normalized.status,
  customer: normalized.customerName
}, { id: "order-1", display: "51", status: "READY", customer: "Cliente" });

const linked = await client.linkPage("store-key");
assert.equal(linked.pageId, "page-123");
assert.equal(anotaAiPageIdFromTokens(linkedToken), "page-123");
assert.equal(calls.some(call => String(call.options?.headers?.Authorization || "").includes("client-secret")), false);

console.log("selftest-anotaai-client: OK");
