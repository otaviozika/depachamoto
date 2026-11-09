/**
 * Sexta-feira ficticia: 600 pedidos e 36 motoboys.
 * NAO acessa banco, APIs reais, clientes, production ou chaves.
 * Mede CPU REAL do planejador Node 22; tempos de rede sao INJETADOS, nao medidos na ORS.
 * Modela cota sem representar disponibilidade contratual real.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { planFastestViableRoute, planRoute, factorial } from "../lib/route-planner.js";
import { createOpenRouteServiceClient } from "../lib/route-providers.js";

const ORIGIN = Object.freeze({ latitude: -23.6244855, longitude: -46.5549218 });
const SIZE_PATTERNS = Object.freeze({
  singles: [1],
  mostly_single: [1,1,2,1,1,2,1,1,1,2],
  pair_heavy: [2,2,1,2,3,2,1,2,2,1],
  groups_up_to_five: [3,4,2,5,1,4,3,2]
});
const ORDERS = 600, COURIERS = 36;
let state = 0x5a17c0de;
const rnd = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
const fix = n => Number(n.toFixed(3));
function pct(xs, p) {
  if (!xs.length) return null;
  const sorted = xs.slice().sort((a,b)=>a-b);
  return fix(sorted[Math.max(0,Math.ceil(sorted.length*p/100)-1)]);
}
function stats(xs) {
  return { count:xs.length,p50_ms:pct(xs,50),p95_ms:pct(xs,95),p99_ms:pct(xs,99),max_ms:fix(Math.max(...xs)) };
}
function syntheticGroup(n, salt) {
  // Coordenadas geradas por PRNG; NAO sao enderecos verificados e NAO sao pedidos reais.
  const angle = rnd()*Math.PI*2, distance = 0.005 + rnd()*0.045;
  const center = {latitude:ORIGIN.latitude + distance*Math.sin(angle),longitude:ORIGIN.longitude + distance*Math.cos(angle)};
  const points = [ORIGIN];
  const stops = [];
  for(let i=0;i<n;i++) {
    points.push({latitude:center.latitude+(rnd()-.5)*.012,longitude:center.longitude+(rnd()-.5)*.012});
    // 20% com pedido antigo, 10% recentes; mistura de plataformas sem identificar clientes.
    const age = rnd()<.20 ? 50+rnd()*70 : rnd()*55;
    stops.push({key:`synthetic_${salt}_${i}`,age_minutes:fix(age)});
  }
  return {stops,points};
}
function syntheticRoadMatrix(points) {
  const n=points.length;
  const meters = Array.from({length:n},()=>Array(n).fill(0));
  const seconds = Array.from({length:n},()=>Array(n).fill(0));
  for(let i=0;i<n;i++) for(let j=0;j<n;j++) if(i!==j) {
    const a=points[i],b=points[j];
    const straight=Math.hypot((a.latitude-b.latitude)*111_000,(a.longitude-b.longitude)*101_900);
    // Malha viaria e sentido ficticios; representa assimestria sem afirmar trafego verdadeiro.
    const factor=1.12+(((i*13+j*7)%11)/35);
    const road=straight*factor+65;
    const kmh=22+((i*3+j*5)%12);
    meters[i][j]=Math.round(road);
    seconds[i][j]=Math.round(30+road/(kmh*1000/3600));
  }
  return {meters,seconds,minutes:seconds.map(row=>row.map(s=>s/60))};
}
function makeBatches(pattern) {
  const out=[];let served=0,i=0;
  while(served<ORDERS) {
    const size=Math.min(pattern[i%pattern.length],ORDERS-served);
    out.push(syntheticGroup(size,`${out.length}`));
    served+=size;i++;
  }
  assert.equal(out.reduce((s,x)=>s+x.stops.length,0),ORDERS);
  return out;
}
function checkPlan(group, matrix, plan) {
  assert.equal(plan.strategy,"FASTEST_VIABLE");
  assert.equal(plan.evaluated,factorial(group.stops.length));
  assert.equal(new Set(plan.best.order).size,group.stops.length);
  assert.deepEqual(plan.best.order.slice().sort((a,b)=>a-b),Array.from({length:group.stops.length},(_,i)=>i));
  assert.ok(plan.extra_minutes>=-1e-8 && plan.extra_minutes<=plan.max_extra_minutes+1e-7);
  assert.ok(plan.max_extra_minutes<=3+1e-8);
  assert.ok(plan.max_extra_minutes<=plan.fastest_duration_minutes*.10+1e-8);
  assert.ok(Number.isFinite(plan.best.cost));
  assert.ok(group.stops.every(s=>s.age_minutes>=0));
  if(group.stops.length>1){
    const again=planFastestViableRoute({stops:group.stops,minutes:matrix.minutes});
    assert.deepEqual(again.best.order,plan.best.order,"deve ser deterministico");
  }
}
const patterns={};
const pooledCPU=[];
const cpuByStop=Object.fromEntries([1,2,3,4,5].map(i=>[i,[]]));
let allOrders=0,allRoutes=0,uncachedPairs=0;
for(const [name,pat] of Object.entries(SIZE_PATTERNS)) {
  const groups=makeBatches(pat), cpu=[];
  let pairs=0,changesVsTyped=0,changesVsNearest=0,extraTotal=0,savedVsTyped=0,olderThan45=0;
  for(const group of groups){
    const matrix=syntheticRoadMatrix(group.points);
    const now=performance.now();
    const plan=planFastestViableRoute({stops:group.stops,minutes:matrix.minutes});
    const ms=performance.now()-now;
    cpu.push(ms);cpuByStop[group.stops.length].push(ms);pooledCPU.push(ms);
    checkPlan(group,matrix,plan);
    if(group.stops.length>1) {
      if(plan.best.order.some((n,i)=>n!==i))changesVsTyped++;
      const nearest=group.stops.map((_,i)=>matrix.meters[0][i+1]).indexOf(Math.min(...group.stops.map((_,i)=>matrix.meters[0][i+1])));
      if(plan.best.order[0]!==nearest)changesVsNearest++;
      savedVsTyped+=plan.saved_minutes_vs_typed;
    }
    extraTotal+=plan.extra_minutes;
    olderThan45+=group.stops.filter(s=>s.age_minutes>45).length;
    pairs+=group.stops.length*(group.stops.length+1); // pares direcionais sem cache
  }
  patterns[name]={
    orders:ORDERS,couriers:COURIERS,dispatches:groups.length,
    average_stops_per_dispatch:fix(ORDERS/groups.length),
    route_planner_cpu:stats(cpu), estimated_new_matrix_calls_if_cold:groups.length,
    estimated_new_cache_rows_if_cold:pairs,
    routes_reordered_from_typed:changesVsTyped,
    first_stop_differs_from_nearest_by_road_meters:changesVsNearest,
    sum_saved_vs_typed_minutes:fix(savedVsTyped),
    sum_extra_vs_absolute_fastest_minutes:fix(extraTotal),
    orders_already_older_than_45min:olderThan45
  };
  allOrders+=ORDERS;allRoutes+=groups.length;uncachedPairs+=pairs;
}
assert.equal(allOrders,ORDERS*Object.keys(SIZE_PATTERNS).length);
assert.ok(allRoutes>=1200,"cenario precisa exercer muitas rotas");

const five=syntheticGroup(5,"five_stop_peak"), fiveMatrix=syntheticRoadMatrix(five.points);
const fiveMs=[];
for(let i=0;i<80;i++)planFastestViableRoute({stops:five.stops,minutes:fiveMatrix.minutes});
for(let i=0;i<1600;i++){
  const begin=performance.now();
  const p=planFastestViableRoute({stops:five.stops,minutes:fiveMatrix.minutes});
  fiveMs.push(performance.now()-begin);
  assert.equal(p.evaluated,120);
}
const burstCPU=[];
for(let i=0;i<COURIERS;i++){
  const g=syntheticGroup(5,`courier-${i}`),m=syntheticRoadMatrix(g.points);
  const start=performance.now();planFastestViableRoute({stops:g.stops,minutes:m.minutes});
  burstCPU.push(performance.now()-start);
}

// Passagem REAL pela implementacao do cliente ORS, mas fetch injetado, sem internet.
function fakeHTTP(status, body) {
  return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)};
}
let accepted=0;
const mockFetch=async (_url, opts)=>{
  assert.ok(_url.endsWith("/openrouteservice/v2/matrix/driving-car"));
  const pts=JSON.parse(opts.body).locations.map(([longitude,latitude])=>({latitude,longitude}));
  assert.ok(pts.length>=2&&pts.length<=6);
  accepted++;
  const latency=120+((accepted-1)%6)*140; // ate 820ms de rede FICTICIA
  await new Promise(resolve=>setTimeout(resolve,latency));
  const m=syntheticRoadMatrix(pts);
  return fakeHTTP(200,{durations:m.seconds,distances:m.meters,
    sources:pts.map(()=>({snapped_distance:7})),destinations:pts.map(()=>({snapped_distance:7}))});
};
const mockClient=createOpenRouteServiceClient({apiKey:"SYNTHETIC_TEST_KEY",fetchFn:mockFetch});
const networkFull=[];
const syntheticWave=Array.from({length:COURIERS},(_,i)=>syntheticGroup(1+i%5,`wave-${i}`));
await Promise.all(syntheticWave.map(async g=>{
  const t=performance.now();
  const matrix=await mockClient.travelMatrix(g.points);
  const plan=planFastestViableRoute({stops:g.stops,minutes:matrix.seconds.map(row=>row.map(s=>s/60))});
  checkPlan(g,{minutes:matrix.seconds.map(row=>row.map(s=>s/60))},plan);
  networkFull.push(performance.now()-t);
}));
assert.equal(accepted,COURIERS,"36 chamadas sinteticas simultaneas");

let minuteRequests=0;
const limited=createOpenRouteServiceClient({apiKey:"SYNTHETIC_TEST_KEY",fetchFn:async (_url,opts)=>{
  const points=JSON.parse(opts.body).locations;
  if(++minuteRequests>40)return fakeHTTP(429,{error:"Simulated 40/min rate limit"});
  const n=points.length;
  return fakeHTTP(200,{durations:Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?0:180)),
    distances:Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?0:700))});
}});
const seventyTwo=await Promise.allSettled(Array.from({length:72},(_,i)=>limited.travelMatrix(syntheticGroup(1,`burst-${i}`).points)));
const rejected=seventyTwo.filter(x=>x.status==="rejected");
assert.equal(rejected.length,32);
assert.ok(rejected.every(x=>x.reason.code==="ROUTES_RATE_LIMITED"));
assert.equal(seventyTwo.filter(x=>x.status==="fulfilled").length,40);

const errors={};
for(const [name,status,expect] of [["invalid_key",401,"ROUTES_KEY_REJECTED"],["rate_limit",429,"ROUTES_RATE_LIMITED"],["provider_unavailable",503,"ROUTES_SERVICE_FAILED"]]){
 const c=createOpenRouteServiceClient({apiKey:"SYNTHETIC_TEST_KEY",fetchFn:async()=>fakeHTTP(status,{error:"simulated"})});
 await assert.rejects(c.travelMatrix(syntheticGroup(1,name).points),e=>e.code===expect);
 errors[name]="PASS";
}
const noLink=createOpenRouteServiceClient({apiKey:"SYNTHETIC_TEST_KEY",fetchFn:async()=>{throw new Error("synthetic timeout")}});
await assert.rejects(noLink.travelMatrix(syntheticGroup(1,"timeout").points),e=>e.code==="ROUTES_SERVICE_FAILED");
errors.network_failure="PASS";
assert.throws(()=>planFastestViableRoute({stops:five.stops,minutes:[[0]]}),e=>e.code==="ROUTE_MATRIX_INCOMPLETE");
errors.incomplete_matrix="PASS";
assert.throws(()=>planFastestViableRoute({stops:five.stops.slice(0,4),minutes:fiveMatrix.minutes}),e=>e.code==="ROUTE_MATRIX_INCOMPLETE");
errors.matrix_dimensions_invalid="PASS";
const missingTime=syntheticGroup(2,"missing-time");
missingTime.stops[0].age_minutes=null;
assert.throws(()=>planFastestViableRoute({stops:missingTime.stops,minutes:syntheticRoadMatrix(missingTime.points).minutes}),e=>e.code==="ROUTE_ORDER_TIME_MISSING");
errors.missing_order_time="PASS";

const shiftHours=5.5, speedSensitivity=[20,30,40,50,60].map(roundTripMin=>({
  assumed_round_trip_minutes:roundTripMin,
  theoretical_orders_at_2_per_trip:Math.floor(COURIERS*shiftHours*60/roundTripMin)*2,
  enough_for_600:Math.floor(COURIERS*shiftHours*60/roundTripMin)*2>=ORDERS
}));
const result={
  result:"PASS_SYNTHETIC_NOT_PRODUCTION_CERTIFICATION",
  test:"Friday 600 orders / 36 couriers / 5.5h concentrated dinner",
  policy:"FASTEST_VIABLE, <= min(10%, 3 minutes); up to 5 stops",
  simulated_only:true,real_customer_coordinates_used:false,real_provider_requests:0,production_database_access:false,
  stress:{scenarios:patterns,overall_cpu:stats(pooledCPU),
    by_stops:Object.fromEntries(Object.entries(cpuByStop).map(([k,v])=>[k,stats(v)])),
    five_stop_1600_repetitions:stats(fiveMs),burst_36_five_stop_cpu_total_ms:fix(burstCPU.reduce((a,b)=>a+b,0)),
    burst_36_five_stop_cpu_p95_ms:pct(burstCPU,95)},
  mock_network:{simultaneous_couriers:COURIERS,synthetic_provider_delay_ms_min:120,synthetic_provider_delay_ms_max:820,
    full_matrix_plus_algorithm:stats(networkFull),label:"latency INJECTED; no production HTTP, database, internet or GPS"},
  rate_limit_demo:{attempted_in_one_minute:72,limit_assumed:40,accepted:40,rejected_with_429:rejected.length,
    warning:"Current provider layer has no global rate limiter; API calls not equivalent to orders"},
  theoretical_fleet_capacity:{assumed_group_size:2,window_hours:shiftHours,
    required_average_trip_duration_for_600_orders_min:fix(COURIERS*shiftHours*60*2/ORDERS),
    sensitivity:speedSensitivity,warning:"algebraic ceiling, NOT field validation, prep times, travel, queue or rider availability"},
  negative_tests:errors,limitations:[
    "Nao mede latency HTTP real, Render, banco Supabase, iFood, AnotaAI ou rede do celular.",
    "Nao mede tempo real de percurso nem transito; coordenadas e vias inventadas.",
    "Cache precisa de consultas e ate n*(n+1) gravacoes por rota nova; nao medido em PostgreSQL neste teste.",
    "Cotas da conta HeiGIT e disponibilidade da chave de producao nao verificadas.",
    "36 chamadas paralelas sem limitador global podem provocar 429 em uma rajada acima da cota.",
    "O numero de entregas nao equivale ao numero de rotas: depende do agrupamento."
  ]
};
console.log("FRIDAY_600_SYNTHETIC_REPORT_START");
console.log(JSON.stringify(result,null,2));
console.log("FRIDAY_600_SYNTHETIC_REPORT_END");
