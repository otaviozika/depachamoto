// Stage 8 deployment guard for an independent, never-production Render Free web service.
// There are no public app routes until a dedicated, safe database is configured.
import http from "node:http";
const EXPECTED_PROJECT = "yubiztqoaunkbexrfwhq";
function fail(message){
  console.error("STAGE8_BOOT_BLOCKED:",message);
  process.exitCode=1;
  throw new Error("STAGE8_BOOT_BLOCKED: "+message);
}
if(process.env.APP_ENV!=="staging" ||
   String(process.env.STAGING_SAFE_MODE).toLowerCase()!=="true" ||
   String(process.env.STAGE8_ISOLATED).toLowerCase()!=="true") {
  // The condition above must be explicit, so this branch cannot run as production.
  fail("isolated staging flags required");
}
if(process.env.NODE_ENV!=="production")fail("Node production runtime required");
if(process.env.DATABASE_URL){
  let url;
  try{url=new URL(process.env.DATABASE_URL);}catch{fail("invalid DATABASE_URL");}
  const username=decodeURIComponent(url.username || "");
  if(!["postgres:","postgresql:"].includes(url.protocol) ||
     !username.endsWith("."+EXPECTED_PROJECT) ||
     !url.hostname.endsWith(".pooler.supabase.com") ||
     url.port!=="5432" || url.pathname!=="/postgres" ||
     !url.password)fail("connection is not the isolated Supabase session pooler");
  console.log("STAGE8_BOOT_GUARD_OK isolated pooler configured; starting application");
  await import("../server.js");
}else{
  const server=http.createServer((req,res)=>{
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Robots-Tag","noindex, nofollow");
    res.setHeader("Access-Control-Allow-Origin","none");
    const live=req.url==="/api/live";
    res.statusCode=live?200:503;
    res.end(JSON.stringify({
      status:"waiting_for_isolated_database",stagingSafeMode:true,
      applicationRunning:false,productionTouched:false
    }));
  });
  server.listen(Number(process.env.PORT || 10000),"0.0.0.0",()=>{
    console.log("STAGE8_PROVISIONING_ONLY safe startup; no DespacheFull endpoints exposed");
  });
}
