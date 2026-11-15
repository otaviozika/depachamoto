import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const begin = html.indexOf("function setIfoodConfirmationMode(");
const end = html.indexOf("\nlet courierActiveDispatch=null;",begin);
assert.ok(begin !== -1 && end > begin);
const confirmationFunctions = html.slice(begin,end);
const baseline = process.argv.includes("--benchmark")
  ? execFileSync("git",["show","0de040a61b5e3ca09f0f2654a03bdc4b0911d6c9:public/index.html"],{encoding:"utf8"})
  : null;

function deferred(){
  let release;
  const promise=new Promise(resolve=>{release=resolve});
  return {promise,release};
}

function harness({
  post=async()=>({verified:true}),status=async()=>({state:"RECONCILING"}),
  refresh=async()=>{},code="1234",timers="fast", oldHtml
}={}){
  const fields={
    deliveryConfirmCode:{value:code,focus(){}},deliveryConfirmBtn:{disabled:false},
    deliveryConfirmOrderLabel:{},deliveryConfirmModal:{style:{display:"grid"}}
  };
  const results={messages:[],posts:0,gets:[],refreshes:0,closedAt:null};
  const context=vm.createContext({
    deliveryConfirmationTarget:{orderId:"first",displayId:"101"},courierDeliveryFeedbackTimer:null,
    activeIfoodConfirmationRequests:new Set(),uncertainIfoodConfirmations:new Set(),confirmedIfoodDeliveries:new Set(),
    $:id=>fields[id],AbortController,message:(id,text,type)=>results.messages.push({id,text,type}),
    api:async(url,options)=>{
      if(options?.method==="POST"){
        results.posts++;
        return post(url);
      }
      results.gets.push(url);
      return status(url);
    },
    queueCourierResourceRefresh:()=>{
      results.refreshes++;
      Promise.resolve().then(refresh).catch(()=>{});
    },
    loadCourier:refresh,loadCourierDeliveries:async()=>{},
    setTimeout:(fn,ms)=>{
      if([3500,5000,28000,80].includes(ms))return;
      if(timers==="real")return setTimeout(fn,ms);
      queueMicrotask(fn);
    },
    clearTimeout
  });
  const codeUnderTest=oldHtml
    ? oldHtml.slice(oldHtml.indexOf("function openDeliveryConfirmModal("),oldHtml.indexOf("\nlet courierActiveDispatch=null;"))
    : confirmationFunctions;
  vm.runInContext(codeUnderTest+`
    const closeOriginal=closeDeliveryConfirmModal;
    closeDeliveryConfirmModal=()=>{markClose();closeOriginal()};
    globalThis.submit=submitDeliveryConfirmation;
    globalThis.open=openDeliveryConfirmModal;
    globalThis.close=closeDeliveryConfirmModal;
  `,Object.assign(context,{markClose:()=>{results.closedAt??=performance.now()}}));
  return {fields,results,submit:()=>context.submit({preventDefault(){}}),open:context.open,close:context.close};
}

test("success closes the modal before dashboard completion, including dashboard failure",async()=>{
  const dashboard=deferred();
  const h=harness({refresh:async()=>{await dashboard.promise;throw Error("dashboard fetch failed")}});
  await h.submit();
  assert.equal(h.fields.deliveryConfirmModal.style.display,"none");
  assert.ok(h.results.messages.some(x=>x.id==="courierDeliveryFeedback"&&x.type==="ok"));
  assert.equal(h.results.refreshes,1);
  dashboard.release();
  await Promise.resolve();
  assert.ok(!h.results.messages.some(x=>x.type==="err"));
});

test("five rapid clicks, including close and reopen, issue one POST",async()=>{
  const gate=deferred();
  const h=harness({post:async()=>{await gate.promise;return {verified:true}}});
  const first=h.submit();
  assert.equal(h.fields.deliveryConfirmBtn.disabled,true);
  await h.submit();
  await h.submit();
  h.close();
  h.open("first","101");
  h.fields.deliveryConfirmCode.value="1234";
  await h.submit();
  await h.submit();
  gate.release();
  await first;
  assert.equal(h.results.posts,1);
});

