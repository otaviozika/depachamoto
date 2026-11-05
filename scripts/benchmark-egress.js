import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { deliveryContext,anotaContext,plain,payloadFixture,seedDeliveries,frontendHarness,confirmationEvents } from './egress-test-support.js';

// Never accept a hosted database here: benchmarks are intentionally disposable.
const baseline=path.resolve(process.env.EGRESS_BASELINE_DIR||'../despachefull-baseline');
const candidate=path.resolve('.');
const sources=[baseline,candidate].map(root=>({server:fs.readFileSync(path.join(root,'server.js'),'utf8'),html:fs.readFileSync(path.join(root,'public/index.html'),'utf8')}));
const nativeUrl=process.env.EGRESS_BENCH_DATABASE_URL;
let db,pool,wireBytes=0;
if(nativeUrl){const url=new URL(nativeUrl);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Only a loopback disposable database is allowed');assert.match(url.pathname,/egress/);pool=new pg.Pool({connectionString:nativeUrl,ssl:false,max:20});pool.on('connect',client=>client.connection.stream.on('data',chunk=>{wireBytes+=chunk.length;}));db={query:(...args)=>pool.query(...args),exec:sql=>pool.query(sql),close:()=>pool.end()};}
else {db=new PGlite();}
await db.exec(sources[1].server.split('await pool.query(`')[1].split('`);')[0]);
const baseQuery=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};};
await seedDeliveries(baseQuery,{couriers:30,perCourier:18});
const docs=Array.from({length:100},(_,i)=>({_id:'anota-bench-'+i,shortReference:String(8000+i),check:1,updatedAt:'2026-10-30T18:00:00Z'}));
for(const d of docs)await baseQuery("INSERT INTO anotaai_orders(order_id,page_id,display_id,status_code,remote_updated_at,order_type,payload) VALUES($1,'benchmark',$2,1,$3,'DELIVERY',$4::jsonb)",[d._id,d.shortReference,d.updatedAt,JSON.stringify(payloadFixture(1))]);
let meters;
const measuredQuery=async(sql,args=[])=>{const r=await baseQuery(sql,args);meters.calls++;meters.rows+=r.rows.length;meters.jsonResultBytes+=Buffer.byteLength(JSON.stringify(r.rows));if(/SELECT[\s\S]*FROM anotaai_orders/.test(sql))meters.metadataReads++;return r;};
const contexts=sources.map(s=>({delivery:deliveryContext(s.server,measuredQuery),anota:anotaContext(s.server,measuredQuery,docs)}));
const reset=()=>{meters={calls:0,rows:0,jsonResultBytes:0,metadataReads:0};wireBytes=0;};
const percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return Number(a[Math.min(a.length-1,Math.ceil(a.length*p)-1)].toFixed(3));};
const report={engine:nativeUrl?'PostgreSQL native, TCP loopback':'PGlite, PostgreSQL WASM single connection',node:process.version,syntheticOnly:true,couriers:30,ordersPerCourier:18,deliveries:[],anota:{},frontend:[],limitations:['Local/CI measurements do not measure Render-to-Supabase internet latency or actual monthly billing.']};
try {
  if(pool)await Promise.all(Array.from({length:20},()=>pool.query('SELECT 1')));
  for(const concurrency of [1,30,60]){
    const stats=[{times:[],calls:0,jsonResultBytes:0,wireBytes:0},{times:[],calls:0,jsonResultBytes:0,wireBytes:0}];
    reset();for(const c of contexts)await c.delivery.getCourierIfoodDeliveries(2);
    const rounds=concurrency===1?12:4;
    for(let round=0;round<rounds;round++){
      const outputs=[];
      for(const v of (round%2?[1,0]:[0,1])){
        reset();const latencies=[];
        outputs[v]=await Promise.all(Array.from({length:concurrency},async(_,i)=>{const start=performance.now();const value=plain(await contexts[v].delivery.getCourierIfoodDeliveries(2+i%30));latencies.push(performance.now()-start);return value;}));
        stats[v].times.push(...latencies);for(const k of ['calls','jsonResultBytes'])stats[v][k]+=meters[k];stats[v].wireBytes+=wireBytes;
      }
      assert.deepEqual(outputs[1],outputs[0],'Public card results must be identical');
    }
    const values=stats.map(s=>({requests:s.times.length,queries:s.calls,jsonResultBytes:s.jsonResultBytes,pgWireBytes:nativeUrl?s.wireBytes:null,p50Ms:percentile(s.times,.5),p95Ms:percentile(s.times,.95),p99Ms:percentile(s.times,.99)}));
    const reduction=100*(1-values[1].jsonResultBytes/values[0].jsonResultBytes);
    assert.ok(reduction>=60,'Card database result reduction must be >=60% on the declared fixture');
    report.deliveries.push({concurrency,baseline:values[0],candidate:values[1],resultReductionPercent:Number(reduction.toFixed(2)),identicalResponses:true});
  }
  const pollStats=[{times:[],calls:0,jsonResultBytes:0,wireBytes:0,metadataReads:0},{times:[],calls:0,jsonResultBytes:0,wireBytes:0,metadataReads:0}];
  for(let round=0;round<4;round++){
    const outputs=[];
    for(const v of (round%2?[1,0]:[0,1])){
      reset();const start=performance.now();outputs[v]=plain(await contexts[v].anota.syncAnotaAiPage('benchmark'));pollStats[v].times.push(performance.now()-start);
      for(const k of ['calls','jsonResultBytes','metadataReads'])pollStats[v][k]+=meters[k];pollStats[v].wireBytes+=wireBytes;
    }
    assert.deepEqual(outputs[1],outputs[0]);
  }
  const polls=pollStats.map(s=>({polls:s.times.length,queries:s.calls,metadataReads:s.metadataReads,jsonResultBytes:s.jsonResultBytes,pgWireBytes:nativeUrl?s.wireBytes:null,p50Ms:percentile(s.times,.5),p95Ms:percentile(s.times,.95)}));
  assert.equal(polls[0].metadataReads,800);assert.equal(polls[1].metadataReads,4);
  report.anota={ordersPerPoll:100,baseline:polls[0],candidate:polls[1],metadataReadReductionPercent:99.5,identicalResults:true};
  for(const clients of [1,30,60]){
    const variants=[];
    for(let v=0;v<2;v++){
      const harnesses=Array.from({length:clients},(_,i)=>frontendHarness(sources[v].html,{id:i+2}));
      for(const {event,body} of confirmationEvents(sources[v].server,2))for(const h of harnesses)h.event(event,body);
      for(const h of harnesses)await h.advance(2000);
      variants.push({deliveryApiRequests:harnesses.reduce((n,h)=>n+h.counts.deliveries*2,0),dashboardApiRequests:harnesses.reduce((n,h)=>n+h.counts.dashboard,0),affectedCourierFirstRefreshMs:harnesses[0].times.find(x=>x.kind==='deliveries').at,unrelatedCouriersRefreshed:harnesses.slice(1).filter(h=>h.counts.deliveries>0).length});
    }
    assert.equal(variants[1].deliveryApiRequests,2);assert.equal(variants[1].unrelatedCouriersRefreshed,0);assert.ok(variants[1].affectedCourierFirstRefreshMs<=variants[0].affectedCourierFirstRefreshMs);
    report.frontend.push({visibleCouriers:clients,scenario:'one iFood confirmation plus local completion',baseline:variants[0],candidate:variants[1]});
  }
  const out=process.env.EGRESS_REPORT_FILE||'test-results/egress-benchmark.json';fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));
  console.log('EGRESS_BENCHMARK_JSON\n'+JSON.stringify(report,null,2));
}finally{await db.close();}
