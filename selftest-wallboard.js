import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const wallboard = server.match(/app\.get\("\/api\/admin\/wallboard"[\s\S]*?\n\}\)\);/)?.[0] || "";

const checks = {
  version: pkg.version === "3.5.6" && server.includes('const VERSION = "3.5.6";'),
  wallboard_delivery_only: wallboard.includes("UPPER(COALESCE(o.order_type,''))='DELIVERY'"),
  takeout_comment: wallboard.includes("TAKEOUT/DINE_IN continuam preservados no histórico/iFood"),
  cancelled_still_hidden: wallboard.includes("operational_status !== 'CANCELLED'"),
  fifo_preserved: html.includes("kdsSortTime(a,'PREPARING')-kdsSortTime(b,'PREPARING')"),
  no_takeout_column: !html.includes("PEDIDOS DE RETIRADA"),
  courier_backend_delivery_guard: server.includes('String(data.order_type || "").toUpperCase() !== "DELIVERY"'),
  test_dispatch_delivery_guard: server.includes('return res.status(409).json({ error: "Pedido não é DELIVERY." });'),
  pwa_cache: sw.includes("despachefull-v3.5.6-takeout-filter")
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", version: "3.5.6", checks }, null, 2));
