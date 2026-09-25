import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/courier-dark.css',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../public/service-worker.js',import.meta.url),'utf8');
const copied=[];
const context=vm.createContext({
  URLSearchParams,
  localTime:()=> '21:07:47',
  navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},
  window:{setTimeout:()=>{}}
});
function include(source,start,end){
  const at=source.indexOf(start),to=source.indexOf(end,at+start.length);
  assert.ok(at>=0&&to>at,'Unable to extract '+start);
  vm.runInContext(source.slice(at,to),context);
}
include(server,'function parseJsonPayload(','function normalizeDeliveryCode(');
include(html,'function escapeHtml(','\n');
include(html,'function courierDeliveryBadge(','async function loadCourierDeliveries(');

const payload={
  customer:{name:'  João Pedro  '},
  delivery:{deliveryAddress:{
    streetName:'Rua Conselheiro Lafayette',streetNumber:'799',complement:'Apto 91',
    neighborhood:'Barcelona',city:'São Caetano do Sul',state:'SP'
  }}
};
assert.equal(context.buildOrderCustomerName(payload),'João Pedro');
assert.equal(context.buildOrderCustomerName(JSON.stringify(payload)),'João Pedro');
assert.equal(context.buildOrderCustomerName({customer:{firstName:'Ana',lastName:'Clara'}}),'Ana Clara');
assert.equal(context.buildOrderCustomerName({customer:{name:''}}),'');
assert.equal(JSON.stringify(context.buildIfoodDeliveryAddressParts(payload)),JSON.stringify({
  street:'Rua Conselheiro Lafayette',number:'799'
}));
assert.equal(context.buildIfoodDeliveryAddressParts({}),null);

const cardBase={
  display_id:'2783',platform:'ifood',state:'CONCLUDED',can_confirm:false,
  customer_name:context.buildOrderCustomerName(payload),
  address_parts:context.buildIfoodDeliveryAddressParts(payload),
  navigation:context.buildIfoodDeliveryDestination(payload),
  delivery_details:context.buildIfoodDeliveryDetails(payload)
};
const card=context.courierDeliveryRow(cardBase);
assert.match(card,/#2783/);
assert.match(card,/Cliente<\/span><strong class="delivery-info-value">João Pedro/);
assert.match(card,/Rua Conselheiro Lafayette/);
assert.match(card,/delivery-address-number[^>]*>799/);
assert.match(card,/Complemento:.*Apto 91/);
assert.match(card,/Copiar endereço completo/);
assert.match(card,/Ir para o Waze/);
assert.match(card,/Ir no Google Maps/);
assert.ok(card.indexOf('João Pedro')<card.indexOf('Rua Conselheiro Lafayette'));
assert.ok(card.indexOf('Apto 91')<card.indexOf('Copiar endereço completo'));

const escaped=context.courierDeliveryRow({...cardBase,customer_name:'<img src=x onerror=alert(1)>'});
assert.doesNotMatch(escaped,/<img src=x onerror/);
assert.match(escaped,/&lt;img src=x onerror/);
const missing=context.courierDeliveryRow({...cardBase,customer_name:'',navigation:null,address_parts:null});
assert.match(missing,/Não informado/);
assert.doesNotMatch(missing,/Copiar endereço completo|Ir para o Waze|Ir no Google Maps/);
const anotaCard=context.courierDeliveryRow({
  ...cardBase,display_id:'3761',platform:'anotaai',customer_name:'Ana Clara',
  state:'WAITING_CONFIRMATION',can_confirm:true,order_id:'anota-test'
});
assert.match(anotaCard,/Ana Clara/);
assert.match(anotaCard,/confirmAnotaAiDelivery/);
assert.doesNotMatch(anotaCard,/openDeliveryConfirmModal/);

const copyButton=context.courierDeliveryCopyButton(cardBase);
assert.match(copyButton,/data-address="[^"]*Rua Conselheiro Lafayette[^"]*Apto 91/);
const label={textContent:'Copiar endereço completo',isConnected:true};
await context.copyCourierAddress({
  dataset:{address:'Rua Conselheiro Lafayette, 799, Apto 91'},
  querySelector:()=>label
});
assert.deepEqual(copied,['Rua Conselheiro Lafayette, 799, Apto 91']);
assert.equal(label.textContent,'Endereço copiado!');

context.canonicalIfoodOrderStatus=value=>value;
context.deliveryConfirmationLabel=value=>value;
context.courierDeliveryUiState=()=>({state:'CONCLUDED',can_confirm:false,message:'Concluído'});
context.pool={query:async sql=>{
  if(sql.includes('FROM ifood_dispatch_links')){
    return {rows:[{
      order_id:'ifood-test',display_id:'2783',local_order_number:'#2783',status:'CONCLUDED',
      order_status:'CONCLUDED',dispatch_status:'RELEASED',payload,confirmation_status:'VERIFIED'
    }]};
  }
  assert.match(sql,/a\.customer_name/);
  return {rows:[{
    order_id:'anota-test',display_id:'3761',local_order_number:'#3761',order_status:'FINISHED',
    dispatch_status:'RELEASED',customer_name:' Ana Clara ',payload:{customer:{name:'fallback'}}
  }]};
}};
include(server,'async function getCourierIfoodDeliveries(','async function acknowledgeIfoodEvents(');
const ifood=await context.getCourierIfoodDeliveries(42);
assert.equal(ifood.completed[0].customer_name,'João Pedro');
assert.equal(ifood.completed[0].address_parts.number,'799');
const anota=await context.getCourierAnotaAiDeliveries(42);
assert.equal(anota.completed[0].customer_name,'Ana Clara');
assert.match(context.courierDeliveryRow(anota.completed[0]),/Ana Clara/);

assert.match(css,/\.delivery-customer-row/);
assert.match(css,/\.delivery-address-number/);
assert.match(css,/padding-bottom:calc\(110px/);
assert.match(sw,/approved-delivery-card-v1/);
for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){
  if(script[1].trim())new vm.Script(script[1]);
}
console.log('PASS courier customer card: real names from both platforms, split address, copy button, navigation, safe rendering, responsive styles and JS syntax');
