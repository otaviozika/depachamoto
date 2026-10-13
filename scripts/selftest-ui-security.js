import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { appContentSecurityPolicy } from '../lib/ui-security.js';

const publicDir = new URL('../public/',import.meta.url).pathname;
const html = fs.readFileSync(path.join(publicDir,'index.html'),'utf8');
const registry = fs.readFileSync(path.join(publicDir,'ui-actions.js'),'utf8');
const events = new Map(), nodes = new Map(), calls = [];
const $ = id => {if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',disabled:false});return nodes.get(id);};
const context = vm.createContext({
  $, URLSearchParams, document:{addEventListener:(type,run)=>events.set(type,run)},
  console:{error:()=>{}},localTime:()=> '12:00',localDate:()=> '05/10/2026',
  dashboard:{couriers:[]}, attendanceState:{summary:{},rows:[]},
  resetCourierPassword:(...args)=>calls.push(['reset',...args]),
  checkoutCourier:(...args)=>calls.push(['checkout',...args]),
  confirmAnotaAiDelivery:(...args)=>calls.push(['anota',...args]),
  openDeliveryConfirmModal:(...args)=>calls.push(['ifood',...args]),
  activateAdminPage:(...args)=>calls.push(['navigate',...args])
});
function include(start,end){
  const at=html.indexOf(start),to=html.indexOf(end,at+start.length);
  assert.ok(at>=0&&to>at,'Cannot extract actual renderer: '+start);
  vm.runInContext(html.slice(at,to),context);
}
include('function escapeHtml(','\n');
include('function uiActionArgs(','\n');
include('function approvalBadge(','async function verifyCourierPix(');
include('function attendanceMethodLabel(','function updateAttendanceQrCountdown(');
include('function courierDeliveryBadge(','async function loadCourierDeliveries(');
vm.runInContext(registry,context);
let checks=0;
function check(ok,label){assert.ok(ok,label);checks++;}
const decode = value=>value.replace(/&(quot|#39|lt|gt|amp);/g,(_,entity)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[entity]));
function dispatch(markup,label){
  const button=[...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(x=>x[0].includes('>'+label+'</button>'))?.[0];
  assert.ok(button,'Actual button not rendered: '+label);
  const attributes=Object.fromEntries([...button.matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],decode(x[2])]));
  assert.ok(!Object.keys(attributes).some(name=>/^on/i.test(name)),'No executable attribute on rendered button');
  const element={disabled:false,getAttribute:name=>attributes[name]??null};
  events.get('click')({target:{closest:()=>element},preventDefault:()=>{}});
  return calls.at(-1);
}

for(const name of ["');globalThis.attackerExecuted=true;//","'-globalThis.attackerExecuted=true-'",'O\'Brien "&<>',
  '<img src=x onerror=globalThis.attackerExecuted=true>', '</script><script>globalThis.attackerExecuted=true</script>',
  '&#39;);globalThis.attackerExecuted=true;//', 'José 🛵\\\nU+2028:\u2028']){
  context.attackerExecuted=false;
  context.dashboard.couriers=[{id:42,name,username:'synthetic',approval_status:'PENDING',active:true,today_count:0,operational_status:'AUSENTE'}];
  context.renderCouriers();
  check(JSON.stringify(dispatch($('courierTable').innerHTML,'Resetar senha'))===JSON.stringify(['reset',42,name]),'Courier name is exact data, not executable code');
  context.attendanceState={date:'2026-10-05',summary:{},rows:[{courier_id:42,name,username:'synthetic',present:true,attended:true}]};
  context.renderAttendance();
  check(JSON.stringify(dispatch($('attendanceTable').innerHTML,'Encerrar expediente'))===JSON.stringify(['checkout',42,name]),'Checkout name is exact data, not executable code');
  check(context.attackerExecuted===false,'Stored attack does not execute');
}
for(const platform of ['ifood','anotaai']){
  const order_id="id');globalThis.attackerExecuted=true;//", display_id='quote"<>&\'test';
  const row=context.courierDeliveryRow({platform,order_id,display_id,can_confirm:true,state:'WAITING_CONFIRMATION'});
  const result=dispatch(row,'✅ Confirmar entrega');
  check(JSON.stringify(result)===JSON.stringify([platform==='ifood'?'ifood':'anota',order_id,display_id]),'External order identifiers remain exact data');
}
const before=calls.length;
for(const [id,args] of [['__proto__','[]'],['missing','[]'],['a645296c932684b','{"id":42}'],['a645296c932684b','not JSON'],['a645296c932684b','[42]']]){
  events.get('click')({target:{closest:()=>({getAttribute:name=>name.endsWith('-args')?args:id})}});
}
check(calls.length===before,'Unknown/prototype actions and malformed argument lists are rejected');
const knownActions=new Set([...registry.matchAll(/"(a[0-9a-f]+)": \{/g)].map(match=>match[1]));
const templates=[html,fs.readFileSync(path.join(publicDir,'password-recovery.js'),'utf8'),
  fs.readFileSync(new URL('./apply-password-recovery-frontend.js',import.meta.url),'utf8'),
  fs.readFileSync(new URL('./apply-payment-clean-sheet.js',import.meta.url),'utf8')];
const bindings=templates.flatMap(source=>[...source.matchAll(/data-ui-(?:click|change|input|submit|keydown)="(a[0-9a-f]+)"/g)].map(match=>match[1]));
check(bindings.length>100&&bindings.every(id=>knownActions.has(id)),'Every served/generated declarative binding refers to a trusted registered action');

const policy=appContentSecurityPolicy(publicDir,true);
check(policy.directives.scriptSrcAttr.join(' ')==="'none'",'CSP prohibits every inline handler');
check(!policy.directives.scriptSrc.includes("'unsafe-inline'")&&!policy.directives.scriptSrc.includes("'unsafe-eval'"),'CSP grants no inline/eval blanket permission');
check(policy.directives.scriptSrc.every(value=>value==="'self'"||value.startsWith("'sha256-")),'Scripts require own origin or an exact trusted hash, no external CDN');
const vendor=fs.readFileSync(path.join(publicDir,'vendor/qrcode.min.js'));
check(html.includes('integrity="sha384-'+crypto.createHash('sha384').update(vendor).digest('base64')+'"'),'Vendored QR library matches its pinned integrity hash');
for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
  if(/\bsrc\s*=/.test(script[1])||!script[2].trim())continue;
  const hash="'sha256-"+crypto.createHash('sha256').update(script[2]).digest('base64')+"'";
  check(policy.directives.scriptSrc.includes(hash),'Every trusted inline script has an exact CSP hash');
}
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'despachefull-ui-security-'));
try{
  fs.writeFileSync(path.join(fixture,'ui-actions.js'),'');fs.writeFileSync(path.join(fixture,'password-recovery.js'),'');
  for(const handler of ['onclick="alert(1)"','onerror=alert(1)',"OnLoad = 'alert(1)'"]){
    fs.writeFileSync(path.join(fixture,'index.html'),'<img '+handler+'>');
    assert.throws(()=>appContentSecurityPolicy(fixture),/Unsafe inline event/);checks++;
  }
}finally{fs.rmSync(fixture,{recursive:true});}
console.log(`UI security self-test passed: ${checks}/${checks}. Actual courier/attendance/delivery renderers, trusted dispatch, malicious quotes/HTML and fail-closed CSP.`);
