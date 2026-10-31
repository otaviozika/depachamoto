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
 * Smoke API sintetico: HISTORICAL_BENCHMARK_CONFIRM=SMOKE_ONLY OPENROUTESERVICE_API_KEY=... node scripts/benchmark-ors-historical.js --provider-smoke
 *
 * O punto da loja codificado em LONGE_STORE.approx NAO serve como GPS confirmado.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { createOpenRouteServiceClient } from "../lib/route-providers.js";
import { LONGE_STORE, haversineMeters } from "../lib/longe-zone.js";

// Pino vermelho posicionado no Google Maps pelo responsavel da operacao em 31/10/2026.
// Este dado e exclusivo do benchmark; NAO altera LONGE_STORE ou origem da producao.
export const OPERATOR_ROUTE_ORIGIN = Object.freeze({ latitude: -23.6244855, longitude: -46.5549218 });

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
    if(!row.stops.every(s=>s.platform==="ifood" && s.order_type==="DELIVERY" && s.delivered_by==="MERCHANT" && s.is_test!==true))continue; // nem retirada nem frota parceira
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
" o.order_type, o.delivered_by, o.is_test,",
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
" jsonb_agg(jsonb_build_object('platform',platform,'order_type',order_type,'delivered_by',delivered_by,'is_test',is_test, 'latitude',latitude,'longitude',longitude,",
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
    // A transacao READ ONLY nao basta se a credencial tem privilegios de escrita.
    // O teste so pode ler historico com uma role realmente limitada a SELECT.
    const access=await client.query(`
      SELECT NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
             AND NOT r.rolbypassrls AND NOT r.rolreplication
             AND NOT EXISTS (
               SELECT 1 FROM (
                 VALUES ('public.dispatches'::regclass),
                        ('public.dispatch_orders'::regclass),
                        ('public.ifood_dispatch_links'::regclass),
                        ('public.ifood_orders'::regclass),
                        ('public.ifood_delivery_confirmations'::regclass)
               ) t(tab)
               WHERE has_table_privilege(current_user,t.tab,'INSERT')
                  OR has_table_privilege(current_user,t.tab,'UPDATE')
                  OR has_table_privilege(current_user,t.tab,'DELETE')
                  OR has_table_privilege(current_user,t.tab,'TRUNCATE')
             ) AS safe
      FROM pg_roles r WHERE r.rolname=current_user`);
    if(access.rows[0]?.safe!==true)
      throw new Error("Credencial PostgreSQL rejeitada: requer conta com SELECT e sem permissao de escrita nas tabelas de pedidos.");
    const q=await client.query(HISTORICAL_SQL,[date]);
    await client.query("ROLLBACK");
    return q.rows;
  } catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    // Nunca exibir URI, usuario, host, SQL da consulta ou dados de clientes.
    if(String(e.message||"").startsWith("Credencial PostgreSQL rejeitada:"))throw e;
    throw new Error("Falha na leitura historica (SQLSTATE "+String(e.code||"UNKNOWN")+"); banco nao alterado.");
  } finally { await client.end().catch(()=>{}); }
}
function matrixValid(m,n){
  return Array.isArray(m?.seconds)&&Array.isArray(m?.meters)&&
    m.seconds.length===n&&m.meters.length===n&&
    m.seconds.every(r=>Array.isArray(r)&&r.length===n)&&
    m.meters.every(r=>Array.isArray(r)&&r.length===n);
}
// Verificacao geometrica da malha: o ORS mede entre pontos "snapados" nas ruas.
// Pela desigualdade triangular: linha_reta <= ajuste_saida + percurso_rua + ajuste_chegada.
// Se os metadados faltarem, aceitamos SOMENTE quando a distancia viaria por si satisfaz
// a desigualdade (nunca inventamos offsets). Em homologacao exigimos snap conhecido.
function roadLegReasonable(matrix,points,from,to,{maxSnapMeters=150,toleranceMeters=5,requireSnapping=false}={}) {
  const road=matrix?.meters?.[from]?.[to];
  if(!Number.isFinite(road)||road<0||!points?.[from]||!points?.[to])return {ok:false,snap_known:false};
  const straight=haversineMeters(points[from],points[to]);
  const src=matrix.snapped_meters?.sources?.[from];
  const dst=matrix.snapped_meters?.destinations?.[to];
  const known=Number.isFinite(src)&&src>=0&&Number.isFinite(dst)&&dst>=0;
  if(requireSnapping&&!known)return {ok:false,snap_known:false};
  if(known&&(src>maxSnapMeters||dst>maxSnapMeters))return {ok:false,snap_known:true,max_snap_meters:Math.max(src,dst)};
  const slack=known?src+dst:0;
  return {ok:road+slack+toleranceMeters>=straight,snap_known:known,
    max_snap_meters:known?Math.max(src,dst):null};
}

