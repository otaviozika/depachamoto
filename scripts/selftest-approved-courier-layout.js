import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/courier-dark.css",import.meta.url),"utf8");
const worker=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");
const prestart=fs.readFileSync(new URL("./apply-customer-name-card.js",import.meta.url),"utf8");

assert.match(html,/APPROVED COURIER DELIVERY CARD V1/);
assert.match(html,/delivery-platform-logo/);
assert.match(html,/courierDeliveryCustomerHtml\(x\)/);
assert.match(html,/courierDeliveryCopyButton\(x\)/);
assert.match(html,/courierDeliveryNavigationButtons\(x\)/);
assert.match(css,/delivery-platform-logo\.ifood/);
assert.match(css,/delivery-address-number/);
assert.match(worker,/approved-delivery-card-v1/);
assert.match(prestart,/APPROVED COURIER DELIVERY CARD V1/);

const ifood=server.slice(server.indexOf("async function getCourierIfoodDeliveries("),
  server.indexOf("async function getCourierAnotaAiDeliveries("));
const anota=server.slice(server.indexOf("async function getCourierAnotaAiDeliveries("),
  server.indexOf("async function acknowledgeIfoodEvents("));
assert.equal((ifood.match(/customer_name:/g)||[]).length,1);
assert.equal((ifood.match(/address_parts:/g)||[]).length,1);
assert.equal((anota.match(/customer_name:/g)||[]).length,1);
assert.equal((anota.match(/address_parts:/g)||[]).length,1);
assert.match(anota,/a\.customer_name,a\.payload/);
assert.match(anota,/navigation: buildAnotaAiDeliveryDestination\(row\.payload\)/);

const context=vm.createContext({URLSearchParams});
const start=server.indexOf("function parseJsonPayload(");
const end=server.indexOf("function normalizeDeliveryCode(",start);
assert.ok(start>0&&end>start);
vm.runInContext(server.slice(start,end),context);
const payload={customer:{name:"Cliente teste"},deliveryAddress:{
  streetName:"Rua Teste",streetNumber:"56",complement:"Apto 9",
  neighborhood:"Centro",city:"São Caetano do Sul",state:"SP"}};
assert.equal(context.buildOrderCustomerName(payload),"Cliente teste");
assert.equal(context.buildAnotaAiDeliveryCardAddress(payload).number,"56");
const destination=context.buildAnotaAiDeliveryDestination(payload);
assert.match(destination.address,/Rua Teste, 56/);
assert.match(destination.address,/São Caetano do Sul/);
assert.equal(destination.latitude,null);
assert.equal(destination.longitude,null);

console.log("PASS approved courier layout: customer, no duplicated fields, compact address, AnotaAI navigation, cache and CSS");