test("a delayed response for one order cannot close or unlock a different order",async()=>{
  const first=deferred(),second=deferred();
  const h=harness({post:async url=>{await (url.includes("/first/")?first:second).promise;return {verified:true}}});
  const a=h.submit();
  h.close();
  h.open("second","102");
  h.fields.deliveryConfirmCode.value="1234";
  const b=h.submit();
  first.release();
  await a;
  assert.equal(h.fields.deliveryConfirmModal.style.display,"grid");
  assert.equal(h.fields.deliveryConfirmBtn.disabled,true);
  second.release();
  await b;
  assert.equal(h.fields.deliveryConfirmModal.style.display,"none");
  assert.equal(h.results.posts,2);
});

test("ambiguous reply and lost mobile data only consult the owned order",async()=>{
  for(const failure of ["ambiguous","network","422"]){
    const h=harness({
      post:async()=>{
        if(failure==="network")throw Object.assign(Error("offline"),{code:"NETWORK_ERROR"});
        if(failure==="422")throw Object.assign(Error("rejected"),{status:422});
        return {verified:false};
      },
      status:async()=>({verified:true,state:"CONCLUDED"})
    });
    await h.submit();
    assert.equal(h.results.posts,1);
    assert.deepEqual(h.results.gets,["/api/courier/ifood/orders/first/confirmation"]);
    assert.equal(h.fields.deliveryConfirmModal.style.display,"none");
  }
});

test("unavailable status keeps the next action read-only until retry is allowed",async()=>{
  let retryAllowed=false;
  const h=harness({
    post:async()=>{throw Object.assign(Error("offline"),{code:"NETWORK_ERROR"})},
    status:async()=>({verified:false,retry_allowed:retryAllowed})
  });
  await h.submit();
  assert.equal(h.fields.deliveryConfirmBtn.textContent,"Consultar status");
  await h.submit();
  assert.equal(h.results.posts,1);
  retryAllowed=true;
  await h.submit();
  assert.equal(h.results.posts,1);
  assert.equal(h.fields.deliveryConfirmBtn.textContent,"✅ Confirmar entrega");
});

test("explicit invalid code is shown and can be edited",async()=>{
  const h=harness({post:async()=>{throw Object.assign(Error("Código incorreto"),{code:"DELIVERY_CODE_INVALID"})}});
  await h.submit();
  assert.equal(h.results.messages.at(-1).text,"Código incorreto");
  assert.equal(h.fields.deliveryConfirmCode.value,"1234");
  assert.equal(h.fields.deliveryConfirmBtn.disabled,false);
});

test("invalid format cannot send a POST",async()=>{
  const h=harness({code:"123"});
  await h.submit();
  assert.equal(h.results.posts,0);
  assert.equal(h.results.messages.at(-1).type,"err");
});

if(baseline)test("benchmark: 40 simulated couriers per wave, 600 orders per revision",async()=>{
  function percentiles(values){
    values.sort((a,b)=>a-b);
    return {p50_ms:+values[299].toFixed(2),p95_ms:+values[569].toFixed(2)};
  }
  const samples={baseline:{success:[],closed:[]},candidate:{success:[],closed:[]}};
  for(let wave=0;wave<15;wave++){
    for(const name of wave%2?["candidate","baseline"]:["baseline","candidate"]){
      await Promise.all(Array.from({length:40},async(_,i)=>{
        const h=harness({
          oldHtml:name==="baseline"?baseline:undefined,timers:"real",
          post:async()=>{await wait(50+i%10*5);return {verified:true}},
          refresh:async()=>{await wait(250+i%10*25)}
        });
        const started=performance.now();
        const push=h.results.messages.push.bind(h.results.messages);
        h.results.messages.push=(...items)=>{
          if(items.some(x=>x.type==="ok"))samples[name].success.push(performance.now()-started);
          return push(...items);
        };
        await h.submit();
        while(h.results.closedAt===null)await wait(20);
        samples[name].closed.push(h.results.closedAt-started);
      }));
    }
  }
  for(const [name,{success,closed}] of Object.entries(samples)){
    assert.equal(success.length,600);
    console.log("IFOOD_UI_BENCH "+JSON.stringify({name,success:percentiles(success),modal_closed:percentiles(closed)}));
  }
});
