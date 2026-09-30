import {spawn} from "node:child_process";
import fs from "node:fs";

const stateFile="/tmp/despachefull-loadtest-state.json";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const requestedLevel=String(process.env.LOADTEST_LEVEL_ONLY||"L1").toUpperCase();

if(requestedLevel!=="L1"){
  throw new Error("Etapa 4.8 bloqueada: somente L1 pode ser executado antes da aprovação explícita.");
}

function state(x){
  fs.writeFileSync(stateFile,JSON.stringify({...x,updatedAt:new Date().toISOString()}));
}
function currentState(){
  try{return JSON.parse(fs.readFileSync(stateFile,"utf8"))}
  catch{return {}}
}

state({
  active:true,state:"PRÉ-CHECK",level:"L1",couriers:20,
  requests:0,rps:0,p50:null,p95:null,p99:null,http5xx:0,
  lost:null,duplicates:null,orphanLocks:null,corruption:null,integrity:"PENDENTE"
});

console.log("=== L1 REALISTA START: 20 motoboys / 15 min / 64 saídas / mix 1-2 pedidos ===");
const code=await new Promise(resolve=>{
  const child=spawn(process.execPath,["scripts/loadtest-staging-50.js"],{
    stdio:"inherit",
    env:{
      ...process.env,
      TARGET_URL:"https://despachefull-staging.onrender.com",
      LOADTEST_ADMIN_USERNAME:process.env.ADMIN_USERNAME||"stagingadmin",
      LOADTEST_ADMIN_PASSWORD:process.env.ADMIN_PASSWORD||"",
      LOAD_TEST_CONFIRM:"STAGING_ONLY_I_UNDERSTAND",
      LOADTEST_LEVEL:"L1",
      LOADTEST_STATE_FILE:stateFile,
      COURIERS:"20"
    }
  });
  child.on("exit",c=>resolve(c??1));
});

await sleep(1000);
const last=currentState();
if(code!==0){
  state({...last,active:false,state:"FALHOU",level:"L1",integrity:last.integrity||"FALHOU"});
  console.error("=== L1 FAIL: nenhum nível superior será executado ===");
  process.exit(code);
}

state({...last,active:false,state:"CONCLUÍDO",level:"L1",integrity:"100%"});
console.log("=== L1 PASS: execução encerrada; L2 permanece bloqueado ===");
