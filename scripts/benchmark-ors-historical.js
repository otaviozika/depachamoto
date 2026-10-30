/**
 * Benchmark viario HISTORICO: 50 entregas individuais + 40 duplas de iFood.
 * Nao altera producao: SQL BEGIN READ ONLY, sem nomes, enderecos, pedidos ou IDs em logs.
 * Servico viario: openrouteservice (perfil driving-car, sem trafego historico/moto).
 *
 * Execucao SOMENTE em maquina de testes autorizada com Node 22 e npm install:
 *  DATABASE_URL=... OPENROUTESERVICE_API_KEY=... STORE_LAT=... STORE_LON=...
 *  STORE_ORIGIN_VERIFIED=YES HISTORICAL_BENCHMARK_CONFIRM=READ_ONLY
 *  node scripts/benchmark-ors-historical.js
 * Teste desconectado: node scripts/benchmark-ors-historical.js --selftest
 *
 * O punto da loja codificado em LONGE_STORE.approx NAO serve como GPS confirmado.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { createOpenRouteServiceClient } from "../lib/route-providers.js";
import { LONGE_STORE, haversineMeters } from "../lib/longe-zone.js";
import { planRoute } from "../lib/route-planner.js";

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const round = (value,n=2) => Number.isFinite(value) ? Number(value.toFixed(n)) : null;
const median = data => quantile(data,0.5);
function quantile(data,p) {
  const a=data.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return null;
  const at=(a.length-1)*p,i=Math.floor(at),j=Math.ceil(at);
  return a[i]+(a[j]-a[i])*(at-i);
}
function spread(list,n) {
  if(list.length<=n)return list.slice();
  return Array.from({length:n},(_,i)=>list[Math.floor((i+0.5)*list.length/n)]);
}
function checkPoint(point) {
  return Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) &&
    point.latitude>-25 && point.latitude<-22 && point.longitude>-48 && point.longitude<-45;
}
function toStop(row,departed) {
  const latitude=Number(row.latitude),longitude=Number(row.longitude);
  const created=Date.parse(row.order_created_at),confirmed=Date.parse(row.confirmed_at);
  const age=(departed-created)/60000;
  if(!checkPoint({latitude,longitude})||!Number.isFinite(created)||age<0||age>240)return null;
  return {latitude,longitude,age_minutes:age,
    confirmation_minutes:Number.isFinite(confirmed)?(confirmed-departed)/60000:null};
}
function categorize(rows) {
  const singles=[],pairs=[];
  for(const row of rows){
    const departed=Date.parse(row.departed_at);
    if(!Number.isFinite(departed)||!Array.isArray(row.stops)||row.stops.length!==Number(row.total_legs))continue;
    if(!row.stops.every(s=>s.platform==="ifood"))continue; // nunca confundir dupla mista com dupla iFood
    const list=row.stops.map(r=>toStop(r,departed));
    if(list.some(s=>!s))continue;
    if(list.length===1)singles.push(list[0]);
    if(list.length===2)pairs.push(list);
  }
  return {singles,pairs};
}
const HISTORICAL_SQL=[
"WITH legs AS (",
" SELECT d.id AS dispatch_id, d.departed_at, q.platform, o.order_id, o.order_created_at,",
" o.payload#>>'{delivery,deliveryAddress,coordinates,latitude}' AS latitude,",
" o.payload#>>'{delivery,deliveryAddress,coordinates,longitude}' AS longitude,",
" c.concluded_at AS confirmed_at",
" FROM dispatches d",
" JOIN dispatch_orders q ON q.dispatch_id=d.id",
" LEFT JOIN ifood_dispatch_links l ON q.platform='ifood' AND l.dispatch_id=d.id AND l.local_order_number=q.order_number",
" LEFT JOIN ifood_orders o ON o.order_id=l.ifood_order_id",
" LEFT JOIN ifood_delivery_confirmations c ON c.dispatch_id=d.id AND c.ifood_order_id=o.order_id",
" WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date",
"), runs AS (",
" SELECT dispatch_id, max(departed_at) AS departed_at, count(*) AS total_legs,",
" jsonb_agg(jsonb_build_object('platform',platform,'latitude',latitude,'longitude',longitude,",
" 'order_created_at',order_created_at,'confirmed_at',confirmed_at) ORDER BY order_created_at NULLS LAST,order_id) AS stops",
" FROM legs GROUP BY dispatch_id",
") SELECT departed_at,total_legs,stops FROM runs WHERE total_legs IN (1,2) ORDER BY departed_at"
].join("\n");

async function selectHistory(dbUrl,date) {
  const client=new pg.Client({connectionString:dbUrl,connectionTimeoutMillis:12000,statement_timeout:25000});
  try{
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '25s'");
    const q=await client.query(HISTORICAL_SQL,[date]);
    await client.query("ROLLBACK");
    return q.rows;
  } catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    // Nunca exibir URI, usuario, host ou dados de clientes.
    throw new Error("Falha na leitura do historico PostgreSQL (SQLSTATE "+String(e.code||"unknown")+").");
  } finally { await client.end().catch(()=>{}); }
}
function matrixValid(m,n){
  return Array.isArray(m?.seconds)&&Array.isArray(m?.meters)&&
    m.seconds.length===n&&m.meters.length===n&&
    m.seconds.every(r=>Array.isArray(r)&&r.length===n)&&
    m.meters.every(r=>Array.isArray(r)&&r.length===n);
}
function assessPair(matrix,stops) {
  if(!matrixValid(matrix,3))return null;
  const t=matrix.seconds,m=matrix.meters;
  const needed=[t[0][1],t[0][2],t[1][2],t[2][1],m[0][1],m[0][2]];
  if(needed.some(x=>!Number.isFinite(x)||x<0))return null;
  const nearestIndex=m[0][1]<=m[0][2]?0:1;
  const firstA=t[0][1]+t[1][2],firstB=t[0][2]+t[2][1];
  const fastestIndex=firstA<=firstB?0:1;
  const nearestDuration=nearestIndex===0?firstA:firstB;
  const fastestDuration=Math.min(firstA,firstB);
  const minutes=t.map(row=>row.map(x=>Number.isFinite(x)?x/60:null));
  const plan=planRoute({stops:stops.map((s,i)=>({key:String(i),age_minutes:s.age_minutes})),
    minutes,requiredFirstIndex:nearestIndex});
  const c0=stops[0].confirmation_minutes,c1=stops[1].confirmation_minutes;
  const hasProxy=Number.isFinite(c0)&&Number.isFinite(c1)&&c0>=0&&c1>=0&&c0!==c1;
  return {
    nearest_first_index:nearestIndex,
    fastest_first_index:fastestIndex,
    planner_first_index:plan.best.order[0],
    business_rule_extra_minutes:Math.max(0,(nearestDuration-fastestDuration)/60),
    first_confirmed_nearest_proxy:hasProxy?(c0<c1?0:1)===nearestIndex:null,
    first_age_minutes:stops[nearestIndex].age_minutes,
    has_7km_stop:m[0][1]>=7000||m[0][2]>=7000
  };
}
function resultSummary(data,clientStats,originConfirmed=true) {
  const solo=data.solo.filter(x=>x!==null);
  const pairs=data.pairs.filter(x=>x!==null);
  const proxy=pairs.filter(x=>x.first_confirmed_nearest_proxy!==null);
  return {
    status:"ROAD_API_MEASURED_NOT_PRODUCTION_APPROVED",
    provider:"openrouteservice driving-car / roads current / no historical traffic",
    origin_verified_by_operator:originConfirmed,
    samples_requested:{singles:data.solo.length,pairs:data.pairs.length},
    samples_valid:{singles:solo.length,pairs:pairs.length},
    singles:{
      median_road_km:round(median(solo.map(x=>x.roadKm))),
      p90_road_km:round(quantile(solo.map(x=>x.roadKm),.9)),
      median_current_road_minutes:round(median(solo.map(x=>x.travelMin))),
      over_7km_by_road:solo.filter(x=>x.roadKm>=7).length,
      confirmation_proxy_median_minutes:round(median(solo.map(x=>x.confirmationMin)))
    },
    pairs:{
      nearest_is_fastest:pairs.filter(x=>x.nearest_first_index===x.fastest_first_index).length,
      planner_respects_nearest:pairs.filter(x=>x.nearest_first_index===x.planner_first_index).length,
      extra_travel_time_from_nearest_priority_median_min:round(median(pairs.map(x=>x.business_rule_extra_minutes))),
      extra_travel_time_from_nearest_priority_p90_min:round(quantile(pairs.map(x=>x.business_rule_extra_minutes),.9)),
      confirmation_order_proxy_sample_size:proxy.length,
      nearest_confirmed_first_proxy:proxy.filter(x=>x.first_confirmed_nearest_proxy).length,
      with_7km_plus_stop:pairs.filter(x=>x.has_7km_stop).length
    },
    requests:clientStats,
    caveats:[
      "Perfil driving-car nao e moto; tempos e distancias sao simulacoes atuais das ruas.",
      "O horario de confirmacao iFood nao equivale a chegada GPS, podendo atrasar.",
      "As duplas iFood + Anota AI ficam fora deste primeiro teste, sem classificacao errada.",
      "A prioridade obrigatoria e o endereco mais proximo por km de rua, salvo excecao auditada do caixa.",
      "Regra de pagamento 7km ainda precisa ser alinhada com o codigo LEGADO de 6,7km.",
      "Nenhuma linha de producao e alterada por este benchmark."
    ]
  };
}

async function runBenchmark({rows,origin,routeClient,minIntervalMs=1250,soloN=50,pairN=40}) {
  const {singles,pairs}=categorize(rows);
  if(singles.length<soloN||pairs.length<pairN)
    throw new Error("Historico insuficiente para 50 destinos e 40 duplas: "+singles.length+"/"+pairs.length);
  const solo=spread(singles,soloN),paired=spread(pairs,pairN);
  let calls=0,started=0;
  async function paced(points){
    const diff=Date.now()-started;
    if(calls&&diff<minIntervalMs)await sleep(minIntervalMs-diff);
    started=Date.now();calls++;
    return routeClient.travelMatrix(points);
  }
  const soloMeasurements=[];
  for(let i=0;i<solo.length;i+=25) {
    const batch=solo.slice(i,i+25);
    const m=await paced([origin,...batch]);
    if(!matrixValid(m,batch.length+1))throw new Error("ORS respondeu matriz inconsistente.");
    for(let j=0;j<batch.length;j++){
      const sec=m.seconds[0][j+1],dist=m.meters[0][j+1];
      soloMeasurements.push(Number.isFinite(sec)&&sec>=0&&Number.isFinite(dist)&&dist>=0?{
        travelMin:sec/60,roadKm:dist/1000,confirmationMin:batch[j].confirmation_minutes,
        impossible_shorter_than_straight:dist+50<haversineMeters(origin,batch[j])
      }:null);
    }
  }
  const pairMeasurements=[];
  for(const stops of paired){
    const matrix=await paced([origin,...stops]);
    pairMeasurements.push(assessPair(matrix,stops));
  }
  if(soloMeasurements.filter(Boolean).length<Math.ceil(soloN*.95) ||
     pairMeasurements.filter(Boolean).length<Math.ceil(pairN*.95))
    throw new Error("Cobertura viaria menor que 95%; sem liberacao.");
  if(soloMeasurements.some(x=>x?.impossible_shorter_than_straight))
    throw new Error("Matriz retornou distancia menor que linha reta; revisar origem e coordenadas.");
  return resultSummary({solo:soloMeasurements,pairs:pairMeasurements},
    {matrix_requests:calls,planned_max:Math.ceil(soloN/25)+pairN});
}

async function selftest(){
  const t0=Date.parse("2026-10-23T22:00:00Z");
  const row=n=>({platform:"ifood",latitude:"-23.6246",longitude:"-46.5549",
    order_created_at:new Date(t0-600000).toISOString(),confirmed_at:new Date(t0+n*60000).toISOString()});
  const rows=[{departed_at:new Date(t0).toISOString(),total_legs:1,stops:[row(8)]},
    {departed_at:new Date(t0).toISOString(),total_legs:2,stops:[row(8),{...row(14),longitude:"-46.56"}]},
    {departed_at:new Date(t0).toISOString(),total_legs:2,stops:[row(8),{...row(14),platform:"anotaai"}]}];
  const x=categorize(rows);
  assert.equal(x.singles.length,1);
  assert.equal(x.pairs.length,1); // mistos excluidos
  assert.deepEqual(spread([1,2,3,4],2),[2,4]);
  const m={seconds:[[0,120,200],[120,0,100],[200,90,0]],
    meters:[[0,500,900],[500,0,380],[900,320,0]]};
  const score=assessPair(m,x.pairs[0]);
  assert.equal(score.nearest_first_index,0);
  assert.equal(score.planner_first_index,0);
  assert.equal(score.first_confirmed_nearest_proxy,true);
  const mock={travelMatrix:async points=>{
    const n=points.length;
    return {seconds:points.map((_,i)=>points.map((__,j)=>i===j?0:Math.abs(i-j)*100)),
      meters:points.map((_,i)=>points.map((__,j)=>i===j?0:Math.abs(i-j)*700))};
  }};
  const sample=await runBenchmark({rows:rows.slice(0,2),origin:LONGE_STORE.approx,
    routeClient:mock,soloN:1,pairN:1,minIntervalMs:0});
  assert.equal(sample.samples_valid.singles,1);
  assert.equal(sample.samples_valid.pairs,1);
  assert.equal(sample.requests.matrix_requests,2);
  assert.equal(sample.pairs.planner_respects_nearest,1);
  assert.ok(!JSON.stringify(sample).includes("46.5549"));
  console.log(JSON.stringify({result:"PASS",tests:10,real_external_api_requests:0}));
}
async function main(){
  if(process.argv.includes("--selftest"))return selftest();
  const required=["DATABASE_URL","OPENROUTESERVICE_API_KEY","STORE_LAT","STORE_LON"];
  for(const name of required)if(!process.env[name])throw new Error("Ausente variavel protegida: "+name);
  if(process.env.STORE_ORIGIN_VERIFIED!=="YES"||process.env.HISTORICAL_BENCHMARK_CONFIRM!=="READ_ONLY")
    throw new Error("Confirme origem exata e leitura exclusiva antes do benchmark.");
  const date=process.env.SAMPLE_DATE||"2026-10-23";
  if(!/^20\d\d-\d\d-\d\d$/.test(date))throw new Error("SAMPLE_DATE invalida");
  const origin={latitude:Number(process.env.STORE_LAT),longitude:Number(process.env.STORE_LON)};
  if(!checkPoint(origin)||haversineMeters(origin,LONGE_STORE.approx)>400)
    throw new Error("Coordenadas da loja invalidas ou distantes mais de 400m do ponto previsto");
  const rows=await selectHistory(process.env.DATABASE_URL,date);
  const road=createOpenRouteServiceClient({apiKey:process.env.OPENROUTESERVICE_API_KEY});
  const report=await runBenchmark({rows,origin,routeClient:road});
  report.date=date;
  // Somente metricas agregadas. Nenhum pedido/cliente/localizacao sera impresso.
  console.log(JSON.stringify(report,null,2));
}
const running=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(running) main().catch(e=>{
  const message=String(e.code||e.message||"unknown");
  const clean=message.replace(/postgres(?:ql)?:\/\/\S+/gi,"[DB_URL]")
    .replace(/api[_-]?key[=:]\s*\S+/gi,"[API_KEY]");
  console.error("BENCHMARK NAO CONCLUIDO: "+clean.slice(0,250));
  process.exitCode=1;
});
export {assessPair,categorize,runBenchmark,resultSummary,spread};
