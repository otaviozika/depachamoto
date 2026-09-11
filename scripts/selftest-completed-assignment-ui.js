import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
// Exercise production form/card functions with a minimal DOM. No production APIs.
const nodes=new Map();
const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',style:{},classList:{toggle(){}},reset(){},required:false,readOnly:false});return nodes.get(id)};
let sent,refreshes=0,fullscreenExits=0;
const row={order_id:'complete-uuid',display_id:'4415',status:'CONCLUDED',delivered_by:'MERCHANT'};
const context=vm.createContext({$,Date,console,me:{role:'admin'},dashboard:{couriers:[{id:2,name:'Motoboy teste'}]},wallboardData:{orders:[row]},
  document:{fullscreenElement:{},exitFullscreen:async()=>{fullscreenExits++}},
  escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  kdsTimestamp:()=>null,kdsPrimaryText:()=>'',kdsSecondaryText:()=>'',kdsPreparationMarkup:()=>'',localTime:()=>'',
  message:(id,text)=>$(id).innerHTML=text,api:async(path,options)=>{sent={path,body:JSON.parse(options.body)};return {}},
  loadAdmin:async()=>{},loadWallboard:async()=>{refreshes++},loadCourier:async()=>{}
});
function include(start,end){const at=html.indexOf(start);vm.runInContext(html.slice(at,html.indexOf(end,at)),context)}
include('let routeOrderRecovery=','async function depart(e)');
include('function kdsOrderCard(','function renderKdsList(');
assert.match(context.kdsOrderCard(row,'CONFIRMED'),/Alocar motoboy/);
for(const blocked of [{...row,linked_dispatch_id:1},{...row,courier_name:'Já vinculado'},{...row,delivered_by:'IFOOD'}])assert.doesNotMatch(context.kdsOrderCard(blocked,'CONFIRMED'),/Alocar motoboy/);
context.me.role='courier';assert.doesNotMatch(context.kdsOrderCard(row,'CONFIRMED'),/Alocar motoboy/);context.me.role='admin';
await context.openUnassignedOrder(row.order_id);
assert.equal(fullscreenExits,1);assert.equal($('routeOrderNumber').value,'4415');assert.equal($('routeOrderNumber').readOnly,true);
$('routeCourier').value='2';$('routeReason').value='Entrega concluída sem vínculo';$('routeDepartureTime').value='2026-09-11T11:00';
await context.submitRouteOrder({preventDefault(){}});
assert.equal(sent.path,'/api/admin/dispatches/link-external');assert.equal(sent.body.ifood_order_id,'complete-uuid');
assert.equal(sent.body.courier_id,2);assert.deepEqual(sent.body.order_numbers,['4415']);assert.equal(refreshes,1);
assert.equal($('routeOrderModal').style.display,'none');assert.equal($('routeOrderSubmit').disabled,false);
context.openRouteOrderModal(true);assert.equal($('routeOrderNumber').readOnly,false);
$('routeOrderNumber').value='9000';await context.submitRouteOrder({preventDefault(){}});assert.equal(sent.body.ifood_order_id,undefined);
for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1]);
console.log('PASS completed assignment UI: button eligibility, exact UUID, fullscreen, form reset, submission, refresh and script syntax');
