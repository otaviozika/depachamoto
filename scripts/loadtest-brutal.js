import pg from "pg";
import bcrypt from "bcryptjs";
const { Pool } = pg;

const TARGET = String(process.env.TARGET_URL || "").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.LOADTEST_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
const LOAD_TEST_KEY = process.env.LOAD_TEST_KEY || "";
const CONFIRM = process.env.LOAD_TEST_CONFIRM;

const COURIERS = Number(process.env.COURIERS || 40);
const DEPARTURES = Number(process.env.DEPARTURES_PER_COURIER || 30);
const ORDERS_PER_DEPARTURE = Math.min(5,Math.max(1,Number(process.env.ORDERS_PER_DEPARTURE || 2)));
const TEST_PASSWORD = "LoadTest!987654";
const RUN = `lt_${Date.now().toString(36)}`;

if (CONFIRM !== "STAGING_ONLY_I_UNDERSTAND") {
  console.error("ABORTADO: defina LOAD_TEST_CONFIRM=STAGING_ONLY_I_UNDERSTAND.");
  process.exit(2);
}
if (!TARGET || !DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error("Faltam TARGET_URL, DATABASE_URL, LOADTEST_ADMIN_USERNAME ou LOADTEST_ADMIN_PASSWORD.");
  process.exit(2);
}

const pool = new Pool({
  connectionString:DATABASE_URL,
  ssl:TARGET.startsWith("https://") ? {rejectUnauthorized:false} : false,
  max:10
});

const userIds=[];
const latencies=[];
const failures=[];
let createdDepartures=0,createdOrders=0,dashboardChecks=0;

const headers=()=>({
  "content-type":"application/json",
  ...(LOAD_TEST_KEY?{"x-load-test-key":LOAD_TEST_KEY}:{})
});
const cookieFrom=res=>(res.headers.get("set-cookie")||"").split(";")[0];

async function login(username,password){
  const t=performance.now();
  const res=await fetch(`${TARGET}/api/login`,{
    method:"POST",headers:headers(),body:JSON.stringify({username,password})
  });
  latencies.push(performance.now()-t);
  if(!res.ok)throw new Error(`login ${username}: ${res.status} ${await res.text()}`);
  return cookieFrom(res);
}
async function call(path,cookie,opt={}){
  const t=performance.now();
  const res=await fetch(`${TARGET}${path}`,{
    ...opt,
    headers:{...headers(),cookie,...(opt.headers||{})}
  });
  latencies.push(performance.now()-t);
  return res;
}
async function seed(){
  const hash=await bcrypt.hash(TEST_PASSWORD,10);
  for(let i=1;i<=COURIERS;i++){
    const q=await pool.query(`
      INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
      VALUES($1,$2,$3,'courier','APPROVED',true,false)
      RETURNING id
    `,[`Load Test ${i}`,`${RUN}_c${i}`,hash]);
    userIds.push(q.rows[0].id);
  }
}
async function cleanup(){
  if(!userIds.length)return;
  await pool.query("BEGIN");
  try{
    await pool.query("DELETE FROM operational_conflicts WHERE actor_user_id=ANY($1::int[]) OR courier_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM notifications WHERE courier_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM audit_logs WHERE user_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM active_order_locks WHERE courier_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM dispatches WHERE courier_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])",[userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[userIds]);
    await pool.query("COMMIT");
  }catch(e){await pool.query("ROLLBACK");throw e}
}
function percentile(p){
  if(!latencies.length)return 0;
  const a=[...latencies].sort((x,y)=>x-y);
  return a[Math.min(a.length-1,Math.floor(a.length*p))];
}

await seed();
try{
  const adminCookie=await login(ADMIN_USERNAME,ADMIN_PASSWORD);
  const cookies=await Promise.all(Array.from({length:COURIERS},(_,i)=>login(`${RUN}_c${i+1}`,TEST_PASSWORD)));

  let running=true;
  const watcher=(async()=>{
    while(running){
      try{
        const rs=await Promise.all([
          call("/api/admin/dashboard",adminCookie),
          call("/api/admin/peak",adminCookie),
          call("/api/admin/history?page=1&page_size=25",adminCookie),
          call("/api/admin/conflicts?limit=20",adminCookie)
        ]);
        dashboardChecks+=rs.length;
        for(const r of rs)if(!r.ok)failures.push(`admin:${r.status}`);
      }catch(e){failures.push(`admin:${e.message}`)}
      await new Promise(r=>setTimeout(r,150));
    }
  })();

  const started=performance.now();

  await Promise.all(cookies.map(async(cookie,c)=>{
    for(let n=1;n<=DEPARTURES;n++){
      const orders=Array.from({length:ORDERS_PER_DEPARTURE},(_,j)=>`#${RUN.toUpperCase()}-${c+1}-${n}-${j+1}`);
      const token=`${RUN}-${c+1}-${n}`;
      const payload={
        order_numbers:orders,
        confirm_new_departure:true,
        confirm_recent_orders:true,
        client_token:token
      };
      const r=await call("/api/courier/depart",cookie,{method:"POST",body:JSON.stringify(payload)});
      if(r.ok){createdDepartures++;createdOrders+=orders.length}
      else failures.push(`depart-c${c+1}-n${n}:${r.status}:${await r.text()}`);

      if(n%10===0){
        const replay=await call("/api/courier/depart",cookie,{method:"POST",body:JSON.stringify(payload)});
        if(!replay.ok)failures.push(`replay:${replay.status}`);
      }
    }
  }));

  running=false;
  await watcher;
  const elapsed=performance.now()-started;

  const active=await pool.query(
    "SELECT COUNT(*)::int AS c FROM dispatches WHERE courier_id=ANY($1::int[]) AND status='ON_ROAD'",
    [userIds]
  );
  const dup=await pool.query(`
    SELECT order_number,COUNT(*) FROM active_order_locks
    WHERE courier_id=ANY($1::int[])
    GROUP BY order_number HAVING COUNT(*)>1
  `,[userIds]);

  const report={
    result:failures.length?"FAIL":"PASS",
    couriers:COURIERS,
    departuresPerCourier:DEPARTURES,
    requestedDepartures:COURIERS*DEPARTURES,
    createdDepartures,
    createdOrders,
    adminConcurrentChecks:dashboardChecks,
    activeDispatchesAtEnd:active.rows[0].c,
    duplicateActiveOrders:dup.rowCount,
    failures:failures.slice(0,20),
    elapsedSeconds:Number((elapsed/1000).toFixed(2)),
    throughputDeparturesPerSecond:Number((createdDepartures/(elapsed/1000)).toFixed(2)),
    latencyMs:{
      p50:Number(percentile(.50).toFixed(1)),
      p95:Number(percentile(.95).toFixed(1)),
      p99:Number(percentile(.99).toFixed(1))
    }
  };
  console.log(JSON.stringify(report,null,2));
  if(failures.length||active.rows[0].c!==COURIERS||dup.rowCount)process.exitCode=1;
}finally{
  await cleanup();
  await pool.end();
}
