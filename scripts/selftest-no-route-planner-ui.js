import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const service=readFileSync(new URL("../lib/pre-departure-service.js",import.meta.url),"utf8");
const section=(a,b)=>{
  const start=html.indexOf(a),end=html.indexOf(b,start+a.length);
  assert.ok(start>=0 && end>start, "function boundaries: "+a);
  return html.slice(start,end);
};

test("No route-planning controls or computational itineraries remain in the UI",()=>{
  for(const removed of [
    "Consultar roteiro sugerido (opcional)",
    "CONFIRMAR SACOLAS E CALCULAR ROTA",
    "Tentar calcular de novo",
    "Recalcular rota",
    "Reordenar pendentes (exceção)",
    "Sequência automática",
    "Definir sequência (exceção)",
    "routeStopHtml(",
    "preDepartureRouteHtml(",
    "calculatePreDepartureRoute("
  ]) assert.ok(!html.includes(removed),"Legacy UI remains: "+removed);
  assert.ok(html.includes('data-courier-panel="route"'),"The delivery tab must remain");
  assert.ok(html.includes('id="courierDeliveriesList"'),"Delivery list preserved");
  assert.ok(html.includes("current.map(courierDeliveryRow)"),"All dispatched orders visible");
  assert.ok(html.includes("Confirme qualquer entrega, na ordem em que realizar."),"Any-order delivery preserved");
});

test("Mandatory physical bag checks still gate the departure button",()=>{
  const el={innerHTML:"",classList:{toggle(){}}};
  const refs={preDepartureCard:el,departureCard:{classList:{toggle(){}}}};
  const ctx=vm.createContext({
    courierPreDeparture:{enabled:{pre_departure:true},pre_departure:{
      id:1,counts:{total:2,checked:1},can_dispatch:false,status:"PARTIALLY_CHECKED",
      route_valid:false,route:null,ack_required:false,orders:[
        {id:11,order_number:"#11",platform:"ifood",platform_label:"iFood",checked:true},
        {id:12,order_number:"#12",platform:"anotaai",platform_label:"Anota AI",checked:false}
      ]
    }},
    preDepartureBusy:false,preDepartureCheckingId:null,me:{name:"Piloto"},
    updateCourierDepartureEligibility(){},escapeHtml:x=>String(x),$:id=>refs[id]
  });
  vm.runInContext(section("function renderPreDeparture(){","async function preDepartureAction("),ctx);
  vm.runInContext("renderPreDeparture()",ctx);
  assert.match(el.innerHTML, /disabled onclick="confirmPreDepartureDeparture\(\)"/);
  assert.match(el.innerHTML,/1 sacola\(s\) pendente/);
  assert.match(el.innerHTML,/checked disabled onchange="togglePreDepartureBag\(11\)"/);
  vm.runInContext("courierPreDeparture.pre_departure.orders[1].checked=true;courierPreDeparture.pre_departure.counts.checked=2;courierPreDeparture.pre_departure.can_dispatch=true;renderPreDeparture()",ctx);
  assert.match(el.innerHTML,/onclick="confirmPreDepartureDeparture\(\)"/);
  assert.doesNotMatch(el.innerHTML,/disabled onclick="confirmPreDepartureDeparture\(\)"/);
});

test("Address correction still requires Ciente and no duplicated route listing",()=>{
  const element={innerHTML:""};
  const ctx=vm.createContext({
    $:id=>id==="courierMyRoute"?element:null,
    courierPreDeparture:{route:{
      dispatch_status:"ON_ROAD",ack_required:true,dispatch_id:200,route_version:3,
      stops:[{order_number:"#12",state:"PENDING",changed_unacked:true,is_deferred:false}]
    }},
    courierRouteFresh:true,navigator:{onLine:true},escapeHtml:x=>String(x)
  });
  vm.runInContext(section("function renderCourierMyRoute(){","async function ackCourierRoute("),ctx);
  vm.runInContext("renderCourierMyRoute()",ctx);
  assert.match(element.innerHTML,/Endereço atualizado pelo caixa/);
  assert.match(element.innerHTML,/ackCourierRoute\(200,3\)/);
  assert.doesNotMatch(element.innerHTML,/route-stops|Próxima parada/);
});

test("Admin keeps bag control, address correction and TTL, but not automatic route",()=>{
  const admin=section("function renderPreDepartureAdmin(){","function preDepartureReason(");
  assert.match(admin,/Conferência de sacolas/);
  assert.match(admin,/Correção de endereço/);
  assert.match(admin,/Cancelar pré-saída/);
  assert.match(admin,/Expiração da pré-saída/);
  assert.doesNotMatch(admin,/flag\('route_planner'/);
  assert.doesNotMatch(admin,/pdAlpha|pdBeta|pdGamma|pdReturn/);
});

test("Address corrections do not compute a route when the feature is off",()=>{
  assert.match(service,/const autoRouteEnabled = \(await readSettings\(\)\)\.route_planner/);
  assert.match(service,/const allChecked = autoRouteEnabled &&/);
  assert.match(service,/routeOutcome = allChecked \? await computeRoute\(pdId\)/);
});
