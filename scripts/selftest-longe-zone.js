// Regra LONGE: geometria (borda exata), agrupamento, geração da zona por raios,
// cliente da Routes API (sem trânsito ao vivo), janela de teste e prévia por mês.
import assert from "node:assert/strict";
import {
  LONGE_RADIUS_METERS, LONGE_STORE, classifyLongePoint, clusterPoints, createRoutesClient, destinationPoint,
  generateLongeZonePolygon, haversineMeters, longeTestWeekend, longeUnitAmount, modeAt, pointPositionInPolygon,
  rayBoundaryIndex, resolveStoreOrigin, summarizeLongePreview
} from "../lib/longe-zone.js";

let count = 0;
async function test(name, fn) { await fn(); count++; console.log("PASS " + name); }

const square = [[-23.60, -46.60], [-23.60, -46.50], [-23.70, -46.50], [-23.70, -46.60]];

await test("borda exata: ponto sobre a linha ou vértice é NORMAL; fora é LONGE", () => {
  assert.equal(pointPositionInPolygon({ latitude: -23.65, longitude: -46.55 }, square), "INSIDE");
  assert.equal(pointPositionInPolygon({ latitude: -23.60, longitude: -46.55 }, square), "BOUNDARY");
  assert.equal(pointPositionInPolygon({ latitude: -23.70, longitude: -46.60 }, square), "BOUNDARY");
  assert.equal(classifyLongePoint({ latitude: -23.65, longitude: -46.50 }, square).status, "NORMAL");
  assert.equal(classifyLongePoint({ latitude: -23.65, longitude: -46.4999 }, square).status, "LONGE");
  assert.equal(classifyLongePoint({ latitude: -23.65, longitude: -46.5001 }, square).status, "NORMAL");
  assert.equal(classifyLongePoint({ latitude: 0, longitude: 0 }, square).status, "NO_LOCATION");
  assert.equal(classifyLongePoint({ latitude: null, longitude: -46.5 }, square).status, "NO_LOCATION");
  assert.throws(() => pointPositionInPolygon({ latitude: -23.6, longitude: -46.5 }, [[-23.6, -46.5], [-23.7, -46.5]]), /inválido/);
});

await test("valor LONGE = 2x o valor por entrega (hoje R$ 12)", () => {
  assert.equal(longeUnitAmount(6), 12);
  assert.equal(longeUnitAmount(6.5), 13);
});

await test("agrupa endereços próximos (~100 m) e separa os distantes", () => {
  const a = { latitude: -23.6300, longitude: -46.5600 };
  const near = destinationPoint(a, 45, 20), far = destinationPoint(a, 45, 400);
  const clusters = clusterPoints([a, near, far, { latitude: 0, longitude: 0 }]);
  assert.equal(clusters.reduce((n, c) => n + c.count, 0), 3, "coordenada inválida fica de fora");
  assert.ok(clusters.length === 2 || clusters.length === 3);
  const farCluster = clusters.find(c => c.members.includes(2));
  assert.deepEqual(farCluster.members, [2]);
  assert.ok(haversineMeters(farCluster, far) < 1);
});

const store = LONGE_STORE.approx;
const factor = bearing => 1.25 + 0.25 * Math.sin(bearing * Math.PI / 90);
const routeLike = point => {
  const straight = haversineMeters(store, point);
  const rad = Math.PI / 180, dLng = (point.longitude - store.longitude) * rad;
  const y = Math.sin(dLng) * Math.cos(point.latitude * rad);
  const x = Math.cos(store.latitude * rad) * Math.sin(point.latitude * rad) - Math.sin(store.latitude * rad) * Math.cos(point.latitude * rad) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) / rad + 360) % 360;
  return straight * factor(bearing);
};

await test("gera o polígono pela distância de rota em cada direção", async () => {
  let calls = 0;
  const zone = await generateLongeZonePolygon({ origin: store, distancesFn: async points => { calls++; return points.map(routeLike); } });
  assert.equal(zone.polygon.length, 96);
  assert.ok(calls >= 2 && calls <= 6, "amostragem + refinamento em lote");
  for (const ray of zone.rays) {
    const expected = LONGE_RADIUS_METERS / factor(ray.bearing);
    assert.ok(Math.abs(ray.radius_meters - expected) < 20, `raio ${ray.bearing}° ${ray.radius_meters} vs ${expected}`);
  }
  const ray = zone.rays[10];
  assert.equal(classifyLongePoint(destinationPoint(store, ray.bearing, ray.radius_meters - 60), zone.polygon).status, "NORMAL");
  assert.equal(classifyLongePoint(destinationPoint(store, ray.bearing, ray.radius_meters + 60), zone.polygon).status, "LONGE");
  assert.equal(classifyLongePoint(destinationPoint(store, 0, 2000), zone.polygon).status, "NORMAL");
  assert.equal(classifyLongePoint(destinationPoint(store, 0, 9000), zone.polygon).status, "LONGE");
});

await test("fronteira ignora um ponto isolado acima do limite e respeita sem rota", () => {
  assert.deepEqual(rayBoundaryIndex([1000, 7000, 3000, 4000, 7000, 7100], 6700), { index: 3, capped: false, next: 4 });
  assert.deepEqual(rayBoundaryIndex([1000, null, 5000, 6900, null, 7100], 6700), { index: 2, capped: false, next: 3 });
  assert.equal(rayBoundaryIndex([1000, 2000, 3000], 6700).capped, true);
  assert.equal(rayBoundaryIndex([7000, 7100, 7200], 6700).index, -1);
});

