import pg from "pg";
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8});
const suffix=process.pid+"_"+Date.now();
const t="alert_cycle_"+suffix;
function assert(v,m){if(!v)throw new Error(m)}
try{
 await pool.query(`CREATE TABLE ${t}(id BIGSERIAL PRIMARY KEY,incident TEXT NOT NULL,cycle INT NOT NULL,resolved_at TIMESTAMPTZ,UNIQUE(incident,cycle))`);
 const insert=`INSERT INTO ${t}(incident,cycle) VALUES($1,$2) ON CONFLICT(incident,cycle) DO NOTHING RETURNING id`;
 const first=(await Promise.all(Array.from({length:12},()=>pool.query(insert,["ifood:I1",1])))).reduce((n,r)=>n+r.rowCount,0);
 assert(first===1,`same-cycle duplicate alerts inserted: ${first}`);
 console.log("PASS - same incident cycle creates exactly one alert under concurrency");
 await pool.query(`UPDATE ${t} SET resolved_at=NOW() WHERE incident=$1 AND cycle=$2 AND resolved_at IS NULL`,["ifood:I1",1]);
 const resolved=(await pool.query(`SELECT resolved_at FROM ${t} WHERE incident=$1 AND cycle=1`,["ifood:I1"])).rows[0];
 assert(resolved?.resolved_at,"cycle 1 was not resolved");
 console.log("PASS - resolved incident is explicitly closed");
 const second=await pool.query(insert,["ifood:I1",2]);
 assert(second.rowCount===1,"new retry cycle did not create a new alert");
 console.log("PASS - new retry cycle creates a new alert");
 const again=await pool.query(insert,["ifood:I1",2]);
 assert(again.rowCount===0,"cycle 2 duplicate was inserted");
 console.log("PASS - new cycle remains deduplicated internally");
 const counts=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE resolved_at IS NULL)::int active FROM ${t}`)).rows[0];
 assert(Number(counts.total)===2 && Number(counts.active)===1,"alert lifecycle counts mismatch");
 console.log("PASS - historical alert is preserved while only current cycle stays active");
 console.log("Operational alert DB self-test passed: 5/5.");
}finally{await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(()=>{});await pool.end()}
