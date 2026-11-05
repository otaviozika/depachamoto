import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {include} from './egress-test-support.js';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
let active=0,peak=0,audits=0,auditFailures=0,releases=0;
const waiting=[],events=[];
async function acquire(){
  if(active<2){active++;peak=Math.max(peak,active);return;}
  await new Promise((resolve,reject)=>{const waiter={resolve:()=>{clearTimeout(waiter.timer);resolve();}};waiter.timer=setTimeout(()=>{waiting.splice(waiting.indexOf(waiter),1);reject(Error('Synthetic pool starvation'));},500);waiting.push(waiter);});
}
function release(){releases++;const next=waiting.shift();if(next)next.resolve();else active--;}
const records=new Map(Array.from({length:30},(_,i)=>[i+1,{id:i+1,courier_id:i+2,status:'ON_ROAD'}]));
const pool={
  async connect(){await acquire();let released=false;return {
    async query(sql,args=[]){await Promise.resolve();let rows=[];
      if(sql.includes('SELECT * FROM dispatches')){const r=records.get(Number(args[0]));rows=r?.status==='ON_ROAD'?[r]:[];}
      if(sql.includes('UPDATE dispatches')){const r=records.get(Number(args[0]));r.status='RELEASED';rows=[r];}
      return {rows,rowCount:rows.length};
    },release(){assert.equal(released,false);released=true;release();}
  };},
  async query(){const client=await pool.connect();try{audits++;return {rows:[],rowCount:1};}finally{client.release();}}
};
const context=vm.createContext({pool,console,
  getDispatchProgressMap:async ids=>new Map(ids.map(id=>[Number(id),{all_orders_resolved:true}])),
  auditBestEffort:async()=>{try{await pool.query('INSERT audit');}catch{auditFailures++;}},
  emitRealtime:(event,body)=>events.push({event,body})
});
include(context,source,'async function completeDispatchReturn(','async function getSPDate()');
const results=await Promise.allSettled([...records.keys()].map(dispatchId=>context.completeDispatchReturn({dispatchId,actorUserId:1,source:'ADMIN_PENDING_DELIVERIES_OVERRIDE',reason:'Synthetic concurrent return'})));
assert.equal(results.filter(r=>r.status==='fulfilled').length,30,'Every concurrent return must finish');
assert.equal(auditFailures,0,'Audit must not starve while returns retain all connection slots');
assert.equal(audits,30);assert.equal(events.length,30);assert.equal(active,0);assert.equal(waiting.length,0);assert.equal(peak,2);assert.equal(releases,60);
const duplicate=await context.completeDispatchReturn({dispatchId:1,actorUserId:1});assert.equal(duplicate,null);assert.equal(events.length,30);assert.equal(active,0);
console.log(JSON.stringify({result:'PASS',concurrentReturns:30,poolMax:2,audits,timeoutErrors:0,duplicateReturnSafe:true}));
