import assert from 'node:assert/strict';
import { planFastestRoute, permutations } from '../lib/route-planner.js';
let checks = 0;
for (let n = 1; n <= 5; n++) for (let seed = 0; seed < 100; seed++) {
  const stops = Array.from({length:n}, (_,i)=>({key:i,age_minutes:(seed+i*17)%90}));
  const minutes = Array.from({length:n+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===j?0:1+(i*13+j*7+seed*3)%19));
  const returns=stops.map((_,i)=>1+(seed+i*11)%23);
  const input={stops,minutes,returnToStoreMinutes:returns,params:{stop_minutes:2,include_return:false,alpha:0,beta:1,gamma:10}};
  const result=planFastestRoute(input);
  const oracle=Math.min(...permutations(n).map(order=>{
    let sum=2*n,prev=0;
    for(const i of order){sum+=minutes[prev][i+1];prev=i+1;}
    return sum+returns[order.at(-1)];
  }));
  assert.equal(result.best.duration_minutes,oracle);
  assert.equal(result.best.return_minutes,returns[result.best.order.at(-1)]);
  assert.deepEqual(planFastestRoute({...input,stops:stops.map(s=>({...s,age_minutes:999-s.age_minutes}))}).best.order,result.best.order);
  assert.equal(result.extra_minutes,0);
  checks+=4;
}
const stops=[{key:'a',age_minutes:0},{key:'b',age_minutes:99}];
const minutes=[[0,1,1],[50,0,1],[1,1,0]];
assert.deepEqual(planFastestRoute({stops,minutes,returnToStoreMinutes:[1,50]}).best.sequence,['b','a']);
assert.deepEqual(planFastestRoute({stops,minutes:[[0,1,1],[1,0,1],[1,1,0]]}).best.sequence,['a','b']);
for(const bad of [[1], [1,null], [1,-1], [1,Infinity]])assert.throws(()=>planFastestRoute({stops,minutes,returnToStoreMinutes:bad}),{code:'ROUTE_MATRIX_INCOMPLETE'});
console.log(`PASS ${checks+6} verificações: ótimo exato, retorno independente, idade ignorada, empate e falhas.`);