await test("Routes API: chave, field mask, DRIVE sem trânsito ao vivo, lotes e índices", async () => {
  assert.throws(() => createRoutesClient({ apiKey: "" }), e => e.code === "GOOGLE_ROUTES_NOT_CONFIGURED" && e.status === 503);
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, headers: options.headers, body });
    if (String(url).includes("computeRoutes")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ routes: [{ legs: [{ startLocation: { latLng: { latitude: store.latitude + 0.0005, longitude: store.longitude } } }] }] }) };
    }
    const items = body.destinations.map((_, i) => i === 1
      ? { originIndex: 0, destinationIndex: i, condition: "ROUTE_NOT_FOUND" }
      : { originIndex: 0, destinationIndex: i, distanceMeters: 1000 + i, condition: "ROUTE_EXISTS" }).reverse();
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
  const client = createRoutesClient({ apiKey: "test-key", fetchFn });
  const points = Array.from({ length: 620 }, (_, i) => destinationPoint(store, i % 360, 1000 + i));
  const distances = await client.distancesFrom(store, points);
  assert.equal(requests.length, 2, "até 500 destinos por chamada");
  assert.equal(distances[0], 1000); assert.equal(distances[1], null); assert.equal(distances[2], 1002);
  assert.equal(distances[501], null); assert.equal(distances[619], 1119);
  const [first] = requests;
  assert.equal(first.headers["X-Goog-Api-Key"], "test-key");
  assert.match(first.headers["X-Goog-FieldMask"], /distanceMeters/);
  assert.equal(first.body.travelMode, "DRIVE");
  assert.equal(first.body.routingPreference, "TRAFFIC_UNAWARE");
  assert.equal("departureTime" in first.body, false);
  assert.equal(client.elements, 620);
  const origin = await resolveStoreOrigin(client);
  assert.ok(origin.drift_meters < 100);
  assert.equal(requests.at(-1).body.origin.address, LONGE_STORE.address);
  const farClient = { resolveAddress: async () => destinationPoint(store, 0, 2000) };
  await assert.rejects(resolveStoreOrigin(farClient), e => e.code === "LONGE_STORE_GEOCODE_DRIFT");
  const denied = createRoutesClient({ apiKey: "SECRET-KEY-123", fetchFn: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: "API key not valid" } }) }) });
  await assert.rejects(denied.distancesFrom(store, [store]), e => /API key not valid/.test(e.message) && !e.message.includes("SECRET-KEY-123") && e.status === 503);
});

await test("primeiro fim de semana completo em teste antes de ativar o pagamento", () => {
  assert.deepEqual(longeTestWeekend("2026-10-19T13:00:00Z"), { starts_at: "2026-10-23T14:00:00.000Z", ends_at: "2026-10-26T05:00:00.000Z" });
  assert.equal(longeTestWeekend("2026-10-23T13:59:00Z").starts_at, "2026-10-23T14:00:00.000Z", "sexta antes do almoço vale");
  assert.equal(longeTestWeekend("2026-10-23T15:00:00Z").starts_at, "2026-10-30T14:00:00.000Z", "sexta já começada vai para a próxima");
  assert.equal(longeTestWeekend("2026-10-25T23:00:00Z").starts_at, "2026-10-30T14:00:00.000Z", "domingo vai para a próxima");
  const history = [{ id: 1, mode: "TEST", effective_at: "2026-10-19T13:00:00Z" }, { id: 2, mode: "ACTIVE", effective_at: "2026-10-26T12:00:00Z" }, { id: 3, mode: "OFF", effective_at: "2026-11-01T12:00:00Z" }];
  assert.equal(modeAt(history, "2026-10-19T12:59:59Z"), "OFF");
  assert.equal(modeAt(history, "2026-10-24T20:00:00Z"), "TEST");
  assert.equal(modeAt(history, "2026-10-26T12:00:00Z"), "ACTIVE");
  assert.equal(modeAt(history, "2026-11-02T00:00:00Z"), "OFF");
});

await test("prévia: LONGE por mês e bairros na borda dos 6,7 km", () => {
  const deliveries = [
    { month: "2026-09", neighborhood: "Barcelona", city: "São Caetano do Sul", latitude: -23.62, longitude: -46.55, d: 900 },
    { month: "2026-09", neighborhood: "Ipiranga", city: "São Paulo", latitude: -23.59, longitude: -46.60, d: 6650 },
    { month: "2026-09", neighborhood: "Ipiranga", city: "São Paulo", latitude: -23.58, longitude: -46.61, d: 6750 },
    { month: "2026-10", neighborhood: "Sacomã", city: "São Paulo", latitude: -23.60, longitude: -46.62, d: 8200 },
    { month: "2026-10", neighborhood: "Sacomã", city: "São Paulo", latitude: -23.60, longitude: -46.62, d: null },
    { month: "2026-10", neighborhood: "?", city: "", latitude: 0, longitude: 0, d: 1 }
  ];
  const summary = summarizeLongePreview(deliveries, x => x.d);
  assert.deepEqual(summary.months.map(m => [m.month, m.deliveries, m.longe, m.normal, m.no_route]), [["2026-09", 3, 1, 2, 0], ["2026-10", 3, 1, 0, 1]]);
  assert.equal(summary.totals.longe, 2);
  assert.equal(summary.border_neighborhoods[0].neighborhood, "Ipiranga");
  assert.equal(summary.border_neighborhoods[0].in_band, 2);
  assert.ok(!summary.border_neighborhoods.some(h => h.neighborhood === "Sacomã"), "8,2 km não é borda");
});

console.log(`PASS: ${count} cenários da zona LONGE.`);
