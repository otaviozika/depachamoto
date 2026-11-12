import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {test} from "node:test";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const service=readFileSync(new URL("../lib/pre-departure-service.js",import.meta.url),"utf8");
const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
function piece(start,end){
  const i=html.indexOf(start),j=html.indexOf(end,i+start.length);
  assert.ok(i>0&&j>i,"expected function "+start);
  return html.slice(i,j);
}

test("Ciente and manual route orientation always visible before delivery list",()=>{
  const layout=html.indexOf('id="courierRouteTab"');
  const notice=html.indexOf('id="courierMyRoute"',layout);
  const details=html.indexOf('id="courierRouteAdvanced"',layout);
  const orders=html.indexOf('id="courierDeliveriesList"',layout);
  assert.ok(layout>=0&&layout<notice&&notice<details&&details<orders);
  const current={innerHTML:""};
  const ctx=vm.createContext({
    $:id=>id==="courierMyRoute"?current:null,
    courierPreDeparture:{route:{
      dispatch_id:9,dispatch_status:"ON_ROAD",ack_required:true,route_version:3,
      last_change:{cause:"ADMIN_RESEQUENCE"},stops:[
        {order_number:"#101",state:"PENDING",changed_unacked:true},
        {order_number:"#102",state:"PENDING",changed_unacked:true}
      ]
    }},
    navigator:{onLine:true},courierRouteFresh:true,escapeHtml:x=>String(x)
  });
  vm.runInContext(piece("function renderCourierMyRoute(){","async function ackCourierRoute("),ctx);
  vm.runInContext("renderCourierMyRoute()",ctx);
  assert.match(current.innerHTML,/Nova orientação do caixa/);
  assert.match(current.innerHTML,/ackCourierRoute\(9,3\)/);
  assert.match(current.innerHTML,/#101 → #102/);
  assert.match(current.innerHTML,/Confirme qualquer entrega/);
  assert.doesNotMatch(current.innerHTML,/route-stops/);
});

test("Address change triggers visible Ciente even with manual route feature idle",()=>{
  const node={innerHTML:""};
  const ctx=vm.createContext({
    $:id=>id==="courierMyRoute"?node:null,
    courierPreDeparture:{route:{
      dispatch_id:22,dispatch_status:"ON_ROAD",ack_required:true,route_version:4,
      last_change:{cause:"ADDRESS_CORRECTED"},stops:[
        {order_number:"#51",state:"PENDING",changed_unacked:true}
      ]
    }},
    navigator:{onLine:true},courierRouteFresh:true,escapeHtml:x=>String(x)
  });
  vm.runInContext(piece("function renderCourierMyRoute(){","async function ackCourierRoute("),ctx);
  vm.runInContext("renderCourierMyRoute()",ctx);
  assert.match(node.innerHTML,/Endereço atualizado pelo caixa/);
  assert.match(node.innerHTML,/Pedido\(s\): #51/);
  assert.match(node.innerHTML,/Ciente/);
});

test("Manual ordering editor captures exact pending set, version, audit reason and sends one PUT",async()=>{
  const elements={manualRouteEditor:{innerHTML:"",classList:{toggle(){}}},manualRouteReason:{value:"Pedido antigo com prioridade"},
    manualRouteMsg:{}};
  const calls=[];
  const ctx=vm.createContext({
    preDepartureAdminState:{routes:[{dispatch_id:61,route_version:7,stops:[
      {platform:"ifood",external_order_id:"A",order_number:"#A",platform_label:"iFood",state:"PENDING",address:{text:"Rua A"}},
      {platform:"anotaai",external_order_id:"B",order_number:"#B",platform_label:"Anota AI",state:"PENDING",address:{text:"Rua B"}},
      {platform:"ifood",external_order_id:"C",order_number:"#C",platform_label:"iFood",state:"DELIVERED"}
    ]}]},
    $:id=>elements[id],escapeHtml:x=>String(x),alert:()=>{},
    message:()=>{},loadPreDepartureAdmin:async()=>{},api:async(url,opts)=>{calls.push({url,opts});return{ok:true}},
    console
  });
  vm.runInContext(piece("let manualRouteState=null,manualRouteBusy=false;","async function lookupOrderAddress(){"),ctx);
  vm.runInContext("openManualRouteEditor(61)",ctx);
  assert.match(elements.manualRouteEditor.innerHTML,/#A/);
  assert.match(elements.manualRouteEditor.innerHTML,/#B/);
  assert.doesNotMatch(elements.manualRouteEditor.innerHTML,/#C/);
  vm.runInContext("moveManualRouteStop(1,-1)",ctx);
  elements.manualRouteReason.value="Pedido antigo com prioridade";
  await vm.runInContext("saveManualRouteEdit()",ctx);
  assert.equal(calls.length,1);
  assert.equal(calls[0].opts.method,"PUT");
  const body=JSON.parse(calls[0].opts.body);
  assert.equal(body.expected_route_version,7);
  assert.equal(body.reason,"Pedido antigo com prioridade");
  assert.deepEqual(body.sequence,["anotaai:B","ifood:A"]);
  assert.match(server,/expectedRouteVersion:\s*req\.body\?\.expected_route_version/);
  assert.match(service,/expectedRouteVersion\s*!==\s*null/);
  assert.match(service,/ROUTE_VERSION_CONFLICT/);
  assert.match(service,/ROUTE_NOT_ACTIVE/);
  assert.match(service,/const all = \(await routeStops\(client, dispatchId\)\)/);
});

test("Uncertain bag check reconciles saved state instead of asking for a second check",async()=>{
  let notice=0,refreshed=0;
  const ctx=vm.createContext({
    preDepartureBusy:false,preDepartureCheckingId:null,preDepartureMutationEpoch:0,
    courierPreDeparture:{pre_departure:{orders:[{id:10,checked:false}]}},
    PRE_DEPARTURE_OPEN:["CHECKED","PARTIALLY_CHECKED"],
    renderPreDeparture:()=>{},
    loadCourierPreDeparture:async()=>{
      refreshed++;
      vm.runInContext("courierPreDeparture.pre_departure.orders[0].checked=true",ctx);
    },
    message:()=>{notice++},
    console
  });
  vm.runInContext(piece("async function preDepartureAction(request,{checkingOrderId=null}={}){","function preDeparturePost(path,body={}){"),ctx);
  const result=await vm.runInContext("preDepartureAction(async()=>{throw Object.assign(new Error('timeout'),{code:'NETWORK_ERROR'})},{checkingOrderId:10})",ctx);
  assert.equal(result,true);
  assert.equal(refreshed,1);
  assert.equal(notice,0);
});

test("Dispatch and bags remain independent of automatic route planning",()=>{
  assert.match(html,/confirmPreDepartureDeparture\(\)/);
  assert.match(html,/togglePreDepartureBag\(\$\{Number\(o\.id\)\}\)/);
  assert.doesNotMatch(html,/Consultar roteiro sugerido/);
  assert.match(html,/current\.map\(courierDeliveryRow\)/);
  assert.match(service,/const allChecked = autoRouteEnabled &&/);
});


test("Address corrections invalidate a map pin after the destination changes",()=>{
  const save={disabled:false};
  const notices=[];
  let fields={street:"Rua Teste",number:"100",neighborhood:"Barcelona",city:"São Caetano",state:"SP",postal_code:"09550000"};
  const ctx=vm.createContext({
    addressFixState:{mode:"order",point:{latitude:-23.6,longitude:-46.5},location_signature:""},
    addressFixFields:()=>fields,$:id=>id==="addressFixSave"?save:null,
    message:(id,msg)=>notices.push(msg),String
  });
  vm.runInContext(piece("function addressFixLocationSignature(fields){","async function showAddressFixPoint(point,source){"),ctx);
  vm.runInContext("addressFixState.location_signature=addressFixLocationSignature(addressFixFields())",ctx);
  vm.runInContext("invalidateAddressFixLocation()",ctx);
  assert.equal(vm.runInContext("addressFixState.point",ctx).latitude,-23.6);
  fields={...fields,number:"200"};
  vm.runInContext("invalidateAddressFixLocation()",ctx);
  assert.equal(vm.runInContext("addressFixState.point",ctx),null);
  assert.equal(save.disabled,true);
  assert.ok(notices.some(x=>x.includes("novamente")));
  assert.match(html,/requested!==addressFixLocationSignature\(addressFixFields\(\)\)/);
  assert.match(html,/a.location_signature!==addressFixLocationSignature\(addressFixFields\(\)\)/);
});

console.log("Bags and manual route UI regression coverage registered");
