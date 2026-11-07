/**
 * Injects deterministic ORS faults ONLY inside the ephemeral GitHub staging process.
 * Never load on a Render service, production, or a machine with real credentials.
 * Uses synthetic sentinel coordinates to choose fault without exposing customer data.
 */
const required={
  APP_ENV:"staging",STAGING_SAFE_MODE:"true",NODE_ENV:"test",
  LOAD_TEST_CONFIRM:"STAGING_ONLY_I_UNDERSTAND",
  ROUTE_CHAOS_MOCK_ONLY:"YES",
  OPENROUTESERVICE_API_KEY:"CHAOS_SYNTHETIC_STAGING_ONLY"
};
for(const [k,v] of Object.entries(required)){
  if(process.env[k]!==v)throw new Error("CHAOS_MOCK_REFUSED: "+k);
}
const target="https://api.heigit.org/openrouteservice/v2/matrix/driving-car";
let sent=0;
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  if(String(url)!==target){
    // This test server has no reason to contact external domains.
    const host=(()=>{try{return new URL(String(url)).hostname}catch{return ""}})();
    if(!["127.0.0.1","localhost"].includes(host))throw new Error("CHAOS_MOCK_BLOCKED_EXTERNAL_FETCH");
    return fetchOriginal(url,options);
  }
  const pts=JSON.parse(options.body||"{}").locations;
  if(!Array.isArray(pts)||pts.length<2||pts.length>6||
    pts.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))
    throw new Error("CHAOS_MOCK_REFUSED_NON_SYNTHETIC_POINTS");
  const marker=pts.slice(1).map(p=>p[1]);
  const has=n=>marker.some(v=>Math.abs(v-n)<0.0000001);
  sent++;
  if(has(-23.61111))return new Response(JSON.stringify({error:"Injected 429"}),{status:429,headers:{"content-type":"application/json"}});
  if(has(-23.62222))return new Response(JSON.stringify({error:"Injected 503"}),{status:503,headers:{"content-type":"application/json"}});
  if(has(-23.63333))throw new TypeError("Synthetic network disconnect");
  if(has(-23.64444)){
    const n=pts.length;
    const d=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?0:(i===1&&j===2?null:170+i*16+j*5)));
    return new Response(JSON.stringify({durations:d,distances:d.map(row=>row.map(v=>v===null?null:v*6))}),
      {status:200,headers:{"content-type":"application/json"}});
  }
  if(has(-23.67777)){
    // Headers arrive immediately; body hangs until the request deadline.
    // This must be handled as ROUTES_SERVICE_FAILED, not an unhandled HTTP 500.
    const stream=new ReadableStream({
      start(controller) {
        const signal=options.signal;
        if(signal?.aborted)controller.error(new Error("Synthetic body timeout"));
        else signal?.addEventListener("abort",()=>controller.error(new Error("Synthetic body timeout")),{once:true});
      }
    });
    return new Response(stream,{status:200,headers:{"content-type":"application/json"}});
  }
  if(has(-23.65555)){
    // Simulate 20s provider timeout, honor the actual AbortSignal.timeout().
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,22500);
      if(options.signal){
        if(options.signal.aborted){clearTimeout(timer);reject(new Error("Synthetic timeout"));}
        else options.signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("Synthetic timeout"))},{once:true});
      }
    });
    throw new Error("Slow synthetic request unexpectedly completed");
  }
  const n=pts.length;
  const dist=pts.map((a,i)=>pts.map((b,j)=>i===j?0:Math.round(Math.hypot((a[0]-b[0])*102000,(a[1]-b[1])*111000)*1.25+60)));
  const durations=dist.map((row,i)=>row.map((m,j)=>i===j?0:Math.round(48+m/7.2)));
  return new Response(JSON.stringify({durations,distances:dist,
    sources:pts.map(()=>({snapped_distance:11})),destinations:pts.map(()=>({snapped_distance:11}))}),
    {status:200,headers:{"content-type":"application/json"}});
};
process.on("exit",()=>{if(sent>0)console.log("CHAOS_MATRIX_INTERCEPTED="+sent);});