function assessPair(matrix,stops,origin=null) {
  if(!matrixValid(matrix,3))return null;
  const t=matrix.seconds,m=matrix.meters;
  const needed=[t[0][1],t[0][2],t[1][2],t[2][1],m[0][1],m[0][2]];
  if(needed.some(x=>!Number.isFinite(x)||x<0))return null;
  if(origin) {
    const points=[origin,...stops];
    for(const [from,to] of [[0,1],[0,2],[1,2],[2,1]]){
      if(!roadLegReasonable(matrix,points,from,to,{requireSnapping:true}).ok)return null;
    }
  }
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
// Analisa a elegibilidade de todos os pedidos sem transmitir GPS ou PII a terceiros.
function preflightHistory(rows,date) {
  const {singles,pairs}=categorize(rows);
  const pairsWithBothConfirmations=pairs.filter(two=>two.every(s=>Number.isFinite(s.confirmation_minutes))).length;
  const pairsWithDistinctCoordinates=pairs.filter(two=>
    haversineMeters(two[0],two[1])>2).length;
  return {
    status:"READ_ONLY_SAMPLE_PREFLIGHT",
    sample_date:date,
    eligible_single_runs:singles.length,
    eligible_pair_runs:pairs.length,
    pairs_with_distinct_coordinates:pairsWithDistinctCoordinates,
    pairs_with_two_confirmations:pairsWithBothConfirmations,
    selected_singles:Math.min(50,singles.length),
    selected_pairs:Math.min(40,pairs.length),
    ready:singles.length>=50&&pairs.length>=40&&pairsWithDistinctCoordinates>=40,
    database_mode:"READ_ONLY",
    external_api_requests:0,
    customer_coordinates_returned:false,
    candidate_data_logged:false
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

async function runBenchmark({rows,origin,routeClient,minIntervalMs=2000,soloN=50,pairN=40}) {
  const {singles,pairs}=categorize(rows);
  // Uma dupla com as mesmas coordenadas nao comprova uma decisao entre enderecos.
  const distinctPairs=pairs.filter(two=>haversineMeters(two[0],two[1])>2);
  if(singles.length<soloN||distinctPairs.length<pairN)
    throw new Error("Historico insuficiente para 50 destinos/40 duplas distintas; suspender benchmark.");
  const solo=spread(singles,soloN),paired=spread(distinctPairs,pairN);
  // Standard ORS: 40 chamadas Matrix/min. 2000ms garante <=30/minute com margem.
  // O plano tambem tem cota diaria compartilhada com o uso real da aplicacao.
  if (!Number.isFinite(minIntervalMs) || minIntervalMs<1550) throw new Error("Intervalo Matrix abaixo do limite seguro de 40/min.");
  const maxRequests=Math.ceil(soloN/25)+pairN;
  if(maxRequests>50)throw new Error("Orcamento de requisicoes ORS excedido.");
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
      const geometry=roadLegReasonable(m,[origin,...batch],0,j+1,{requireSnapping:true});
      soloMeasurements.push(Number.isFinite(sec)&&sec>=0&&Number.isFinite(dist)&&dist>=0&&geometry.ok?{
        travelMin:sec/60,roadKm:dist/1000,confirmationMin:batch[j].confirmation_minutes
      }:null);
    }
  }
  const pairMeasurements=[];
  for(const stops of paired){
    const matrix=await paced([origin,...stops]);
    pairMeasurements.push(assessPair(matrix,stops,origin));
  }
  if(soloMeasurements.filter(Boolean).length<Math.ceil(soloN*.95) ||
     pairMeasurements.filter(Boolean).length<Math.ceil(pairN*.95))
    throw new Error("Cobertura viaria menor que 95%; sem liberacao.");
  if(pairMeasurements.filter(Boolean).some(p=>p.planner_first_index!==p.nearest_first_index))
    throw new Error("Rota calculada violou primeira parada mais proxima; sem liberacao.");
   return resultSummary({solo:soloMeasurements,pairs:pairMeasurements},
    {matrix_requests:calls,planned_max:Math.ceil(soloN/25)+pairN});
}

async function providerSmoke() {
  if (process.env.HISTORICAL_BENCHMARK_CONFIRM !== "SMOKE_ONLY")
    throw new Error("Para testar apenas o provedor, defina HISTORICAL_BENCHMARK_CONFIRM=SMOKE_ONLY.");
  if (!process.env.OPENROUTESERVICE_API_KEY)throw new Error("Chave ORS nao configurada no ambiente de teste.");
  // Pontos ficticios proximos da loja. Nao consulta pedidos, Supabase ou enderecos de clientes.
  const origin=LONGE_STORE.approx;
  const testPoints=[origin,
    {latitude:origin.latitude+0.0007,longitude:origin.longitude+0.0011},
    {latitude:origin.latitude-0.0008,longitude:origin.longitude-0.0009}];
  const started=Date.now();
  const api=createOpenRouteServiceClient({apiKey:process.env.OPENROUTESERVICE_API_KEY,timeoutMs:20000});
  const result=await api.travelMatrix(testPoints);
  if(!matrixValid(result,3)) throw new Error("ORS respondeu formato inesperado na verificacao.");
  const legs=[result.meters[0][1],result.meters[0][2],result.seconds[0][1],result.seconds[0][2]];
  if (legs.some(x=>!Number.isFinite(x)||x<=0))throw new Error("ORS nao conseguiu calcular as duas rotas sinteticas.");
  const validations=[1,2].map(to=>roadLegReasonable(result,testPoints,0,to,{maxSnapMeters:250}));
  if(validations.some(v=>!v.snap_known))
    throw new Error("ORS nao informou distancias dos pontos ajustados a vias (snapping).");
  if(validations.some(v=>!v.ok))
    throw new Error("Ajuste a via excessivo ou geometria inconsistente na matriz ORS.");
  console.log(JSON.stringify({
    result:"PASS",provider:"openrouteservice",mode:"SYNTHETIC_PROVIDER_SMOKE",
    matrix_requests:1,elements:api.elements,points:3,valid_legs:2,
    max_snap_meters:round(Math.max(...validations.map(v=>v.max_snap_meters)),1),
    response_time_ms:Date.now()-started,
    database_read:false,real_customer_data_used:false
  },null,2));
}

async function selftest(){
  const t0=Date.parse("2026-10-23T22:00:00Z");
  const row=n=>({platform:"ifood",order_type:"DELIVERY",delivered_by:"MERCHANT",is_test:false,latitude:"-23.6246",longitude:"-46.5549",
    order_created_at:new Date(t0-600000).toISOString(),confirmed_at:new Date(t0+n*60000).toISOString()});
  const rows=[{departed_at:new Date(t0).toISOString(),total_legs:1,stops:[row(8)]},
    {departed_at:new Date(t0).toISOString(),total_legs:2,stops:[row(8),{...row(14),longitude:"-46.56"}]},
    {departed_at:new Date(t0).toISOString(),total_legs:2,stops:[row(8),{...row(14),platform:"anotaai"}]}];
  const x=categorize(rows);
  const preflight=preflightHistory(rows,"2026-10-23");
  assert.equal(preflight.eligible_single_runs,1);
  assert.equal(preflight.eligible_pair_runs,1);
  assert.equal(preflight.selected_pairs,1);
  assert.equal(preflight.ready,false);
  assert.equal(preflight.external_api_requests,0);
  assert.equal(preflight.customer_coordinates_returned,false);
  assert.equal(JSON.stringify(preflight).includes("-46.5549"),false);
  assert.equal(x.singles.length,1);
  assert.equal(x.pairs.length,1); // mistos excluidos
  assert.ok(haversineMeters(OPERATOR_ROUTE_ORIGIN,LONGE_STORE.approx)<5);
  assert.equal(checkPoint(OPERATOR_ROUTE_ORIGIN),true);
  assert.deepEqual(spread([1,2,3,4],2),[2,4]);
  const m={seconds:[[0,120,200],[120,0,100],[200,90,0]],
    meters:[[0,500,900],[500,0,380],[900,320,0]]};
  const score=assessPair(m,x.pairs[0]);
  assert.equal(score.nearest_first_index,0);
  assert.equal(score.planner_first_index,0);
  assert.equal(score.first_confirmed_nearest_proxy,true);
  // Um trecho na rua pode medir menos que a linha reta entre coordenadas ORIGINAIS:
  // o ORS mede entre pontos ajustados a rede. So aceitar diferenca matematicamente
  // explicada pelo snapping; jamais aceitar deslocamento maior que o limiar.
  const gp=[{latitude:-23.62446,longitude:-46.55491},
    {latitude:-23.62446,longitude:-46.55381}];
  const originalStraight=haversineMeters(gp[0],gp[1]);
  const snappedCase={meters:[[0,originalStraight-30],[originalStraight-30,0]],
    snapped_meters:{sources:[20,20],destinations:[20,20]}};
  assert.equal(roadLegReasonable(snappedCase,gp,0,1).ok,true);
  assert.equal(roadLegReasonable({meters:snappedCase.meters},gp,0,1).ok,false);
  assert.equal(roadLegReasonable({meters:[[0,originalStraight+30],[originalStraight+30,0]]},gp,0,1,{requireSnapping:true}).ok,false);
  assert.equal(roadLegReasonable({meters:snappedCase.meters,snapped_meters:{
    sources:[180,0],destinations:[20,0]}},gp,0,1).ok,false);
  assert.equal(roadLegReasonable({meters:[[0,originalStraight-150],[],[]],
    snapped_meters:{sources:[20,20],destinations:[20,20]}},gp,0,1).ok,false);
  // Contrato real do payload ORS: Authorization server-side, longitude antes de latitude,
  // metricas completas e nenhuma chamada externa no teste desconectado.
  let mockApiCalls=0;
  const mockedORS=createOpenRouteServiceClient({
    apiKey:"selftest-key-only",
    fetchFn:async (url,opts)=>{
      mockApiCalls++;
      assert.equal(url, "https://api.heigit.org/openrouteservice/v2/matrix/driving-car");
      assert.equal(opts.method,"POST");
      assert.equal(opts.headers.Authorization,"selftest-key-only");
      const body=JSON.parse(opts.body);
      assert.deepEqual(body.metrics,["duration","distance"]);
      assert.deepEqual(body.locations[0],[-46.55491,-23.62446]);
      assert.equal(body.units,"m");
      assert.equal(body.locations.length,3);
      return {ok:true,text:async()=>JSON.stringify({
        durations:[[0,120,180],[150,0,80],[210,95,0]],
        distances:[[0,650,1000],[710,0,370],[1100,420,0]],
        sources:[{snapped_distance:17},{snapped_distance:32},{snapped_distance:41}],
        destinations:[{snapped_distance:17},{snapped_distance:32},{snapped_distance:41}]
      })};
    }
  });
  const mockedMatrix=await mockedORS.travelMatrix([
    LONGE_STORE.approx,
    {latitude:-23.625,longitude:-46.556},
    {latitude:-23.626,longitude:-46.557}
  ]);
  assert.equal(mockApiCalls,1);
  assert.equal(mockedORS.elements,9);
  assert.equal(mockedMatrix.seconds[0][1],120);
  assert.equal(mockedMatrix.meters[0][2],1000);
  assert.equal(mockedMatrix.snapped_meters.sources[1],32);
  assert.equal(mockedMatrix.snapped_meters.destinations[2],41);
  const mock={travelMatrix:async points=>{
    const n=points.length;
    return {seconds:points.map((_,i)=>points.map((__,j)=>i===j?0:Math.abs(i-j)*100)),
      meters:points.map((_,i)=>points.map((__,j)=>i===j?0:Math.abs(i-j)*700)),
      snapped_meters:{sources:points.map(()=>0),destinations:points.map(()=>0)}};
  }};
  const sample=await runBenchmark({rows:rows.slice(0,2),origin:LONGE_STORE.approx,
    routeClient:mock,soloN:1,pairN:1,minIntervalMs:1600});
  assert.equal(sample.samples_valid.singles,1);
  assert.equal(sample.samples_valid.pairs,1);
  assert.equal(sample.requests.matrix_requests,2);
  await assert.rejects(() => runBenchmark({rows:rows.slice(0,2),origin:LONGE_STORE.approx,
    routeClient:mock,soloN:1,pairN:1,minIntervalMs:1000}),/Intervalo Matrix/);
  assert.equal(sample.pairs.planner_respects_nearest,1);
  assert.ok(!JSON.stringify(sample).includes("46.5549"));
  console.log(JSON.stringify({result:"PASS",tests:16,real_external_api_requests:0}));
}
async function main(){
  if(process.argv.includes("--selftest"))return selftest();
  if(process.argv.includes("--provider-smoke"))return providerSmoke();
  const preflightOnly=process.argv.includes("--preflight");
  const required=preflightOnly?["DATABASE_URL"]:["DATABASE_URL","OPENROUTESERVICE_API_KEY"];
  for(const name of required)if(!process.env[name])throw new Error("Ausente variavel protegida: "+name);
  const expectedMode=preflightOnly?"PREFLIGHT_ONLY":"READ_ONLY";
  if(process.env.STORE_ORIGIN_VERIFIED!=="YES"||process.env.HISTORICAL_BENCHMARK_CONFIRM!==expectedMode)
    throw new Error("Confirme origem e modo seguro do benchmark."); 
  if(!preflightOnly&&process.env.CUSTOMER_COORDINATES_TRANSFER_APPROVED!=="YES")
    throw new Error("Transferencia de coordenadas externas nao autorizada. Nao consultar ORS.");
  const date=process.env.SAMPLE_DATE||"2026-10-23";
  if(!/^20\d\d-\d\d-\d\d$/.test(date))throw new Error("SAMPLE_DATE invalida");
  const origin={
    latitude:process.env.STORE_LAT===undefined?OPERATOR_ROUTE_ORIGIN.latitude:Number(process.env.STORE_LAT),
    longitude:process.env.STORE_LON===undefined?OPERATOR_ROUTE_ORIGIN.longitude:Number(process.env.STORE_LON)
  };
  if(!checkPoint(origin)||haversineMeters(origin,OPERATOR_ROUTE_ORIGIN)>25)
    throw new Error("Origem do benchmark diverge mais de 25m do pino informado pelo operador. Revalidar antes de continuar.");
  const rows=await selectHistory(process.env.DATABASE_URL,date);
  const preflight=preflightHistory(rows,date);
  if(!preflight.ready)throw new Error("Historico nao atende 50 destinos/40 duplas; interrompido.");
  if(preflightOnly) { console.log(JSON.stringify(preflight,null,2)); return; }
  // Nenhum dado bruto vai para logs ou artifacts. Apenas coordenadas sao enviadas ao ORS.
  const road=createOpenRouteServiceClient({apiKey:process.env.OPENROUTESERVICE_API_KEY});
  const report=await runBenchmark({rows,origin,routeClient:road});
  report.date=date;
  report.origin_source="OPERATOR_PIN_2026_10_31"; // somente origem empresarial, sem dados de clientes
  // Somente metricas agregadas. Nenhum pedido/cliente/localizacao sera impresso.
  console.log(JSON.stringify(report,null,2));
}
const running=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(running) main().catch(e=>{
  // Nao exibir resposta do provedor, pois mensagens externas podem repetir GPS de clientes.
  const code=String(e?.code||"");
  const known=String(e?.message||"");
  const safe=/^ROUTES_[A-Z0-9_]+$/.test(code)?"Falha na API viaria ("+code+").":
    /^(Credencial PostgreSQL rejeitada:|Falha na leitura historica|Historico nao atende|Cobertura viaria|Origem do benchmark|Confirme origem|Transferencia de coordenadas externas|Ausente variavel|Intervalo Matrix|Orcamento de requisicoes|ORS respondeu matriz inconsistente)/.test(known)
    ?known:"Falha no benchmark (dados protegidos; revisar diagnostico seguro).";
  console.error("BENCHMARK NAO CONCLUIDO: "+safe.slice(0,230));
  process.exitCode=1;
});
export {assessPair,categorize,runBenchmark,resultSummary,spread};
