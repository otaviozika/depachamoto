// Global ORS Matrix budget, shared by all Node instances through PostgreSQL.
// No customer coordinates, keys or order identifiers are stored in the ledger.
// Strict reservation BEFORE each external Matrix request; failed calls count too.
// UTC day and rolling 60s window provide conservative local protection.
// Other apps sharing the same API key remain OUTSIDE this accounting.
import { configuredRouteProvider, createTravelClient } from "./route-providers.js";

export const ROUTE_MATRIX_BUDGET = Object.freeze({perMinute:38,perDay:450,maxQueueWaitMs:3500});
const SERVICE = "ORS_MATRIX";
const advisoryKey = "SELECT pg_advisory_xact_lock(7300001, hashtext($1::text))";

function quotaError(code,message,extra={}) {
  return Object.assign(new Error(message), {code,status:503,...extra});
}
function positiveLimit(n,max){
  return Number.isInteger(n)&&n>=1&&n<=max;
}

// Only testing can pass another scope, limits or timestamp. Production code uses defaults.
export async function reserveRouteMatrixBudget(pool,{
  scope=SERVICE,perMinute=ROUTE_MATRIX_BUDGET.perMinute,perDay=ROUTE_MATRIX_BUDGET.perDay,at=null
}={}) {
  if(!/^[A-Z_]{3,48}$/.test(scope)||!positiveLimit(perMinute,10000)||!positiveLimit(perDay,10000))
    throw quotaError("ROUTES_QUOTA_CONFIG_INVALID","Configuração da cota Matrix inválida.");
  const client=await pool.connect().catch(()=>{throw quotaError("ROUTES_QUOTA_STORE_FAILED","Não foi possível validar a cota do serviço de mapas.");});
  let transaction=false;
  try{
    await client.query("BEGIN");transaction=true;
    await client.query(advisoryKey,[scope]);
    // DB clock is authoritative in production; the at parameter is for synthetic tests only.
    // SQL uses the same timestamp for both checks and the inserted record.
    const ts=at === null ? null : (at instanceof Date && Number.isFinite(at.getTime()) ? at : null);
    if(at!==null&&!ts)throw quotaError("ROUTES_QUOTA_CONFIG_INVALID","Relógio de teste inválido.");
    const r=await client.query(`
      WITH c AS (SELECT COALESCE($2::timestamptz,clock_timestamp()) AS t)
      SELECT
        (SELECT count(*)::int FROM route_matrix_quota_ledger l
          WHERE l.scope=$1 AND l.attempted_at>c.t-INTERVAL '60 seconds'
          AND l.attempted_at<=c.t) AS minute_count,
        (SELECT min(l.attempted_at) FROM route_matrix_quota_ledger l
          WHERE l.scope=$1 AND l.attempted_at>c.t-INTERVAL '60 seconds'
          AND l.attempted_at<=c.t) AS minute_oldest,
        (SELECT count(*)::int FROM route_matrix_quota_ledger l
          WHERE l.scope=$1
          AND l.attempted_at>=date_trunc('day',c.t AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND l.attempted_at<=c.t) AS day_count,
        c.t AS timestamp
      FROM c
    `,[scope,ts]);
    // Empty ledger produces one aggregation row due to CROSS JOIN clock + aggregate.
    const v=r.rows[0];
    if(!v)throw quotaError("ROUTES_QUOTA_STORE_FAILED","Contador de cota indisponível.");
    if(Number(v.day_count)>=perDay){
      await client.query("ROLLBACK");transaction=false;
      return {ok:false,reason:"DAILY",retryAfterMs:null};
    }
    if(Number(v.minute_count)>=perMinute){
      const retryAfterMs=Math.max(50,Math.ceil(new Date(v.minute_oldest).getTime()+60050-new Date(v.timestamp).getTime()));
      await client.query("ROLLBACK");transaction=false;
      return {ok:false,reason:"MINUTE",retryAfterMs};
    }
    await client.query("INSERT INTO route_matrix_quota_ledger(scope,attempted_at) VALUES($1,$2::timestamptz)",[scope,v.timestamp]);
    await client.query("COMMIT");transaction=false;
    return {ok:true,minuteCount:Number(v.minute_count)+1,dayCount:Number(v.day_count)+1};
  }catch(e){
    if(transaction)await client.query("ROLLBACK").catch(()=>{});
    if(e.code?.startsWith("ROUTES_"))throw e;
    throw quotaError("ROUTES_QUOTA_STORE_FAILED","Não foi possível validar a cota do serviço de mapas.");
  }finally{client.release();}
}

export async function withRouteMatrixBudget(pool,work,{
  maxQueueWaitMs=ROUTE_MATRIX_BUDGET.maxQueueWaitMs,
  ...budgetOpts
}={}) {
  const start=Date.now();
  for(let attempt=0;attempt<5;attempt++){
    const slot=await reserveRouteMatrixBudget(pool,budgetOpts);
    if(slot.ok)return work();
    if(slot.reason==="DAILY")throw quotaError("ROUTES_DAILY_QUOTA_GUARD","Cota de rotas próxima do limite diário. Solicite sequência ao caixa.");
    const remaining=maxQueueWaitMs-(Date.now()-start);
    if(!Number.isFinite(slot.retryAfterMs)||slot.retryAfterMs>remaining)
      throw quotaError("ROUTES_RATE_LIMITED_LOCAL","Muitas rotas ao mesmo tempo. Solicite sequência ao caixa ou tente novamente.",{retryAfterSeconds:Math.ceil((slot.retryAfterMs||60000)/1000)});
    await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,slot.retryAfterMs)));
  }
  throw quotaError("ROUTES_RATE_LIMITED_LOCAL","Fila de rotas ocupada. Solicite sequência ao caixa.");
}

export function createQuotaManagedTravelClient({env=process.env,pool,fetchFn}={}) {
  const client=createTravelClient({env,...(fetchFn?{fetchFn}:{})});
  if(configuredRouteProvider(env)!=="openrouteservice")return client;
  if(!pool)throw quotaError("ROUTES_QUOTA_STORE_FAILED","Banco para controlar cota de mapas não configurado.");
  const syntheticOnly=env.APP_ENV==="staging"&&env.STAGING_SAFE_MODE==="true"&&
    env.FRIDAY_MOCK_ORS_ONLY==="YES"&&env.NODE_ENV!=="production"&&
    env.OPENROUTESERVICE_API_KEY==="FRIDAY_SYNTHETIC_STAGING_ONLY";
  // The isolated Friday stress suite tests 600 HTTP orders in seconds; quota
  // correctness is separately tested using the default limits in SQL.
  const opts=syntheticOnly?{perMinute:2000,perDay:3000}:{};
  return {
    ...client,
    get elements(){return client.elements;},
    travelMatrix(points){return withRouteMatrixBudget(pool,()=>client.travelMatrix(points),opts);}
  };
}
