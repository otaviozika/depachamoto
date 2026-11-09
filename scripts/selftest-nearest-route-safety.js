// Regressão de segurança operacional: distância viária primeiro, navegação ao mesmo pino
// e bloqueio de atalhos durante alterações não reconhecidas.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { planRoute, planFastestViableRoute, FASTEST_VIABLE_POLICY } from "../lib/route-planner.js";

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
  assert.match(section, /navBlocked\?[^\n]*courierDeliveryNavigationButtons\(routeNavigation\)/);
  assert.match(section, /activeStop\?\.navigation\?\.prefer_coordinates===true/);
});
check("tempo viário e pino exato são a base da rota operacional", () => {
  const service = fs.readFileSync(new URL("../lib/pre-departure-service.js", import.meta.url), "utf8");
  assert.match(service, /planFastestViableRoute\(/);
  assert.match(service, /matrix\.minutes/);
  assert.doesNotMatch(service, /requiredFirstIndex = fromOrigin/);
  assert.match(service, /prefer_coordinates: validCoordinate\(address\)/);
});
check("mais próximo em metros não obriga desvio demorado", () => {
  // A esta a 4 min da loja; B a 6 min, mas A->B leva 20 min.
  // B->A leva 2 min: a ordem B,A entrega ambos em 8 min (vs 24 min).
  const trip = planFastestViableRoute({
    stops: [{key:"A", age_minutes:15},{key:"B", age_minutes:15}],
    minutes:[[0,4,6],[4,0,20],[6,2,0]]
  });
  assert.deepEqual(trip.best.sequence, ["B","A"]);
  assert.equal(trip.best.duration_minutes, 8);
  assert.equal(trip.fastest_duration_minutes, 8);
  assert.equal(trip.evaluated, 2);
  assert.equal(trip.extra_minutes, 0);
});
check("idade antiga pode ganhar prioridade sem desvio acima de 10% ou 3 min", () => {
  const stops=[{key:"A",age_minutes:70},{key:"B",age_minutes:10},{key:"C",age_minutes:5}];
  const minutes=[[0,5,5,8],[5,0,4,4],[5,4,0,4],[8,4,4,0]];
  const p=planFastestViableRoute({stops,minutes,keepCandidates:true});
  assert.equal(p.evaluated,6);
  assert.ok(p.best.duration_minutes <= p.fastest_duration_minutes + p.max_extra_minutes + 1e-9);
  assert.ok(p.max_extra_minutes <= FASTEST_VIABLE_POLICY.max_extra_minutes);
  assert.ok(p.max_extra_minutes <= p.fastest_duration_minutes * FASTEST_VIABLE_POLICY.max_extra_ratio + 1e-9);
  assert.ok(p.candidates.every(c=>c.duration_minutes <= p.fastest_duration_minutes + p.max_extra_minutes + 1e-9));
});
check("cinco destinos têm 120 rotas analisadas e limite temporal verificado", () => {
  const ss=Array.from({length:5},(_,i)=>({key:"p"+i,age_minutes:5+i*12}));
  const mm=Array.from({length:6},(_,i)=>Array.from({length:6},(_,j)=>i===j?0:1+((i*7+j*11)%13)));
  const r=planFastestViableRoute({stops:ss,minutes:mm});
  assert.equal(r.evaluated,120);
  assert.ok(r.eligible_evaluated>=1&&r.eligible_evaluated<=120);
  assert.equal(new Set(r.best.sequence).size,5);
  assert.ok(r.extra_minutes<=r.max_extra_minutes+1e-9);
});

check("card antigo também navega ao pino da rota e bloqueia sem Ciente", () => {
  const start = html.indexOf("function courierDeliveryRow(x){");
  const end = html.indexOf("async function loadCourierDeliveries()", start);
  const cardSource = html.slice(start, end);
  const ctx = vm.createContext({
    courierPreDeparture: { route: {
      dispatch_status: "ON_ROAD", ack_required: false,
      stops: [{ platform: "ifood", external_order_id: "order-x", is_next: true,
        navigation: { latitude: -23.62446, longitude: -46.55491, address: "Rua Original", prefer_coordinates: true } }]
    } },
    escapeHtml: x => String(x ?? ""),
    localTime: () => "",
    courierDeliveryBadge: () => "",
    courierDeliveryCustomerHtml: () => "",
    courierDeliveryAddressHtml: () => "",
    courierDeliveryDetailsHtml: () => "",
    courierDeliveryCopyButton: () => "",
    courierDeliveryPaymentHtml: () => "",
    courierDeliveryNavigationButtons: x => "DESTINO:" + (x.navigation?.latitude ?? "SEM_PINO")
  });
  vm.runInContext(cardSource, ctx);
  const order = { order_id: "order-x", display_id: "100", platform: "ifood",
    navigation: { address: "Rua Original", address_complete: true }, can_confirm: false };
  const enabled = ctx.courierDeliveryRow(order);
  assert.match(enabled, /DESTINO:-23\.62446/);
  ctx.courierPreDeparture.route.stops[0].is_next=false;
  assert.doesNotMatch(ctx.courierDeliveryRow(order), /DESTINO:/);
  ctx.courierPreDeparture.route.stops[0].is_next=true;
  ctx.courierPreDeparture.route.ack_required = true;
  const blocked = ctx.courierDeliveryRow(order);
  assert.doesNotMatch(blocked, /DESTINO:/);
  assert.match(blocked, /Ciente/);
});
console.log(JSON.stringify({ result: "PASS", checks }));
