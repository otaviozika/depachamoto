import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const checks = {
  combined_lookup: server.includes('/api/courier/orders/lookup'),
  both_platforms_inspected:
    server.includes('inspectIfoodOrdersForDeparture(orders)') &&
    server.includes('inspectAnotaAiOrdersForDeparture(orders)'),
  mandatory_collision_choice:
    server.includes('code: "ORDER_PLATFORM_REQUIRED"') &&
    server.includes('ambiguities: platformResolution.ambiguities'),
  explicit_anota_link:
    server.includes('CREATE TABLE IF NOT EXISTS anotaai_dispatch_links') &&
    server.includes('INSERT INTO anotaai_dispatch_links'),
  platform_scoped_active_lock:
    server.includes('PRIMARY KEY(order_number,order_date,platform)') &&
    server.includes('active_order_locks(order_number,dispatch_id,courier_id,order_date,platform)'),
  ui_uses_combined_lookup: html.includes('/api/courier/orders/lookup?order='),
  ui_requires_platform_validation: html.includes('allCourierOrdersPlatformValidated'),
  ui_renders_choice:
    html.includes('Pedido encontrado em mais de uma plataforma.') &&
    html.includes('applyOrderPlatformChoice'),
  payload_sends_selection: html.includes('platform_selections:getOrderPlatformSelections()'),
  ifood_code_flow_preserved: html.includes('/verify-delivery'),
  anota_no_code_flow_preserved: html.includes('/confirm-delivery'),
  pwa_cache_refreshed: html.includes("serviceWorker.register('/service-worker.js')") &&
    sw.includes('admin-order-transfer-v1')
};

for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `FAIL: ${name}`);
console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
