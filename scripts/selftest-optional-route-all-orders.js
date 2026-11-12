import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const begin=html.indexOf("async function loadCourierDeliveries(){");
const finish=html.indexOf("// Pré-saída (com a flag ligada):",begin);
assert.ok(begin>0 && finish>begin,"Expected courier delivery list implementation");
const fn=html.slice(begin,finish);
assert.doesNotMatch(fn,/Mais \${others\.length}/,"All active deliveries must remain visible without collapsing");
assert.match(fn,/current\.map\(courierDeliveryRow\)/,"Every active delivery needs its own card");
assert.match(html,/const navBlocked=awaitingAck;/,"Only unacknowledged corrections may block navigation");
assert.doesNotMatch(fn,/planFastestViableRoute|calculatePreDepartureRoute/,"The route tab cannot run the planner");

const elements={};
function element(id) {
  if(!elements[id])elements[id]={innerHTML:"",textContent:"",classList:{toggle(){}}};
  return elements[id];
}
const statuses={
  ifood:{
    current:[
      {order_id:"IF100",display_id:"100",departed_at:"2026-11-12T18:00:00Z",platform:"ifood",can_confirm:true},
      {order_id:"IF102",display_id:"102",departed_at:"2026-11-12T18:00:00Z",platform:"ifood",can_confirm:true}
    ],pending:[],completed:[]
  },
  anotaai:{
    current:[{order_id:"AN101",display_id:"101",departed_at:"2026-11-12T18:00:00Z",platform:"anotaai",can_confirm:true}],
    pending:[],completed:[]
  }
};
const ctx=vm.createContext({
  me:{role:"courier"},courierPreDeparture:{route:null},
  $:element,
  api:async path=>{if(path.includes("ifood"))return statuses.ifood;if(path.includes("anotaai"))return statuses.anotaai;throw Error("Unexpected API path")},
  escapeHtml:x=>String(x),
  courierDeliveryRow:x=>`<article data-platform="${x.platform}" data-order="${x.display_id}">Confirmar ${x.display_id}</article>`,
  Date,console
});
vm.runInContext(fn,ctx);
await vm.runInContext("loadCourierDeliveries()",ctx);
for(const n of ["100","101","102"])assert.match(element("courierDeliveriesList").innerHTML,new RegExp('data-order="'+n+'"'));
assert.equal((element("courierDeliveriesList").innerHTML.match(/<article /g)||[]).length,3);
assert.doesNotMatch(element("courierDeliveriesList").innerHTML,/Mais \d+ entrega/);
assert.match(element("courierRouteFocus").innerHTML,/qualquer entrega/i);
assert.equal(element("courierRouteBadge").textContent,"3");

statuses.anotaai.current=[];
statuses.anotaai.completed=[{order_id:"AN101",display_id:"101",departed_at:"2026-11-12T18:00:00Z",platform:"anotaai",can_confirm:false}];
await vm.runInContext("loadCourierDeliveries()",ctx);
assert.equal((element("courierDeliveriesList").innerHTML.match(/<article /g)||[]).length,3);
assert.match(element("courierDeliveriesList").innerHTML,/Entregas concluídas hoje/);
assert.equal(element("courierRouteBadge").textContent,"2");
console.log("PASS optional route: three uncollapsed orders, mixed platforms, arbitrary delivery order, completed history and badge");
