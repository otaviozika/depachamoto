import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { normalizeAnotaAiOrder } from '../lib/anotaai.js';

export const readServer = root => fs.readFileSync(new URL('../server.js', root), 'utf8');
export const plain = value => JSON.parse(JSON.stringify(value));
export function include(context, source, start, end) {
  const at=source.indexOf(start), to=source.indexOf(end,at+start.length);
  assert.ok(at>=0 && to>at,'Extraction failed: '+start);
  vm.runInContext(source.slice(at,to),context);
}
export function deliveryContext(source,query) {
  const context=vm.createContext({Date,console,URLSearchParams,process:{env:{}},pool:{query}});
  include(context,source,'const IFOOD_ORDER_STATUS_VALUES =','async function upsertIfoodOrderFromDetails(');
  include(context,source,'function canonicalIfoodOrderStatus(','async function refreshIfoodOrderClassificationForDeparture(');
  include(context,source,'function parseJsonPayload(','function normalizeDeliveryCode(');
  include(context,source,'function deliveryConfirmationLabel(','async function acknowledgeIfoodEvents(');
  return context;
}
export function anotaContext(source,query,docs,{getOrder}={}) {
  const context=vm.createContext({Date,console,pool:{query},normalizeAnotaAiOrder,
    anotaAiSafeError:error=>error.message,createNotification:async()=>{},
    anotaAiClient:{listOrders:async()=>({info:{docs,count:docs.length,limit:1000}}),
      getOrder:getOrder||(async()=>{throw new Error('Unchanged orders must not refetch details');})}
  });
  include(context,source,'function validAnotaAiDate(','async function syncAnotaAiOnce(');
  return context;
}
export function payloadFixture(n=0,itemCount=12) {
  return {id:'synthetic-'+n,customer:{name:'Cliente Teste '+n,phone:{number:'000000000'},documentNumber:'SYNTHETIC'},
    delivery:{deliveryAddress:{streetName:'Rua de Teste',streetNumber:String(100+n),
      complement:'Bloco B, apto '+n,reference:'Portaria',neighborhood:'Barcelona',city:'São Caetano do Sul',
      state:'SP',postalCode:'09550000',coordinates:{latitude:-23.62,longitude:-46.55}},observations:'Tocar interfone'},
    payments:{pending:29.80,methods:[{method:'CREDIT',prepaid:false,value:29.80,card:{brand:'VISA'}}]},
    items:Array.from({length:itemCount},(_,i)=>({id:'item-'+i,name:'Hambúrguer de teste '+i,quantity:1,
      observations:'Observação destinada à cozinha '+'.'.repeat(80),options:[{name:'Adicional de teste',value:6}],
      unitPrice:29.80,totalPrice:29.80})),total:{orderAmount:29.80},unneeded:'x'.repeat(200)};
}
export async function seedDeliveries(query,{couriers=30,perCourier=18,payloads}={}) {
  await query("INSERT INTO users(id,name,username,password_hash,role,approval_status,active,must_change_password) VALUES(1,'Admin Teste','egress_admin','synthetic','admin','APPROVED',TRUE,FALSE) ON CONFLICT(id) DO NOTHING");
  for(let c=0;c<couriers;c++) {
    const id=c+2;
    await query("INSERT INTO users(id,name,username,password_hash,role,approval_status,active,must_change_password) VALUES($1,$2,$3,'synthetic','courier','APPROVED',TRUE,FALSE) ON CONFLICT(id) DO NOTHING",[id,'Motoboy Teste '+id,'egress_'+id]);
    for(let j=0;j<(payloads?.length||perCourier);j++) {
      const n=c*10000+j, order='egress-'+n, status=['DISPATCHED','CONCLUDED','CANCELLED','READY_TO_PICKUP'][j%4];
      const d=(await query("INSERT INTO dispatches(dispatch_code,order_number,courier_id,departed_at,status) VALUES($1,$2,$3,NOW()-INTERVAL '1 hour',$4) RETURNING id",[order,'#'+n,id,j===0?'ON_ROAD':'RELEASED'])).rows[0];
      await query("INSERT INTO ifood_orders(order_id,display_id,merchant_id,status,order_type,delivered_by,payload) VALUES($1,$2,'synthetic-shop',$3,'DELIVERY','MERCHANT',$4::jsonb)",[order,String(n),status,JSON.stringify(payloads?payloads[j]:payloadFixture(n))]);
      await query("INSERT INTO ifood_dispatch_links(ifood_order_id,dispatch_id,local_order_number,ifood_dispatch_status) VALUES($1,$2,$3,'DISPATCHED')",[order,d.id,'#'+n]);
      await query("INSERT INTO dispatch_orders(dispatch_id,order_number,platform) VALUES($1,$2,'ifood')",[d.id,'#'+n]);
    }
  }
}
export function frontendHarness(html,{id=2,hidden=false,holdDashboard=false,holdDeliveries=false,failDashboard=false}={}) {
  let now=0,nextId=0;const timers=new Map(),handlers=new Map(),counts={dashboard:0,deliveries:0},times=[];
  let releaseDashboard,releaseDeliveries;
  const dashboardGate=new Promise(r=>{releaseDashboard=r}),deliveriesGate=new Promise(r=>{releaseDeliveries=r});
  class ClockDate extends Date {static now(){return now;}}
  const context=vm.createContext({Date:ClockDate,console:{warn(){}},
    setTimeout:(fn,delay)=>{const token=++nextId;timers.set(token,{at:now+delay,fn});return token;},
    clearTimeout:token=>timers.delete(token),document:{hidden},me:{id,role:'courier'},
    $:()=>({classList:{contains:()=>false}}),socket:{on:(event,fn)=>handlers.set(event,fn)},
    loadCourier:async()=>{counts.dashboard++;times.push({kind:'dashboard',at:now});if(holdDashboard)await dashboardGate;if(failDashboard)throw new Error('Synthetic dashboard failure');},
    loadCourierDeliveries:async()=>{counts.deliveries++;times.push({kind:'deliveries',at:now});if(holdDeliveries)await deliveriesGate;},
    loadMyPayment:async()=>{},loadMyPix:async()=>{}
  });
  include(context,html,'const realtimeRefreshState=new Map();','const socket=io(');
  include(context,html,"socket.on('dispatch:changed'","socket.on('security:changed'");
  async function settle(){for(let i=0;i<12;i++)await Promise.resolve();}
  async function advance(ms){const end=now+ms;while(true){const pending=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!pending)break;now=pending[1].at;timers.delete(pending[0]);pending[1].fn();await settle();}now=end;await settle();}
  return {context,counts,times,handlers,advance,settle,releaseDashboard,releaseDeliveries,
    hide:value=>{context.document.hidden=value;},flushVisible:()=>context.flushVisibleRealtimeRefreshes(),
    event:(name,body={})=>handlers.get(name)?.(body)};
}
export async function confirmationEvents(server,courierId) {
  const events=[];const context=vm.createContext({req:{session:{user:{id:courierId}}},row:{order_id:'synthetic'},markConfirmedIncident:async()=>0,emitRealtime:(event,body={})=>events.push({event,body:plain(body)})});
  const from=server.indexOf('"IFOOD_DELIVERY_CODE_VERIFIED"'),at=server.indexOf('    emitRealtime("ifood:changed"',from),to=server.indexOf('    await maybeAutoMarkDispatchReturning',at);
  assert.ok(from>=0&&at>from&&to>at);
  await vm.runInContext('(async()=>{'+server.slice(at,to)+'})()',context);
  // This is the completion event emitted by the shared local finalization flow.
  events.push({event:'dispatch:changed',body:{courier_id:courierId,change:'COMPLETED'}});
  return events;
}
