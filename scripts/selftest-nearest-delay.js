import assert from 'node:assert/strict';
import { planNearestDelayRoute, greedySequence } from '../lib/route-planner.js';
let checks=0;
const fixture={stops:[{key:'near',age_minutes:0},{key:'urgent',age_minutes:39}],minutes:[[0,2,4],[2,0,3],[4,3,0]]};
assert.deepEqual(planNearestDelayRoute(fixture).best.sequence,['urgent','near']);checks++;
const capped=planNearestDelayRoute({...fixture,returnToStoreMinutes:[10,1]});
assert.deepEqual(capped.best.sequence,['near','urgent']);assert.equal(capped.delay_exception,false);checks+=2;
const fresh=planNearestDelayRoute({...fixture,stops:fixture.stops.map(s=>({...s,age_minutes:0})),minutes:[[0,2,4],[2,0,20],[4,1,0]]});
assert.deepEqual(fresh.best.sequence,['near','urgent']);assert.equal(fresh.delay_exception,false);checks+=2;
for(let n=1;n<=5;n++)for(let seed=0;seed<100;seed++){
 const stops=Array.from({length:n},(_,i)=>({key:i,age_minutes:(seed+i*13)%70}));
 const minutes=Array.from({length:n+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===j?0:1+(i*7+j*11+seed)%17));
 const x={stops,minutes,returnToStoreMinutes:stops.map((_,i)=>1+(i+seed)%9),params:{stop_minutes:2}};
 const p=planNearestDelayRoute(x),base=p.nearest_baseline;
 assert.deepEqual(base.order,greedySequence(n,(prev,next)=>minutes[prev][next+1]));checks++;
 assert.ok(p.best.duration_minutes<=base.duration_minutes+p.max_extra_minutes+1e-9);checks++;
 if(!p.risk_stop_indices.length){assert.deepEqual(p.best.order,base.order);checks++;}
 for(const s of p.best.stops){const b=base.stops.find(t=>t.stop===s.stop);
   assert.ok(!(b.excess_minutes===0&&s.excess_minutes>0));checks++;
   if(p.risk_stop_indices.includes(s.stop)){assert.ok(s.wait_minutes<=b.wait_minutes+1e-9);checks++;}
 }
 if(p.delay_exception){assert.ok(p.risk_stop_indices.length>0);assert.ok(p.best.stops.some(s=>p.risk_stop_indices.includes(s.stop)&&s.wait_minutes<base.stops.find(t=>t.stop===s.stop).wait_minutes-1e-9));checks+=2;}
 assert.deepEqual(planNearestDelayRoute(x).best.sequence,p.best.sequence);checks++;
}
for(const age of [37.999,38]){const p=planNearestDelayRoute({stops:[{key:0,age_minutes:age}],minutes:[[0,2],[2,0]]});assert.equal(p.risk_stop_indices.length,Number(age>=38));checks++;}
assert.throws(()=>planNearestDelayRoute({...fixture,returnToStoreMinutes:[1,null]}),{code:'ROUTE_MATRIX_INCOMPLETE'});checks++;
console.log(`PASS ${checks} verificações: proximidade estrita, risco, exceções, limite de desvio, retorno e determinismo.`);
