// Regressão de segurança operacional: distância viária primeiro, navegação ao mesmo pino
// e bloqueio de atalhos durante alterações não reconhecidas.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { planRoute } from "../lib/route-planner.js";

let checks = 0;
function check(name, fn) { fn(); checks++; console.log("PASS", name); }

const stops = [{ key: "perto", age_minutes: 2 }, { key: "antigo", age_minutes: 65 }, { key: "terceiro", age_minutes: 12 }];
const minutes = [[0, 5, 6, 8], [5, 0, 3, 9], [6, 3, 0, 4], [8, 9, 4, 0]];
check("proximidade da loja prevalece sobre antiguidade extrema", () => {
  const chosen = planRoute({ stops, minutes, requiredFirstIndex: 0 });
  assert.equal(chosen.best.sequence[0], "perto");
  assert.equal(chosen.evaluated, 6);
  assert.equal(chosen.eligible_evaluated, 2);
  assert.equal(chosen.required_first_index, 0);
});
check("sem restrição não altera as simulações e os comparadores legados", () => {
  const original = planRoute({ stops, minutes });
  assert.equal(original.evaluated, 6);
  assert.equal(original.eligible_evaluated, 6);
  assert.equal(original.required_first_index, null);
});
check("índice de proximidade inválido não gera sugestão", () => {
  assert.throws(() => planRoute({ stops, minutes, requiredFirstIndex: 3 }), { code: "ROUTE_PRIORITY_INVALID" });
  assert.throws(() => planRoute({ stops, minutes, requiredFirstIndex: -1 }), { code: "ROUTE_PRIORITY_INVALID" });
});
check("cinco entregas: avalia 120 hipóteses e só permite 24 com a primeira parada fixa", () => {
  const s = Array.from({ length: 5 }, (_, i) => ({ key: i, age_minutes: i * 5 }));
  const m = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => i === j ? 0 : i + j + 1));
  const result = planRoute({ stops: s, minutes: m, requiredFirstIndex: 3 });
  assert.equal(result.evaluated, 120);
  assert.equal(result.eligible_evaluated, 24);
  assert.equal(result.best.sequence[0], 3);
});

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const start = html.indexOf("function courierNavigationTarget(destination){");
const end = html.indexOf("function courierDeliveryCustomerHtml(", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ URLSearchParams });
vm.runInContext(html.slice(start, end), context);
check("Waze recebe coordenadas exatas calculadas, mesmo com endereço completo", () => {
  const nav = { latitude: -23.62446, longitude: -46.55491, address: "Rua Fictícia, 5", address_complete: true, prefer_coordinates: true };
  const waze = new URL(context.buildWazeUrl(nav));
  assert.equal(waze.searchParams.get("ll"), "-23.62446,-46.55491");
  assert.equal(waze.searchParams.get("q"), null);
  const maps = new URL(context.buildGoogleMapsUrl(nav));
  assert.equal(maps.searchParams.get("destination"), "-23.62446,-46.55491");
});
check("navegação legada mantém compatibilidade com endereço; pino inválido cai em fallback", () => {
  const legacy = new URL(context.buildWazeUrl({ address: "Rua Fictícia, 5", address_complete: true }));
  assert.equal(legacy.searchParams.get("q"), "Rua Fictícia, 5");
  const badPin = new URL(context.buildWazeUrl({ latitude: 0, longitude: 0, address: "Rua Fictícia, 5", prefer_coordinates: true, address_complete: true }));
  assert.equal(badPin.searchParams.get("q"), "Rua Fictícia, 5");
});
check("nenhum botão antigo de mapa fica ativo antes do Ciente", () => {
  const section = html.slice(html.indexOf("function courierDeliveryRow(x){"), html.indexOf("async function loadCourierDeliveries()", html.indexOf("function courierDeliveryRow(x){")));
  assert.match(section, /activeRoute\?\.ack_required===true/);
  assert.match(section, /navBlocked\?[^\n]*courierDeliveryNavigationButtons\(x\)/);
});
check("distância viária e pino são a base da rota operacional", () => {
  const service = fs.readFileSync(new URL("../lib/pre-departure-service.js", import.meta.url), "utf8");
  assert.match(service, /requiredFirstIndex = fromOrigin\.indexOf\(nearestMeters\)/);
  assert.match(service, /matrix\.meters\?\.\[0\]/);
  assert.match(service, /prefer_coordinates: validCoordinate\(address\)/);
});
console.log(JSON.stringify({ result: "PASS", checks }));
