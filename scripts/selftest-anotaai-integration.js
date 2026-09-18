import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const env = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");

assert.match(server, /CREATE TABLE IF NOT EXISTS anotaai_pages/);
assert.match(server, /CREATE TABLE IF NOT EXISTS anotaai_orders/);
assert.match(server, /CREATE TABLE IF NOT EXISTS anotaai_sync_state/);
assert.match(server, /app\.post\("\/api\/admin\/anotaai\/link-page", auth, adminOnly/);
assert.match(server, /app\.post\("\/api\/admin\/anotaai\/sync-now", auth, adminOnly/);
assert.match(server, /syncAnotaAiOnce\(\{ reason: "automatic_30s" \}\)/);
assert.match(server, /if \(!anotaAiAutoEnabled\(\) \|\| !anotaAiConfigured\(\)\) return/);
assert.match(html, /<section id="anotaai" class="page">/);
assert.match(html, /type="password"[^>]+id="anotaAiPageToken"|id="anotaAiPageToken"[^>]+type="password"/);
assert.match(html, /ifood:\{label:'Integrações'.*\['anotaai','Anota AI'\]/);
assert.match(env, /ANOTAAI_ENABLED=false/);
assert.match(env, /ANOTAAI_CLIENT_ID=\s*$/m);
assert.match(env, /ANOTAAI_CLIENT_SECRET=\s*$/m);
assert.doesNotMatch(server + html + env, /client_secret\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/i);

console.log("selftest-anotaai-integration: OK");
