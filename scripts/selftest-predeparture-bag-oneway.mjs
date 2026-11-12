import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const section=(start,next)=>{
  const i=html.indexOf(start);
  const j=html.indexOf(next,i+start.length);
  assert.ok(i>0&&j>i, "expected UI function "+start);
  return html.slice(i,j).trim();
};
const toggle=section("function togglePreDepartureBag(orderId){","function calculatePreDepartureRoute(retry){");
const render=section("function renderPreDeparture(){","async function preDepartureAction(request,");
const action=section("async function preDepartureAction(request,","function preDeparturePost(path,body={}){");
const refresh=section("async function loadCourierPreDeparture(){","const INCIDENT_LABELS=");

test("Inline UI JavaScript remains syntactically valid",()=>{
 const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
 assert.ok(scripts.length>0);
 for(const script of scripts)new vm.Script(script,{filename:"public/index.html"});
});

test("Confirmed bag is one-way: second touch and double tap never POST unchecked=false",async()=>{
 let calls=[],reRenders=0;
 const ctx=vm.createContext({Number,console});
 vm.runInContext(`
   const courierPreDeparture={pre_departure:{
     id:99,composition_version:1,orders:[{id:10,checked:false},{id:20,checked:true}]
   }};
   let preDepartureBusy=false;
   function renderPreDeparture(){reRenders++;}
   function preDeparturePost(path,body){calls.push({path,body});return Promise.resolve({})}
   function preDepartureAction(request){if(preDepartureBusy)return;preDepartureBusy=true;return request();}
 `,Object.assign(ctx,{calls,get reRenders(){return reRenders},set reRenders(v){reRenders=v}}));
 vm.runInContext(toggle,ctx);
 vm.runInContext("togglePreDepartureBag(20);togglePreDepartureBag(10);togglePreDepartureBag(10);",ctx);
 await Promise.resolve();
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.checked,true);
 assert.equal(calls[0].body.composition_version,1);
 assert.match(calls[0].path,/\/orders\/10\/check/);
});

test("Checked bag remains disabled and saving state is visible",()=>{
 const element={innerHTML:"",classList:{toggle(){}}};
 const refs={preDepartureCard:element,departureCard:{classList:{toggle(){}}}};
 const ctx=vm.createContext({
   courierPreDeparture:{enabled:{pre_departure:true},pre_departure:{
     id:3,counts:{total:2,checked:1},status:"PARTIALLY_CHECKED",
     route_valid:false,route:null,ack_required:false,
     orders:[{id:10,order_number:"#10",platform:"ifood",platform_label:"iFood",checked:true},
     {id:20,order_number:"#20",platform:"anotaai",platform_label:"AnotaAI",checked:false}]
   }},
   preDepartureBusy:false,preDepartureCheckingId:null,me:{name:"TEST"},
   PRE_DEPARTURE_OPEN:[],preDepartureRouteHtml:()=>"",preDepartureMinutes:()=>"",
   updateCourierDepartureEligibility:()=>{},escapeHtml:x=>String(x),
   $:k=>refs[k]
 });
 vm.runInContext(render,ctx);
 vm.runInContext("renderPreDeparture()",ctx);
 assert.match(element.innerHTML,/onchange="togglePreDepartureBag\(10\)"/);
 assert.match(element.innerHTML,/<input type="checkbox" checked disabled onchange="togglePreDepartureBag\(10\)"/);
 assert.match(element.innerHTML,/onchange="togglePreDepartureBag\(20\)"/);
 assert.doesNotMatch(element.innerHTML,/onchange="togglePreDepartureBag\(20,this.checked\)"/);
 vm.runInContext("preDepartureBusy=true;preDepartureCheckingId=20;renderPreDeparture()",ctx);
 assert.match(element.innerHTML,/Salvando confirmação/);
 assert.match(element.innerHTML,/<input type="checkbox"  disabled onchange="togglePreDepartureBag\(20\)"/);
});

test("Stale refresh started before a mutation cannot overwrite checked bags",async()=>{
 let resolveFetch,renderCount=0;
 const fetchPromise=new Promise(resolve=>resolveFetch=resolve);
 const old={pre_departure:{orders:[{id:1,checked:true}]}};
 const ctx=vm.createContext({
   me:{role:"courier"},courierPreDeparture:old,courierRouteFresh:true,
   preDepartureMutationEpoch:0,preDepartureBusy:false,
   api:()=>fetchPromise,renderPreDeparture:()=>{renderCount++},
   renderCourierMyRoute:()=>{}
 });
 vm.runInContext(refresh,ctx);
 const op=vm.runInContext("loadCourierPreDeparture()",ctx);
 vm.runInContext("preDepartureMutationEpoch++",ctx);
 resolveFetch({pre_departure:{orders:[{id:1,checked:false}]}});
 await op;
 assert.strictEqual(vm.runInContext("courierPreDeparture",ctx),old);
 assert.equal(renderCount,0);
});

test("Failed or uncertain save reloads authoritative server state before asking to repeat",()=>{
 assert.match(action,/preDepartureMutationEpoch\+\+/);
 assert.match(action,/preDepartureCheckingId=null/);
 assert.match(action,/NETWORK_ERROR/);
 assert.match(action,/await loadCourierPreDeparture\(\)/);
});
