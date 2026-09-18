import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = {
  version: server.includes('const VERSION = "3.6.1";'),
  table: server.includes("CREATE TABLE IF NOT EXISTS ifood_delivery_confirmations"),
  courierListEndpoint: server.includes('/api/courier/ifood/deliveries'),
  verifyEndpoint: server.includes('/api/courier/ifood/orders/:orderId/verify-delivery'),
  officialOrderEndpoint: server.includes('/verifyDeliveryCode'),
  ownershipCheck: server.includes("AND d.courier_id=$2"),
  merchantDeliveryCheck: server.includes('DELIVERY_NOT_MERCHANT'),
  codeFormat: server.includes("/^\\d{4,8}$/"),
  noRawCodeInAudit: !server.includes("delivery_code: deliveryCode") && !server.includes("code: deliveryCode,"),
  concurrencyClaim: server.includes("status='PROCESSING'") && server.includes("processing_started_at"),
  rateLimit: server.includes("DELIVERY_CODE_RATE_LIMIT"),
  concludedEventSync: server.includes("SET status='CONCLUDED'"),
  courierCard: html.includes('id="courierDeliveriesCard"'),
  confirmationModal: html.includes('id="deliveryConfirmModal"'),
  courierOnlyOwnOrders: html.includes("Rota e pedidos") && html.includes("Entregas e confirmações"),
  successText: html.includes("Confirmar entrega"),
  platformColumn: server.includes("ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'manual'"),
  platformLookupEndpoint: server.includes('/api/courier/orders/lookup'),
  platformChoiceRequired: server.includes('code: "ORDER_PLATFORM_REQUIRED"'),
  uiPlatformChoice: html.includes("renderPlatformChoice") && html.includes("getOrderPlatformSelections"),
  anotaDispatchLinks: server.includes("CREATE TABLE IF NOT EXISTS anotaai_dispatch_links"),
  anotaDeliveryTable: server.includes("CREATE TABLE IF NOT EXISTS anotaai_delivery_confirmations"),
  anotaDeliveryEndpoint: server.includes('/api/courier/anotaai/orders/:orderId/confirm-delivery'),
  anotaNoCode: server.includes('confirmation_mode: "NO_CODE"'),
  mixedProgress: server.includes("anotaai_delivery_confirmations adc") &&
    server.includes("o.platform='anotaai'") &&
    server.includes("o.platform='ifood'"),
  anotaAutoReturn: server.includes('source: "AUTO_ANOTAAI_CONFIRMED"')
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(JSON.stringify({ result: failed.length ? "FAIL" : "PASS", checks }, null, 2));
if (failed.length) process.exit(1);
