import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const context = vm.createContext({ URLSearchParams });
function include(source, start, end) {
  const at = source.indexOf(start), to = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at);
  vm.runInContext(source.slice(at, to), context);
}
include(server, 'function parseJsonPayload(', 'function normalizeDeliveryCode(');
include(html, 'function courierNavigationTarget(', 'function courierDeliveryCustomerHtml(');
const base = {
  streetName: 'Rua de Teste', streetNumber: '100', neighborhood: 'Centro',
  city: 'São Caetano do Sul', state: 'SP', country: 'BR', postalCode: '09550000',
  formattedAddress: 'Rua de Teste', complement: 'Apto 987 Bloco C',
  coordinates: { latitude: -23.61, longitude: -46.56 }
};
const expected = 'Rua de Teste, 100, Centro - São Caetano do Sul - SP, 09550-000, Brasil';
let tests = 0;
function links(destination, target, coordinates = false) {
  const waze = new URL(context.buildWazeUrl(destination));
  const maps = new URL(context.buildGoogleMapsUrl(destination));
  assert.equal(waze.searchParams.get(coordinates ? 'll' : 'q'), target);
  assert.equal(waze.searchParams.has(coordinates ? 'q' : 'll'), false);
  assert.equal(maps.searchParams.get('destination'), target);
  assert.equal(waze.searchParams.get('navigate'), 'yes');
  assert.equal(waze.searchParams.get('vehicle_type'), 'motorcycle');
  assert.equal(maps.searchParams.get('api'), '1');
  assert.equal(maps.searchParams.get('dir_action'), 'navigate');
  tests++;
}
for (const [build, wrap] of [
  [context.buildIfoodDeliveryDestination, address => ({ delivery: { deliveryAddress: address } })],
  [context.buildAnotaAiDeliveryDestination, address => ({ deliveryAddress: address })]
]) {
  // Full street/number wins over an abbreviated formattedAddress and an unverified pin.
  const destination = build(wrap(base));
  assert.equal(destination.address, expected);
  assert.equal(destination.latitude, -23.61);
  assert.equal(destination.longitude, -46.56);
  assert.equal(destination.source, 'address');
  links(destination, expected);
  assert.doesNotMatch(destination.address, /Apto|987|Bloco/);
  links(build(JSON.stringify(wrap({ ...base, streetNumber: 100 }))), expected);

  for (const coordinates of [
    { latitude: null, longitude: null }, { latitude: '', longitude: '' },
    { latitude: '  ', longitude: '  ' }, { latitude: false, longitude: [] },
    { latitude: {}, longitude: true }, { latitude: 0, longitude: 0 },
    { latitude: 91, longitude: -46.5 }, { latitude: -23.5, longitude: 181 },
    { latitude: 'NaN', longitude: 'Infinity' }
  ]) {
    const result = build(wrap({ ...base, coordinates }));
    assert.equal(result.latitude, null);
    assert.equal(result.longitude, null);
    links(result, expected);
  }
  // Pins still work when the platform has not provided a numbered street address.
  links(build(wrap({ coordinates: { latitude: '-23,61', longitude: '-46,56' } })), '-23.61,-46.56', true);
  links(build(wrap({ location: { type: 'Point', coordinates: [-46.56, -23.61] } })), '-23.61,-46.56', true);
  assert.equal(build(wrap({ city: 'São Caetano do Sul', postalCode: '09550000' })), null);
  assert.equal(build(wrap({ coordinates: { latitude: 0, longitude: 0 } })), null);
  const zeroCep = build(wrap({ ...base, postalCode: '00000000' }));
  assert.doesNotMatch(zeroCep.address, /00000/);
}

const aliases = context.buildAnotaAiDeliveryDestination({ delivery_address: {
  street_name: 'Rua de Teste', street_number: 100, bairro: 'Centro', cidade: 'São Caetano do Sul',
  uf: 'SP', cep: '09550-000', country: 'br', coordinates: { lat: '-23.61', lng: '-46.56' }
} });
links(aliases, expected);
assert.equal(context.buildAnotaAiDeliveryCardAddress({ delivery_address: { street: 'Rua X', number: 42 } }).number, '42');
links(context.buildIfoodDeliveryDestination({ delivery: { deliveryAddress: {} }, customer: { address: base } }), expected);
links(context.buildIfoodDeliveryDestination({ delivery: { deliveryAddress: 'Rua Exemplo, 42, Santo André, SP' } }),
  'Rua Exemplo, 42, Santo André, SP');
// A partial pair in one object must not borrow longitude from another object.
const mixed = context.buildIfoodDeliveryDestination({ delivery: { deliveryAddress: {
  streetName: 'Rua X', streetNumber: '1', coordinates: { latitude: -23.61 }, longitude: -46.56
} } });
assert.equal(mixed.latitude, null);
assert.equal(mixed.longitude, null);
links(mixed, 'Rua X, 1');

for (const destination of [null, {}, { latitude: null, longitude: null },
  { latitude: ' ', longitude: [] }, { latitude: false, longitude: true },
  { latitude: 0, longitude: 0 }, { latitude: 91, longitude: 20 }, { latitude: 20, longitude: 181 }]) {
  assert.equal(context.buildWazeUrl(destination), '');
  assert.equal(context.buildGoogleMapsUrl(destination), '');
  tests++;
}
links({ latitude: -23.61, longitude: -46.56, source: 'coordinates' }, '-23.61,-46.56', true);
links({ address: 'Rua A & B, 12, São André, SP', latitude: 999, longitude: 999 }, 'Rua A & B, 12, São André, SP');
assert.match(html, /x\?\.navigation/);
assert.match(server, /navigation: buildIfoodDeliveryDestination\(row\.payload\)/);
assert.match(server, /navigation: buildAnotaAiDeliveryDestination\(row\.payload\)/);
console.log(`PASS navigation: ${tests} cases for numbered addresses, identical Waze/Maps destinations, platform aliases, pin fallbacks and invalid coordinates`);
