/**
 * Mock de mapas SOMENTE no Node do staging efemero. Intercepta exclusivamente
 * a URL Matrix da ORS; nao recebe coordenadas reais ou credenciais.
 * Nunca importar no Render, GitHub main ou producao.
 */
if (process.env.APP_ENV !== "staging" || process.env.STAGING_SAFE_MODE !== "true" ||
    process.env.FRIDAY_MOCK_ORS_ONLY !== "YES" || process.env.NODE_ENV === "production") {
  throw new Error("MOCK ORS bloqueado fora do staging isolado.");
}
const realFetch = globalThis.fetch;
let requests=0;
globalThis.fetch = async (url, init={}) => {
  if (String(url) !== "https://api.heigit.org/openrouteservice/v2/matrix/driving-car")
    return realFetch(url,init);
  const data=JSON.parse(init.body || "{}"), points=data.locations;
  if (!Array.isArray(points)||points.length<2||points.length>6 ||
      points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))
    return new Response(JSON.stringify({error:"bad synthetic matrix"}),{status:400});
  const latency=150+((requests++%6)*100);
  await new Promise(resolve=>setTimeout(resolve,latency));
  const n=points.length;
  const distances=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>{
    if(i===j)return 0;
    const straight=Math.hypot((points[i][0]-points[j][0])*101900,(points[i][1]-points[j][1])*111000);
    return Math.round(straight*(1.16+((i*7+j*11)%8)/40)+50);
  }));
  const durations=distances.map((row,i)=>row.map((meters,j)=>i===j?0:Math.round(40+meters/((23+(i+j)%11)*1000/3600))));
  return new Response(JSON.stringify({durations,distances,
    sources:points.map(()=>({snapped_distance:8})),
    destinations:points.map(()=>({snapped_distance:8}))}),{status:200,headers:{"content-type":"application/json"}});
};
