// Disposable index experiment; no real application tables are changed.
import assert from "node:assert/strict";
import pg from "pg";
import { performance } from "node:perf_hooks";
const env=process.env;
const target=new URL(String(env.DATABASE_URL||""));
assert.equal(target.hostname,"127.0.0.1");
assert.equal(decodeURIComponent(target.pathname.slice(1)),"despachefull_staging");
assert.equal(env.APP_ENV,"staging");
assert.equal(env.STAGING_SAFE_MODE,"true");
assert.equal(env.LOAD_TEST_CONFIRM,"STAGING_ONLY_I_UNDERSTAND");
const client=new pg.Client({connectionString:env.DATABASE_URL,ssl:false});
function nodes(p,out=[]){out.push(p["Node Type"]);for(const node of p.Plans||[])nodes(node,out);return out}
function p95(a){const b=[...a].sort((x,y)=>x-y);return Number(b[Math.ceil(b.length*.95)-1].toFixed(2))}
await client.connect();
try{
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='20s'");
  await client.query("CREATE TEMP TABLE stage8_ifood_orders (id integer PRIMARY KEY,order_created_at timestamptz,updated_at timestamptz) ON COMMIT DROP");
  await client.query([
    "INSERT INTO stage8_ifood_orders(id,order_created_at,updated_at)",
    "SELECT i, CASE WHEN i%20=0 THEN NULL ELSE NOW()-((i%60)::text||' days')::interval",
    "-((i%1440)::text||' minutes')::interval END,",
    "NOW()-((i%60)::text||' days')::interval-((i%1440)::text||' minutes')::interval",
    "FROM generate_series(1,20000) i"
  ].join(" "));
  await client.query("ANALYZE stage8_ifood_orders");
  const base=[
    "SELECT count(*)::int AS n FROM stage8_ifood_orders WHERE",
    "(COALESCE(order_created_at,updated_at) AT TIME ZONE 'America/Sao_Paulo')::date",
    "= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date"
  ].join(" ");
  const countBefore=(await client.query(base)).rows[0].n;
  const baselinePlan=(await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+base)).rows[0]["QUERY PLAN"][0];
  const before=[];
  for(let i=0;i<12;i++){const t=performance.now();const r=await client.query(base);assert.equal(r.rows[0].n,countBefore);before.push(performance.now()-t)}
  await client.query("CREATE INDEX stage8_business_day_idx ON stage8_ifood_orders (((COALESCE(order_created_at,updated_at) AT TIME ZONE 'America/Sao_Paulo')::date))");
  await client.query("ANALYZE stage8_ifood_orders");
  const indexedPlan=(await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+base)).rows[0]["QUERY PLAN"][0];
  const after=[];
  for(let i=0;i<12;i++){const t=performance.now();const r=await client.query(base);assert.equal(r.rows[0].n,countBefore);after.push(performance.now()-t)}
  console.log("STAGE8_INDEX_EXPERIMENT "+JSON.stringify({
    result:"PASS",table:"TEMP ONLY",synthetic_rows:20000,
    matching_day_count:countBefore,
    original:{plan:nodes(baselinePlan.Plan),execution_ms:baselinePlan["Execution Time"],
      app_roundtrip_p95_ms:p95(before)},
    indexed:{plan:nodes(indexedPlan.Plan),execution_ms:indexedPlan["Execution Time"],
      app_roundtrip_p95_ms:p95(after)},
    caveats:["Artificial distribution and local PostgreSQL","No production table or index touched",
      "Use results for migration planning only; compare real EXPLAIN in staging before release"]
  }));
  assert.ok(countBefore>0&&countBefore<20000);
}finally{
  await client.query("ROLLBACK").catch(()=>{});
  await client.end();
}
