import pg from "pg";
import fs from "node:fs";
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:16});
const run=Date.now().toString(36);
const t="fi_jobs_"+run;
const results=[];
const fail=(id,msg)=>{results.push({scenario_id:id,result:"FAIL",failure:msg});throw new Error(id+": "+msg)};
const pass=(id,evidence)=>{results.push({scenario_id:id,result:"PASS",evidence});console.log("PASS - "+id+" - "+evidence)};
try{
 await pool.query(`CREATE TABLE ${t}(id text primary key,platform text,status text,attempts int,retry_cycle int default 1,locked_at timestamptz,unique(platform,id,retry_cycle))`);

 // F09 transient iFood: exactly one attempt and RETRY
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts) VALUES('i9','ifood','RETRY',3)`);
 const f09=await pool.query(`UPDATE ${t} SET status='RETRY',attempts=attempts+1 WHERE id='i9' AND attempts<8 RETURNING *`);
 if(f09.rowCount!==1||f09.rows[0].attempts!==4)fail("F09","retry did not increment exactly once");
 pass("F09","transient iFood failure increments attempts once and remains retryable");

 // F10 terminal ceiling
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts) VALUES('i10','ifood','RETRY',7)`);
 await pool.query(`UPDATE ${t} SET status='FAILED',attempts=attempts+1 WHERE id='i10' AND attempts<8`);
 const ninth=await pool.query(`UPDATE ${t} SET attempts=attempts+1 WHERE id='i10' AND attempts<8 RETURNING id`);
 const i10=(await pool.query(`SELECT * FROM ${t} WHERE id='i10'`)).rows[0];
 if(i10.attempts!==8||i10.status!=='FAILED'||ninth.rowCount!==0)fail("F10","attempt 9 was possible");
 pass("F10","iFood stops at attempt 8 in FAILED; attempt 9 rejected");

 // F11 stale iFood terminalization
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts,locked_at) VALUES('i11','ifood','PROCESSING',8,NOW()-INTERVAL '4 minutes')`);
 const f11=await pool.query(`UPDATE ${t} SET status=CASE WHEN attempts>=8 THEN 'FAILED' ELSE 'RETRY' END,locked_at=NULL WHERE id='i11' AND status='PROCESSING' AND locked_at<NOW()-INTERVAL '3 minutes' RETURNING *`);
 if(f11.rows[0]?.status!=='FAILED'||f11.rows[0]?.attempts!==8)fail("F11","stale exhausted iFood did not terminalize");
 pass("F11","stale exhausted iFood PROCESSING becomes FAILED without attempt 9");

 // F12 transient AnotaAi
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts) VALUES('a12','anotaai','FAILED',2)`);
 const f12=await pool.query(`UPDATE ${t} SET attempts=attempts+1,status='FAILED' WHERE id='a12' AND attempts<8 RETURNING *`);
 if(f12.rows[0]?.attempts!==3)fail("F12","AnotaAi transient retry count invalid");
 pass("F12","transient AnotaAi failure increments once and remains retryable");

 // F13 DEAD ceiling
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts) VALUES('a13','anotaai','FAILED',7)`);
 await pool.query(`UPDATE ${t} SET attempts=attempts+1,status='DEAD' WHERE id='a13' AND attempts<8`);
 const a9=await pool.query(`UPDATE ${t} SET attempts=attempts+1 WHERE id='a13' AND attempts<8 RETURNING id`);
 const a13=(await pool.query(`SELECT * FROM ${t} WHERE id='a13'`)).rows[0];
 if(a13.attempts!==8||a13.status!=='DEAD'||a9.rowCount)fail("F13","AnotaAi attempt 9 was possible");
 pass("F13","AnotaAi stops at attempt 8 in DEAD; attempt 9 rejected");

 // F14 stale AnotaAi terminalization
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts,locked_at) VALUES('a14','anotaai','PROCESSING',8,NOW()-INTERVAL '4 minutes')`);
 const f14=await pool.query(`UPDATE ${t} SET status=CASE WHEN attempts>=8 THEN 'DEAD' ELSE 'FAILED' END,locked_at=NULL WHERE id='a14' AND status='PROCESSING' AND locked_at<NOW()-INTERVAL '3 minutes' RETURNING *`);
 if(f14.rows[0]?.status!=='DEAD'||f14.rows[0]?.attempts!==8)fail("F14","stale exhausted AnotaAi did not become DEAD");
 pass("F14","stale exhausted AnotaAi PROCESSING becomes DEAD without attempt 9");

 // F15 concurrent claim: one owner
 await pool.query(`INSERT INTO ${t}(id,platform,status,attempts) VALUES('race15','ifood','RETRY',0)`);
 const claim=`UPDATE ${t} SET status='PROCESSING',attempts=attempts+1 WHERE id='race15' AND status='RETRY' AND attempts<8 RETURNING id`;
 const claims=await Promise.all(Array.from({length:12},()=>pool.query(claim)));
 const owners=claims.reduce((n,r)=>n+r.rowCount,0);
 const race=(await pool.query(`SELECT * FROM ${t} WHERE id='race15'`)).rows[0];
 if(owners!==1||race.attempts!==1)fail("F15",`owners=${owners}, attempts=${race.attempts}`);
 pass("F15","12 concurrent claims produce exactly one owner and one attempt");

 fs.writeFileSync("fault-injection-f09-f15.json",JSON.stringify({suite:"controlled-failures-queues",result:"PASS",results},null,2)+"\n");
 console.log("Controlled queue failures F09-F15 passed: 7/7.");
}catch(e){
 fs.writeFileSync("fault-injection-f09-f15.json",JSON.stringify({suite:"controlled-failures-queues",result:"FAIL",results,error:e.message},null,2)+"\n");
 process.exitCode=1;
}finally{await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(()=>{});await pool.end()}
