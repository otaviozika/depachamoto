/**
 * Deterministic, no-network stress model of ORS Matrix reservation capacity.
 * Imports production guard limits; DOES NOT query provider or database.
 * Real concurrency/HTTP and DB reservation correctness live in separate suites.
 */
import assert from "node:assert/strict";
import {ROUTE_MATRIX_BUDGET} from "../lib/route-quota.js";

const perMinute=ROUTE_MATRIX_BUDGET.perMinute;
const perDay=ROUTE_MATRIX_BUDGET.perDay;
const maxQueueWaitMs=ROUTE_MATRIX_BUDGET.maxQueueWaitMs;
assert.equal(perMinute,38);
assert.equal(perDay,450);
assert.equal(maxQueueWaitMs,3500);

function quotaSim(requestTimes) {
  const slots=[];
  const ordered=[...requestTimes].sort((a,b)=>a-b);
  let accepted=0,minuteBlocked=0,dailyBlocked=0;
  for(const at of ordered) {
    const lastMinute=slots.filter(t=>t>at-60000&&t<=at).length;
    const lastDay=slots.filter(t=>t>at-86400000&&t<=at).length;
    if(lastDay>=perDay) {dailyBlocked++;continue;}
    if(lastMinute>=perMinute) {minuteBlocked++;continue;}
    slots.push(at);accepted++;
  }
  return {attempts:requestTimes.length,accepted,minuteBlocked,dailyBlocked,
    manualSequenceRequired:minuteBlocked+dailyBlocked};
}
const SPAN=5*3600*1000;
function spreadCalls(n) {return Array.from({length:n},(_,i)=>Math.floor(i*SPAN/n));}
const scenarios=[
  {id:"600_individual_deliveries",orders:600,deliveriesPerRun:1,routeCalculations:600,recalculations:0},
  {id:"600_as_300_pairs",orders:600,deliveriesPerRun:2,routeCalculations:300,recalculations:0},
  {id:"600_pairs_plus_100_recalculations",orders:600,deliveriesPerRun:2,routeCalculations:300,recalculations:100},
  {id:"600_pairs_plus_150_recalculations",orders:600,deliveriesPerRun:2,routeCalculations:300,recalculations:150},
  {id:"600_pairs_plus_200_recalculations",orders:600,deliveriesPerRun:2,routeCalculations:300,recalculations:200},
  {id:"600_as_200_triples_plus_100_recalculations",orders:600,deliveriesPerRun:3,routeCalculations:200,recalculations:100}
];
const results=scenarios.map(c=>{
  const m=quotaSim(spreadCalls(c.routeCalculations+c.recalculations));
  return {...c,...m};
});
const byId=Object.fromEntries(results.map(r=>[r.id,r]));
assert.deepEqual([byId["600_individual_deliveries"].accepted,byId["600_individual_deliveries"].dailyBlocked],[450,150]);
assert.deepEqual([byId["600_as_300_pairs"].accepted,byId["600_as_300_pairs"].manualSequenceRequired],[300,0]);
assert.deepEqual([byId["600_pairs_plus_100_recalculations"].accepted,byId["600_pairs_plus_100_recalculations"].manualSequenceRequired],[400,0]);
assert.deepEqual([byId["600_pairs_plus_150_recalculations"].accepted,byId["600_pairs_plus_150_recalculations"].manualSequenceRequired],[450,0]);
assert.deepEqual([byId["600_pairs_plus_200_recalculations"].accepted,byId["600_pairs_plus_200_recalculations"].dailyBlocked],[450,50]);
assert.deepEqual([byId["600_as_200_triples_plus_100_recalculations"].accepted,byId["600_as_200_triples_plus_100_recalculations"].manualSequenceRequired],[300,0]);
assert.ok(results.every(x=>x.minuteBlocked===0),"Evenly spread scenario unexpectedly hit minute cap");

const burst=quotaSim(Array.from({length:48},()=>0));
assert.equal(burst.accepted,38);
assert.equal(burst.minuteBlocked,10);
assert.equal(burst.dailyBlocked,0);
const shortlyAfter=quotaSim([...Array.from({length:38},()=>0),60000-1]);
assert.equal(shortlyAfter.minuteBlocked,1,"60-second sliding window must block until expiration");
const afterMinute=quotaSim([...Array.from({length:38},()=>0),60001]);
assert.equal(afterMinute.accepted,39);
const crossingMidnight=quotaSim([...spreadCalls(perDay).map(t=>t+18*3600*1000),24*3600*1000+1]);
assert.equal(crossingMidnight.dailyBlocked,1,"Rolling 24h quota must not reset at midnight");
const after24hours=quotaSim([0,24*3600*1000+1]);
assert.equal(after24hours.accepted,2);
console.log("FRIDAY_ROUTE_CAPACITY_MODEL_START");
console.log(JSON.stringify({result:"PASS",kind:"DETERMINISTIC_QUOTA_MODEL_NOT_LIVE_PROVIDER",
  orders:600,couriersAtPeak:36,
  providerPlan:"ORS Standard free (500 Matrix/day, 40/min)",
  appSafetyBudget:{perMinute,perDay,maxQueueWaitMs},
  scenarios:results,burst:{simultaneousCouriers:36,extraRequests:12,...burst},
  utcMidnightGuard:true,rolling24hGuard:true,providerRequests:0,productionAccess:false,
  limitations:["Matrix calls only; address geocoding has a separate quota",
    "Manual/admin route sequence remains required when quota is unavailable",
    "Cannot infer actual arrival times or ORS performance at 600-order load",
    "Actual provider account quota can be shared with other applications"]
},null,2));
console.log("FRIDAY_ROUTE_CAPACITY_MODEL_END");
