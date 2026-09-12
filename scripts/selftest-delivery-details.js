import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const context = vm.createContext({ URLSearchParams, localTime: () => '12:00' });
function include(source, start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0 && source.indexOf(end, at) > at);
  vm.runInContext(source.slice(at, source.indexOf(end, at)), context);
}
include(server, 'function parseJsonPayload(', 'function normalizeDeliveryCode(');
include(html, 'function escapeHtml(', '\n');
include(html, 'function courierDeliveryBadge(', 'async function loadCourierDeliveries(');
const address = { streetName: 'Rua de Teste', streetNumber: '100',
  complement: ' Apto 192 Bloco C ', reference: 'Portaria lateral' };
const payload = { delivery: { deliveryAddress: address, observations: 'Tocar o interfone\nAguardar na portaria' },
  items: [{ observations: 'Sem cebola' }] };
const details = context.buildIfoodDeliveryDetails(payload);
assert.equal(details.complement, 'Apto 192 Bloco C');
assert.equal(details.reference, 'Portaria lateral');
assert.equal(details.observations, 'Tocar o interfone\nAguardar na portaria');
assert.equal(JSON.stringify(context.buildIfoodDeliveryDetails(JSON.stringify(payload))), JSON.stringify(details));
for (const value of [null, '', '{invalid', {}, { delivery: { deliveryAddress: {} } },
  { items: [{ observations: 'Sem cebola' }] },
  { delivery: { observations: {}, deliveryAddress: { complement: [], reference: '  ' } } }]) {
  assert.equal(context.buildIfoodDeliveryDetails(value), null);
}
for (const value of [{ delivery: { address } }, { deliveryAddress: address }, { address }, { customer: { address } }]) {
  assert.equal(context.buildIfoodDeliveryDetails(value).complement, 'Apto 192 Bloco C');
}
const navigation = context.buildIfoodDeliveryDestination(payload);
const waze = new URL(context.buildWazeUrl(navigation));
assert.equal(waze.searchParams.get('q'), 'Rua de Teste, 100');
assert.equal(waze.searchParams.get('vehicle_type'), 'motorcycle');
const geo = context.buildIfoodDeliveryDestination({ delivery: { deliveryAddress: {
  ...address, coordinates: { latitude: -23.6, longitude: -46.5 } } } });
assert.equal(new URL(context.buildWazeUrl(geo)).searchParams.get('ll'), '-23.6,-46.5');
assert.equal(context.courierDeliveryDetailsHtml({}), '');
assert.equal(context.courierDeliveryDetailsHtml({ delivery_details: { complement: ' ', reference: null } }), '');
const malicious = context.courierDeliveryDetailsHtml({ delivery_details: {
  complement: '<img src=x onerror=alert(1)>', reference: '<script>alert(1)</script>', observations: 'A & B\nPortaria' } });
assert.doesNotMatch(malicious, /<img|<script/);
assert.match(malicious, /&lt;img/);
assert.match(malicious, /A &amp; B\nPortaria/);
// Instructions remain visible even if iFood supplied no navigable address.
const notesOnly = context.courierDeliveryRow({ display_id: '5212', delivery_details: details });
assert.match(notesOnly, /Apto 192 Bloco C/);
assert.doesNotMatch(notesOnly, /Ir para o Waze/);

// Exercise the actual response assembly for all three courier sections.
context.canonicalIfoodOrderStatus = value => value;
context.deliveryConfirmationLabel = (confirmation, status) => status === 'CONCLUDED' ? status : confirmation;
context.courierDeliveryUiState = row => ({ state: row.order_status, can_confirm: row.order_status !== 'CONCLUDED' });
context.pool = { query: async (sql, params) => {
  assert.deepEqual(Array.from(params), [42]);
  assert.match(sql, /WHERE d.courier_id=\$1/);
  return { rows: [
    { order_id: 'current', dispatch_status: 'ON_ROAD', order_status: 'DISPATCHED' },
    { order_id: 'pending', dispatch_status: 'RELEASED', order_status: 'DISPATCHED' },
    { order_id: 'complete', dispatch_status: 'RELEASED', order_status: 'CONCLUDED' }
  ].map(row => ({ ...row, payload, confirmation_status: 'PENDING', display_id: '5212' })) };
} };
include(server, 'async function getCourierIfoodDeliveries(', 'async function acknowledgeIfoodEvents(');
const response = await context.getCourierIfoodDeliveries(42);
for (const section of ['current', 'pending', 'completed']) {
  assert.equal(response[section].length, 1);
  const item = response[section][0];
  assert.equal(item.delivery_details.complement, 'Apto 192 Bloco C');
  assert.equal(item.payload, undefined);
  const card = context.courierDeliveryRow(item);
  assert.match(card, /Complemento:.*Apto 192 Bloco C/);
  assert.match(card, /Referência:.*Portaria lateral/);
  assert.match(card, /Observações de entrega:/);
  assert.match(card, /Ir para o Waze/);
  assert.doesNotMatch(card, /Sem cebola/);
}
for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
console.log('PASS delivery details: extraction, missing/malformed values, legacy address paths, all courier sections, HTML escaping, navigation and script syntax');
