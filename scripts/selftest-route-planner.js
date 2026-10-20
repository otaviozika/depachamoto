// Motor de sequência (puro) e matriz da Routes API: parâmetros, matriz incompleta,
// desempate determinístico e leitura da resposta do Google sem trânsito ao vivo.
import assert from "node:assert/strict";
import {
  ROUTE_PLANNER_DEFAULTS, factorial, normalizePlannerParams, permutations, planPendingStops, planRoute, validateMatrix
} from "../lib/route-planner.js";
import { createRoutesClient } from "../lib/longe-zone.js";
import { configuredRouteProvider, createOpenRouteServiceClient, createTravelClient } from "../lib/route-providers.js";
import { SCENARIOS, render120, syntheticMatrix } from "./simulate-route-planner.js";

let count = 0;
async function test(name, fn) { await fn(); count++; console.log("PASS " + name); }

await test("permutações de 1 a 5 destinos; 6 é recusado", () => {
  for (let n = 1; n <= 5; n++) {
    const all = permutations(n);
    assert.equal(all.length, factorial(n));
    assert.equal(new Set(all.map(p => p.join(","))).size, all.length);
  }
  assert.throws(() => permutations(6), e => e.code === "ROUTE_STOP_LIMIT");
  assert.throws(() => planRoute({ stops: [], minutes: [[0]] }), e => e.code === "ROUTE_STOP_LIMIT");
});

await test("parâmetros configuráveis com faixa validada", () => {
  assert.deepEqual({ ...normalizePlannerParams({}) }, { ...ROUTE_PLANNER_DEFAULTS });
  assert.equal(normalizePlannerParams({ gamma: "0.5", wait_limit_minutes: 50 }).gamma, 0.5);
  assert.throws(() => normalizePlannerParams({ gamma: -1 }), e => e.code === "ROUTE_PARAM_INVALID");
  assert.throws(() => normalizePlannerParams({ wait_limit_minutes: 2 }), e => e.code === "ROUTE_PARAM_INVALID");
  assert.throws(() => normalizePlannerParams({ alpha: 0, beta: 0 }), e => e.code === "ROUTE_PARAM_INVALID");
});

await test("sem tempo pelas vias para um trecho não há rota (nada inventado)", () => {
  const minutes = [[0, 5, 6], [5, 0, null], [6, 4, 0]];
  assert.throws(() => validateMatrix(minutes, 2), e => e.code === "ROUTE_MATRIX_INCOMPLETE" && e.missing.length === 1);
  assert.throws(() => planRoute({ stops: [{ key: "a", age_minutes: 1 }, { key: "b", age_minutes: 1 }], minutes }), e => e.code === "ROUTE_MATRIX_INCOMPLETE");
  assert.throws(() => planRoute({ stops: [{ key: "a", age_minutes: null }], minutes: [[0, 3], [3, 0]] }), e => e.code === "ROUTE_ORDER_TIME_MISSING");
});

await test("fórmula: chegada, espera, excesso e custo conferidos à mão", () => {
  // Loja→A 10 min, A→B 5 min. A tem 40 min de idade, B 10 min. L=45, α=β=1, γ=0,2.
  const minutes = [[0, 10, 12], [10, 0, 5], [12, 5, 0]];
  const plan = planRoute({ stops: [{ key: "A", age_minutes: 40 }, { key: "B", age_minutes: 10 }], minutes, keepCandidates: true });
  const ab = plan.candidates.find(c => c.sequence.join("") === "AB");
  assert.equal(ab.duration_minutes, 15);
  assert.deepEqual(ab.stops.map(s => s.wait_minutes), [50, 25]);
  assert.equal(ab.penalty, 25); // (50-45)²
  assert.equal(ab.cost, 15 + 75 + 0.2 * 25);
  const ba = plan.candidates.find(c => c.sequence.join("") === "BA");
  assert.deepEqual(ba.stops.map(s => s.wait_minutes), [22, 57]);
  assert.equal(ba.cost, 17 + 79 + 0.2 * 144);
  assert.deepEqual(plan.best.sequence, ["A", "B"]);
});

