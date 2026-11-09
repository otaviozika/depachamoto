import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesceSessionTouches } from "../lib/session-touch-coalescer.js";

function fakeStore(){
  const rows=new Map(),counts={touch:0,set:0,destroy:0};
  return {
    counts,rows,
    touch(sid,session,callback){counts.touch++;queueMicrotask(()=>callback());},
    set(sid,session,callback){counts.set++;rows.set(sid,session);queueMicrotask(()=>callback?.());},
    destroy(sid,callback){counts.destroy++;rows.delete(sid);queueMicrotask(()=>callback?.());}
  };
}
const touch=(s,id)=>new Promise((resolve,reject)=>s.touch(id,{cookie:{originalMaxAge:43200000}},err=>err?reject(err):resolve()));
const set=(s,id)=>new Promise((resolve,reject)=>s.set(id,{user:{id}},err=>err?reject(err):resolve()));
const destroy=(s,id)=>new Promise((resolve,reject)=>s.destroy(id,err=>err?reject(err):resolve()));

test("40 sessions x 60 requests reduce redundant TTL writes, never bypass get/set",async()=>{
  let t=0;const store=fakeStore();const {stats}=coalesceSessionTouches(store,{now:()=>t,intervalMs:30_000});
  for(let i=0;i<40;i++){
    const sid="synthetic-"+i;
    await set(store,sid);
    for(let n=0;n<60;n++)await touch(store,sid);
  }
  assert.equal(store.counts.set,40);
  assert.equal(store.counts.touch,40);
  assert.equal(stats.skips,40*59);
  assert.equal(store.rows.size,40);
  console.log("STAGE8_SESSION_TOUCH_BENCHMARK "+JSON.stringify({
    result:"PASS",synthetic_sessions:40,synthetic_requests:2400,
    baseline_ttl_writes:2400,throttled_ttl_writes:stats.writes,
    redundant_writes_avoided:stats.skips,savings_pct:98.33,
    caveat:"Isolated fake store; not measured Supabase Egress or real session expiration"
  }));
});

test("session touch expires after interval; set/destroy invalidate coalescing",async()=>{
  let t=0;const store=fakeStore();coalesceSessionTouches(store,{now:()=>t,intervalMs:30_000});
  await touch(store,"alice");await touch(store,"alice");
  assert.equal(store.counts.touch,1);
  t=30_001;await touch(store,"alice");assert.equal(store.counts.touch,2);
  await set(store,"alice");await touch(store,"alice");assert.equal(store.counts.touch,3);
  await destroy(store,"alice");await touch(store,"alice");assert.equal(store.counts.touch,4);
});

test("coalesces in-flight concurrent touches and preserves callback completion",async()=>{
  let remoteDone=null,remoteCalls=0;
  const store={
    touch(_sid,_session,callback){remoteCalls++;remoteDone=callback;},
    destroy(_sid,cb){cb?.();},
    set(_sid,_session,cb){cb?.();}
  };
  const {stats}=coalesceSessionTouches(store,{now:()=>100,intervalMs:30_000});
  const promises=Array.from({length:32},()=>touch(store,"concurrent"));
  assert.equal(remoteCalls,1);
  remoteDone();
  await Promise.all(promises);
  assert.equal(stats.coalesced,31);
  assert.equal(stats.writes,1);
});

test("touch failure does not cache success and retries later",async()=>{
  let failures=1;
  const store={
    touch(_sid,_s,callback){queueMicrotask(()=>callback(failures-->0?Error("db unavailable"):undefined));},
    set(_sid,_s,callback){queueMicrotask(()=>callback?.());},
    destroy(_sid,callback){queueMicrotask(()=>callback?.());}
  };
  const {stats}=coalesceSessionTouches(store,{now:()=>50,intervalMs:30_000});
  await assert.rejects(touch(store,"alice"),/db unavailable/);
  await touch(store,"alice");
  assert.equal(stats.writes,2);
  assert.equal(stats.errors,1);
});

test("invalid settings fail closed",()=>{
  assert.throws(()=>coalesceSessionTouches(fakeStore(),{intervalMs:0}),RangeError);
  assert.throws(()=>coalesceSessionTouches(fakeStore(),{intervalMs:120_000}),RangeError);
});
