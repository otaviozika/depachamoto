import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { test } from "node:test";

const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const section=(a,b)=>{
  const i=html.indexOf(a),j=html.indexOf(b,i+a.length);
  assert.ok(i>=0&&j>i,a+" -> "+b);
  return html.slice(i,j);
};
const renderPreDeparture=section("function renderPreDeparture(){","async function preDepartureAction(request,");
const deliveries=section("async function loadCourierDeliveries(){","// Pré-saída (com a flag ligada):");
const card=section("function courierDeliveryRow(x){","function courierFocusOrder(x,stop){");

test("Two checked bags unlock dispatch directly without route planning",()=>{
  const el={innerHTML:"",classList:{toggle(){}}};
  const refs={preDepartureCard:el,departureCard:{classList:{toggle(){}}}};
  const ctx=vm.createContext({
    courierPreDeparture:{enabled:{pre_departure:true},pre_departure:{
      id:1,counts:{total:2,checked:2},can_dispatch:true,status:"CHECKED",
      route_valid:false,route:null,ack_required:false,orders:[
        {id:11,order_number:"#11",platform:"ifood",platform_label:"iFood",checked:true},
        {id:12,order_number:"#12",platform:"anotaai",platform_label:"Anota AI",checked:true}
      ]
    }},
    preDepartureBusy:false,preDepartureCheckingId:null,me:{name:"Piloto"},
    updateCourierDepartureEligibility(){},escapeHtml:x=>String(x),
    $:k=>refs[k],preDepartureRouteHtml(){throw Error("route should not be needed")}
  });
  vm.runInContext(renderPreDeparture,ctx);
  vm.runInContext("renderPreDeparture()",ctx);
  assert.match(el.innerHTML,/CONFIRMAR SAÍDA/);
  assert.match(el.innerHTML,/onclick="confirmPreDepartureDeparture\(\)"/);
  assert.doesNotMatch(el.innerHTML,/CONFIRMAR SACOLAS E CALCULAR ROTA/);
  assert.doesNotMatch(el.innerHTML,/onclick="calculatePreDepartureRoute/);
});

test("Five assigned orders are all directly visible and confirmable in any sequence",async()=>{
  const elements={courierDeliveriesCard:{},courierRouteBadge:{textContent:"",classList:{toggle(){}}},
    courierRouteFocus:{innerHTML:""},
    courierRouteProgress:{textContent:"",classList:{toggle(){}}},
    courierDeliveriesList:{innerHTML:""}};
  const ids=["i-1","a-2","i-3","a-4","i-5"];
  const rows=ids.map(id=>({
    order_id:id,platform:id.startsWith("i")?"ifood":"anotaai",
    display_id:id,departed_at:"2026-11-12T19:00:00Z",can_confirm:true
  }));
  const ctx=vm.createContext({
    me:{role:"courier"},courierPreDeparture:{route:{counts:{total:5,delivered:0},
      stops:[{platform:"ifood",external_order_id:"i-1",is_next:true},
             {platform:"anotaai",external_order_id:"a-2",is_next:false}]}},
    $:k=>elements[k],Date,escapeHtml:x=>String(x),
    api:async p=>p.includes("/ifood/")?{current:rows.filter(x=>x.platform==="ifood"),pending:[],completed:[]}:
      {current:rows.filter(x=>x.platform==="anotaai"),pending:[],completed:[]},
    courierDeliveryRow:o=>'<div class="order-card" data-order="'+o.order_id+'"><button>Confirmar entrega</button></div>'
  });
  vm.runInContext(deliveries,ctx);
  await vm.runInContext("loadCourierDeliveries()",ctx);
  for(const id of ids) assert.ok(elements.courierDeliveriesList.innerHTML.includes('data-order="'+id+'"'),id);
  assert.equal((elements.courierDeliveriesList.innerHTML.match(/Confirmar entrega/g)||[]).length,5);
  assert.doesNotMatch(elements.courierDeliveriesList.innerHTML,/Mais \d+ entrega/);
  assert.match(elements.courierRouteFocus.innerHTML,/Confirme qualquer entrega/);
  assert.equal(elements.courierRouteBadge.textContent,"5");
});

test("An order that is not first still allows navigation and delivery confirmation",()=>{
  const ctx=vm.createContext({
    courierPreDeparture:{route:{dispatch_status:"ON_ROAD",ack_required:false,stops:[
      {platform:"ifood",external_order_id:"i-first",is_next:true},
      {platform:"ifood",external_order_id:"i-second",is_next:false}
    ]}},
    escapeHtml:x=>String(x),JSON,
    courierDeliveryBadge:()=>"",courierDeliveryCustomerHtml:()=>"",
    courierDeliveryAddressHtml:()=>"",courierDeliveryDetailsHtml:()=>"",
    courierDeliveryCopyButton:()=>"",courierDeliveryPaymentHtml:()=>"",
    courierDeliveryNavigationButtons:()=>'<a>Waze e Maps</a>',
    localTime:()=> "18:30",incidentActionHtml:()=>"",
    moneyBRL:()=>"",
  });
  vm.runInContext(card,ctx);
  const markup=vm.runInContext("courierDeliveryRow({order_id:'i-second',platform:'ifood',display_id:'222',can_confirm:true})",ctx);
  assert.match(markup,/Waze e Maps/);
  assert.match(markup,/Confirmar entrega/);
  assert.doesNotMatch(markup,/siga a próxima parada|Navegação indisponível/);
  vm.runInContext("courierPreDeparture.route.ack_required=true",ctx);
  const blocked=vm.runInContext("courierDeliveryRow({order_id:'i-second',platform:'ifood',display_id:'222',can_confirm:true})",ctx);
  assert.doesNotMatch(blocked,/Waze e Maps/);
  assert.match(blocked,/confirme a alteração do endereço/);
  assert.match(blocked,/Confirmar entrega/);
});

console.log("UI optional-route regression coverage registered");