await test("desempate determinístico: maior espera, depois duração, depois ordem digitada", () => {
  const minutes = [[0, 5, 5], [5, 0, 5], [5, 5, 0]];
  const stops = [{ key: "x", age_minutes: 0 }, { key: "y", age_minutes: 0 }];
  const runs = Array.from({ length: 5 }, () => planRoute({ stops, minutes }).best.sequence.join(""));
  assert.deepEqual(new Set(runs), new Set(["xy"]), "custo igual: fica a ordem digitada");
});

await test("recalcula só os pendentes com a idade atualizada", () => {
  const minutes = [[0, 4, 9], [4, 0, 6], [9, 6, 0]];
  const plan = planPendingStops({ pending: [{ key: "p1", age_minutes: 20 }, { key: "p2", age_minutes: 30 }], minutes, elapsedMinutes: 12 });
  assert.equal(plan.evaluated, 2);
  assert.deepEqual(plan.best.stops.map(s => s.age_minutes).sort(), [32, 42]);
});

await test("demonstração das 120 sequências: todas listadas e ordenadas por custo", () => {
  const { text, plan } = render120();
  assert.equal(plan.candidates.length, 120);
  for (let i = 1; i < plan.candidates.length; i++) assert.ok(plan.candidates[i].cost >= plan.candidates[i - 1].cost - 1e-9);
  assert.equal(text.split("\n").filter(l => /^\| \d+ \| [A-E] →/.test(l)).length, 120);
  assert.ok(syntheticMatrix(SCENARIOS[0].stops).length === SCENARIOS[0].stops.length + 1);
});

await test("Routes API: matriz completa, DRIVE sem trânsito ao vivo, segundos e trecho sem rota", async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, headers: options.headers, body });
    const items = [];
    body.origins.forEach((_, i) => body.destinations.forEach((__, j) => {
      if (i === 1 && j === 2) items.push({ originIndex: i, destinationIndex: j, condition: "ROUTE_NOT_FOUND" });
      else items.push({ originIndex: i, destinationIndex: j, duration: `${60 * (i + j + 1)}s`, distanceMeters: 1000 * (i + j), condition: "ROUTE_EXISTS" });
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
  const client = createRoutesClient({ apiKey: "k", fetchFn });
  const points = [{ latitude: -23.62, longitude: -46.55 }, { latitude: -23.61, longitude: -46.56 }, { latitude: -23.63, longitude: -46.54 }];
  const m = await client.travelMatrix(points);
  assert.equal(requests.length, 1, "uma chamada para a matriz inteira");
  assert.equal(requests[0].body.routingPreference, "TRAFFIC_UNAWARE");
  assert.equal(requests[0].body.travelMode, "DRIVE");
  assert.equal("departureTime" in requests[0].body, false);
  assert.match(requests[0].headers["X-Goog-FieldMask"], /duration/);
  assert.equal(m.seconds[0][1], 120); assert.equal(m.seconds[1][2], null); assert.equal(m.seconds[2][2], 0);
  assert.equal(client.elements, 9);
  await assert.rejects(client.travelMatrix(Array.from({ length: 26 }, () => points[0])), e => e.code === "GOOGLE_ROUTES_MATRIX_SIZE");
  const geo = createRoutesClient({ apiKey: "k", fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ routes: [] }) }) });
  await assert.rejects(geo.geocodeAddress("Rua X, 1", points[0]), e => e.code === "GOOGLE_ROUTES_ADDRESS_NOT_FOUND");
});

