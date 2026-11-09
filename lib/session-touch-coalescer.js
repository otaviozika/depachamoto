// Staging-only optional coalescing of session TTL refreshes.
// Does not cache session contents or bypass get(), set(), destroy() or account checks.
// Defaults to OFF; production is unconditionally excluded by the caller.
export function coalesceSessionTouches(store, { intervalMs=30_000, now=Date.now, maxEntries=5_000 }={}){
  if(!store||typeof store.touch!=="function"||typeof store.destroy!=="function"||typeof store.set!=="function")
    throw new TypeError("Session store must implement touch/destroy/set");
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60_000)
    throw new RangeError("intervalMs must be 1-60 seconds");
  const recent=new Map(),pending=new Map();
  const touch=store.touch.bind(store),destroy=store.destroy.bind(store),set=store.set.bind(store);
  const stats={writes:0,skips:0,coalesced:0,errors:0};
  function trim(){
    while(recent.size>maxEntries)recent.delete(recent.keys().next().value);
  }
  store.touch=function(sid,session,cb){
    const callback=typeof cb==="function"?cb:()=>{};
    const age=now()-(recent.get(sid)??-Infinity);
    if(age>=0&&age<intervalMs){
      stats.skips++;
      queueMicrotask(()=>callback());
      return;
    }
    const ongoing=pending.get(sid);
    if(ongoing){stats.coalesced++;ongoing.callbacks.push(callback);return;}
    const pendingRecord={callbacks:[callback]};
    pending.set(sid,pendingRecord);
    stats.writes++;
    try{
      touch(sid,session,error=>{
        const stillCurrent=pending.get(sid)===pendingRecord;
        if(stillCurrent) pending.delete(sid);
        if(error)stats.errors++;
        if(stillCurrent){
          recent.delete(sid);
          if(!error){recent.set(sid,now());trim();}
        }
        for(const done of pendingRecord.callbacks)done(error);
      });
    }catch(error){
      if(pending.get(sid)===pendingRecord){pending.delete(sid);recent.delete(sid);}
      stats.errors++;
      for(const done of pendingRecord.callbacks)done(error);
    }
  };
  store.set=function(sid,session,cb){
    recent.delete(sid);
    pending.delete(sid);
    return set(sid,session,cb);
  };
  store.destroy=function(sid,cb){
    recent.delete(sid);
    pending.delete(sid);
    return destroy(sid,cb);
  };
  return {store,stats};
}
