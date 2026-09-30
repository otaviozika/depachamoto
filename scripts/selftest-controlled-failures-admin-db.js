import pg from "pg";
import fs from "node:fs";
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:16});
const run=Date.now().toString(36);
const incidents="fi_incidents_"+run, ledger="fi_ledger_"+run;
const results=[];
function ok(id,evidence){results.push({scenario_id:id,result:"PASS",evidence});console.log("PASS - "+id+" - "+evidence)}
function bad(id,msg){results.push({scenario_id:id,result:"FAIL",failure:msg});throw new Error(id+": "+msg)}
try{
 await pool.query(`CREATE TABLE ${incidents}(id text primary key,status text,version int default 1)`);
 await pool.query(`CREATE TABLE ${ledger}(id serial primary key,op text unique,value int)`);

 // F16 two admins: one compare-and-set winner, one conflict
 await pool.query(`INSERT INTO ${incidents}(id,status) VALUES('f16','PROCESSING')`);
 const recover=`UPDATE ${incidents} SET status='RETRY',version=version+1 WHERE id='f16' AND status='PROCESSING' RETURNING *`;
 const two=await Promise.all([pool.query(recover),pool.query(recover)]);
 const winners=two.filter(r=>r.rowCount===1).length, conflicts=two.filter(r=>r.rowCount===0).length;
 if(winners!==1||conflicts!==1)bad("F16",`winners=${winners}, conflicts=${conflicts}`);
 ok("F16","two simultaneous recoveries yield one winner and one compare-and-set conflict");

 // F17 state changes after UI read but before admin action
 await pool.query(`INSERT INTO ${incidents}(id,status) VALUES('f17','PROCESSING')`);
 const snapshot=(await pool.query(`SELECT status,version FROM ${incidents} WHERE id='f17'`)).rows[0];
 await pool.query(`UPDATE ${incidents} SET status='SENT',version=version+1 WHERE id='f17'`);
 const stale=await pool.query(`UPDATE ${incidents} SET status='RETRY',version=version+1 WHERE id='f17' AND status=$1 AND version=$2 RETURNING *`,[snapshot.status,snapshot.version]);
 const current=(await pool.query(`SELECT status FROM ${incidents} WHERE id='f17'`)).rows[0];
 if(stale.rowCount!==0||current.status!=='SENT')bad("F17","stale admin action overwrote newer state");
 ok("F17","stale UI action updates zero rows and preserves newer SENT state");

 // F18 transaction fails midway: rollback all partial writes
 const client=await pool.connect();
 try{
   await client.query("BEGIN");
   await client.query(`INSERT INTO ${ledger}(op,value) VALUES('f18',1)`);
   await client.query(`INSERT INTO ${ledger}(op,value) VALUES('f18',2)`); // deliberate unique violation
   await client.query("COMMIT");
   bad("F18","deliberate transaction fault did not fail");
 }catch{
   await client.query("ROLLBACK").catch(()=>{});
 }finally{client.release()}
 const partial=Number((await pool.query(`SELECT COUNT(*)::int c FROM ${ledger} WHERE op='f18'`)).rows[0].c);
 if(partial!==0)bad("F18",`partial writes survived rollback: ${partial}`);
 await pool.query(`INSERT INTO ${ledger}(op,value) VALUES('f18-recovery',3)`);
 const recovered=Number((await pool.query(`SELECT COUNT(*)::int c FROM ${ledger} WHERE op='f18-recovery'`)).rows[0].c);
 if(recovered!==1)bad("F18","database did not accept clean operation after rollback");
 ok("F18","mid-transaction fault rolls back completely and database remains usable");

 fs.writeFileSync("fault-injection-f16-f18.json",JSON.stringify({suite:"controlled-failures-admin-transaction",result:"PASS",results},null,2)+"\n");
 console.log("Controlled failure scenarios F16-F18 passed: 3/3.");
}catch(e){
 fs.writeFileSync("fault-injection-f16-f18.json",JSON.stringify({suite:"controlled-failures-admin-transaction",result:"FAIL",results,error:e.message},null,2)+"\n");
 process.exitCode=1;
}finally{
 await pool.query(`DROP TABLE IF EXISTS ${incidents}`).catch(()=>{});
 await pool.query(`DROP TABLE IF EXISTS ${ledger}`).catch(()=>{});
 await pool.end();
}