await test("openrouteservice (gratuito): matriz, localização precisa × aproximada e erros sem a chave", async () => {
  const requests = [];
  const respond = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/v2/matrix/driving-car")) {
      const n = JSON.parse(options.body).locations.length;
      return respond(200, {
        durations: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => i === j ? 0 : (i === 1 && j === 2 ? null : 60 * (i + j)))),
        distances: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => 1000 * (i + j)))
      });
    }
    const text = new URL(String(url)).searchParams.get("text");
    if (/inexistente/i.test(text)) return respond(200, { features: [] });
    const props = /centro/i.test(text) ? { layer: "street", confidence: 0.6, match_type: "fallback", label: "Rua X, São Caetano do Sul" } : { layer: "address", confidence: 1, match_type: "exact", label: "Rua X, 10" };
    return respond(200, { features: [{ geometry: { coordinates: [-46.556, -23.621] }, properties: props }] });
  };
  const client = createOpenRouteServiceClient({ apiKey: "ORS-KEY-123", fetchFn });
  const points = [{ latitude: -23.62, longitude: -46.55 }, { latitude: -23.61, longitude: -46.56 }, { latitude: -23.63, longitude: -46.54 }];
  const m = await client.travelMatrix(points);
  const matrixCall = requests[0];
  assert.match(matrixCall.url, /\/v2\/matrix\/driving-car$/);
  assert.equal(matrixCall.options.headers.Authorization, "ORS-KEY-123");
  assert.deepEqual(JSON.parse(matrixCall.options.body).locations[0], [-46.55, -23.62], "ORS usa [longitude, latitude]");
  assert.deepEqual(JSON.parse(matrixCall.options.body).metrics, ["duration", "distance"]);
  assert.equal(m.seconds[0][1], 60); assert.equal(m.seconds[1][2], null); assert.equal(m.seconds[2][2], 0);
  const exact = await client.geocodeAddress("Rua X, 10, São Caetano do Sul", points[0]);
  assert.equal(exact.precise, true); assert.equal(exact.latitude, -23.621);
  const rough = await client.geocodeAddress("Rua X, Centro, São Caetano do Sul", points[0]);
  assert.equal(rough.precise, false, "só a rua: aproximado");
  const geocodeUrl = new URL(requests[1].url);
  assert.equal(geocodeUrl.searchParams.get("boundary.country"), "BR");
  assert.ok(geocodeUrl.searchParams.get("focus.point.lat"));
  await assert.rejects(client.geocodeAddress("Rua Inexistente, 1", points[0]), e => e.code === "ROUTES_ADDRESS_NOT_FOUND");
  await assert.rejects(client.resolveAddress("Rua X, Centro", points[0]), e => e.code === "ROUTES_STORE_IMPRECISE");
  const denied = createOpenRouteServiceClient({ apiKey: "SECRET-ORS", fetchFn: async () => respond(403, { error: "Access to this API has been disallowed for SECRET-ORS" }) });
  await assert.rejects(denied.travelMatrix(points), e => e.code === "ROUTES_KEY_REJECTED" && !e.message.includes("SECRET-ORS"));
  const limited = createOpenRouteServiceClient({ apiKey: "k", fetchFn: async () => respond(429, { error: "Rate limit exceeded" }) });
  await assert.rejects(limited.travelMatrix(points), e => e.code === "ROUTES_RATE_LIMITED");
});

await test("serviço de rotas escolhido pela chave no Render: Google, openrouteservice ou nenhum", () => {
  assert.equal(configuredRouteProvider({}), null);
  assert.equal(configuredRouteProvider({ OPENROUTESERVICE_API_KEY: "o" }), "openrouteservice");
  assert.equal(configuredRouteProvider({ OPENROUTESERVICE_API_KEY: "o", GOOGLE_ROUTES_API_KEY: "g" }), "google");
  assert.equal(createTravelClient({ env: { OPENROUTESERVICE_API_KEY: "o" } }).provider, "openrouteservice");
  assert.equal(createTravelClient({ env: { GOOGLE_ROUTES_API_KEY: "g" } }).provider, "google");
  assert.throws(() => createTravelClient({ env: {} }), e => e.code === "ROUTES_NOT_CONFIGURED");
});

console.log(`PASS: ${count} verificações do motor de sequência.`);
