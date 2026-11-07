// Strictly local ORS Matrix deadline contract; no real keys or external calls.
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {configuredMatrixTimeout,createOpenRouteServiceClient,createTravelClient}
  from "../lib/route-providers.js";

const key="TEST-ONLY-NOT-A-SECRET";
const points=[
  {latitude:-23.62446,longitude:-46.55491},
  {latitude:-23.62100,longitude:-46.55200}
];
assert.equal(configuredMatrixTimeout({}),8000);
assert.equal(configuredMatrixTimeout({ORS_MATRIX_TIMEOUT_MS:"5000"}),5000);
assert.equal(configuredMatrixTimeout({ORS_MATRIX_TIMEOUT_MS:"20000"}),20000);
for(const value of ["0","4999","20001","eight seconds","9000.5","Infinity","-1"]){
  assert.equal(configuredMatrixTimeout({ORS_MATRIX_TIMEOUT_MS:value}),8000,"bad custom limit: "+value);
}
const testClient=createTravelClient({env:{OPENROUTESERVICE_API_KEY:key,ORS_MATRIX_TIMEOUT_MS:"6000"},
  fetchFn:async(_url,opts)=>{
    assert.equal(opts.signal instanceof AbortSignal,true);
    return new Response(JSON.stringify({durations:[[0,10],[12,0]],distances:[[0,100],[120,0]]}),
      {status:200,headers:{"content-type":"application/json"}});
  }});
assert.equal(testClient.provider,"openrouteservice");
assert.equal((await testClient.travelMatrix(points)).seconds[0][1],10);

const stallFetch=async(url,{signal})=>new Promise((_resolve,reject)=>{
  // Node AbortSignal.timeout uses an unref'ed timer. Hold this mock transport
  // open like a real network socket so the test does not exit with unsettled await.
  const guard=setTimeout(()=>reject(new Error("Mock failed to abort")),2000);
  if(signal.aborted){clearTimeout(guard);return reject(new Error("Abort confirmed"));}
  signal.addEventListener("abort",()=>{clearTimeout(guard);reject(new Error("Abort confirmed"));},{once:true});
});
const short=createOpenRouteServiceClient({apiKey:key,timeoutMs:350,matrixTimeoutMs:100,fetchFn:stallFetch});
const t1=performance.now();
await assert.rejects(short.travelMatrix(points),
  e=>e.code==="ROUTES_SERVICE_FAILED"&&!e.message.includes(key));
const matrixMs=Math.round(performance.now()-t1);
assert.ok(matrixMs>=65 && matrixMs<330,"Matrix deadline drift "+matrixMs);

const headersBody=createOpenRouteServiceClient({apiKey:key,timeoutMs:350,matrixTimeoutMs:110,
  fetchFn:async(_url,{signal})=>{
    const stream=new ReadableStream({start(controller){
      const guard=setTimeout(()=>controller.error(new Error("Mock body failed to abort")),2000);
      signal.addEventListener("abort",()=>{clearTimeout(guard);controller.error(new Error("Unfinished body"));},{once:true});
    }});
    return new Response(stream,{status:200,headers:{"content-type":"application/json"}});
  }
});
const t2=performance.now();
await assert.rejects(headersBody.travelMatrix(points),
  e=>e.code==="ROUTES_SERVICE_FAILED"&&!e.message.includes(key));
const bodyMs=Math.round(performance.now()-t2);
assert.ok(bodyMs>=70 && bodyMs<350,"Body deadline drift "+bodyMs);

const client=createOpenRouteServiceClient({apiKey:key,timeoutMs:350,matrixTimeoutMs:90,
  fetchFn:async(url,{signal})=>{
    assert.equal(new URL(url).pathname,"/pelias/v1/search");
    return new Promise((resolve,reject)=>{
      const tid=setTimeout(()=>resolve(new Response(JSON.stringify({features:[{
        geometry:{coordinates:[-46.553,-23.622]},
        properties:{layer:"address",confidence:1,match_type:"exact",label:"Test number 10"}
      }]}),{status:200,headers:{"content-type":"application/json"}})),165);
      signal.addEventListener("abort",()=>{clearTimeout(tid);reject(new Error("Abort"))},{once:true});
    });
  }
});
const t3=performance.now();
const address=await client.geocodeAddress("Rua Ficticia 10",points[0]);
assert.equal(address.precise,true,"Geocoding must retain 20s cap, separate from Matrix");
const geocodeMs=Math.round(performance.now()-t3);
assert.ok(geocodeMs>=120,"Geocode must not inherit short Matrix deadline");

console.log("ORS_TIMEOUT_CONTRACT_PASS "+JSON.stringify({
  matrixDeadlineDefaultMs:8000,geocodeDeadlineDefaultMs:20000,
  matrixStallObservedMs:matrixMs,bodyStallObservedMs:bodyMs,
  geocodingSeparateDeadlineConfirmed:true,configBounds:[5000,20000],
  realProviderCalls:0,productionTouched:false
}));
