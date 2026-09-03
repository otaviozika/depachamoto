import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const wallboardEndpoint = server.match(
  /app\.get\("\/api\/admin\/wallboard"[\s\S]*?\n\}\)\);/
)?.[0] || "";

const checks = {
  version:
    pkg.version === "3.5.6" &&
    server.includes('const VERSION = "3.5.6";') &&
    html.includes("<title>DespacheFull 3.5.6</title>"),
  wallboardEndpoint: wallboardEndpoint.length > 0,
  onlyDeliveryInWallboard:
    wallboardEndpoint.includes("UPPER(COALESCE(o.order_type,''))='DELIVERY'"),
  takeoutPreservedOutsideWallboard:
    server.includes("TAKEOUT/DINE_IN continuam preservados no histórico/iFood"),
  deliveryDispatchProtection:
    server.includes("DELIVERY_NOT_MERCHANT") &&
    server.includes("Todos os pedidos da saída precisam estar vinculados ao iFood"),
  fifoPreserved:
    wallboardEndpoint.includes("ORDER BY COALESCE(o.order_created_at,o.last_event_at,o.updated_at) ASC,o.order_id ASC"),
  threeWallboardColumns:
    html.includes("PEDIDOS EM PREPARO") &&
    html.includes("PEDIDOS NA RUA") &&
    html.includes("PEDIDOS CONFIRMADOS"),
  currentPwaCache: sw.includes("despachefull-v3.5.6-")
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", version: "3.5.6", checks }, null, 2));
