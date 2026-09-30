import {spawn} from "node:child_process";
import fs from "node:fs";
const stateFile="/tmp/despachefull-loadtest-state.json";
const profiles=[
 {level:"L1",couriers:20,departures:4,orders:2},
 {level:"L2",couriers:40,departures:20,orders:2},
 {level:"L3",couriers:80,departures:20,orders:3},
 {level:"L4",couriers:100,departures:12,orders:3}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const requestedLevel=String(process.env.LOADTEST_LEVEL_ONLY||"L1").toUpperCase();
const selectedProfiles=profiles.filter(p=>p.level===requestedLevel);
if(selectedProfiles.length!==1) throw new Error(`LOADTEST_LEVEL_ONLY inválido: ${requestedLevel}`);
function state(x){fs.writeFileSync(stateFile,JSON.stringify({...x,updatedAt:new Date().toISOString()}))}
for(const p of selectedProfiles){
 state({active:true,state:"INICIANDO",level:p.level,couriers:p.couriers,requests:0,rps:0,p50:0,p95:0,p99:0,http5xx:0,lost:0,duplicates:0,orphanLocks:0,corruption:0,integrity:"100%"});
 console.log(`=== ${p.level} START: ${p.couriers} couriers x ${p.departures} departures x ${p.orders} orders ===`);
 const code=await new Promise(resolve=>{
  const child=spawn(process.execPath,["scripts/loadtest-staging-50.js"],{stdio:"inherit",env:{...process.env,
    TARGET_URL:"https://despachefull-staging.onrender.com",
    LOADTEST_ADMIN_USERNAME:process.env.ADMIN_USERNAME||"stagingadmin",
    LOADTEST_ADMIN_PASSWORD:process.env.ADMIN_PASSWORD||"",
    LOAD_TEST_CONFIRM:"STAGING_ONLY_I_UNDERSTAND",
    LOADTEST_LEVEL:p.level,LOADTEST_STATE_FILE:stateFile,
    COURIERS:String(p.couriers),DEPARTURES_PER_COURIER:String(p.departures),ORDERS_PER_DEPARTURE:String(p.orders)
  }});
  child.on("exit",c=>resolve(c??1));
 });
 if(code!==0){state({active:false,state:"FALHOU",level:p.level,integrity:"FALHOU"});process.exit(code)}
 console.log(`=== ${p.level} PASS ===`);
 await sleep(8000);
}
const last=JSON.parse(fs.readFileSync(stateFile,"utf8"));
state({...last,active:false,state:"CONCLUÍDO",level:requestedLevel,integrity:"100%"});
console.log(`LOAD TEST 4.8 COMPLETE: ${requestedLevel} PASS; no automatic escalation`);
