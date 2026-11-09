import assert from "node:assert/strict";
import fs from "node:fs";
import { validatePilotEvidence } from "./validate-mobile-pilot-evidence.js";

const pathD="docs/mobile-pilot/destinos-30.csv";
const pathS="docs/mobile-pilot/seguranca-14.csv";
const templateD=fs.readFileSync(pathD,"utf8");
const templateS=fs.readFileSync(pathS,"utf8");
function fill(text,type){
  return text.trimEnd().split("\n").map((line,i)=>{
    if(i===0)return line;
    const v=line.split(";");
    if(type==="destinos"){
      assert.equal(v.length,15);
      for(let j=4;j<=9;j++)v[j]="SIM";
      v[10]="900";v[11]="1000";v[12]="OP-QA";
      v[13]="2026-11-07T18:00:00-03:00";v[14]="OK";
    }else{
      assert.equal(v.length,10);
      v[3]="PASS";
      for(let j=4;j<=6;j++)v[j]="SIM";
      v[7]="OP-QA";v[8]="2026-11-07T18:00:00-03:00";v[9]="OK";
    }
    return v.join(";");
  }).join("\n")+"\n";
}
let checks=0;
const expect=(a,b,status)=>{
  const result=validatePilotEvidence(a,b);
  assert.equal(result.decision,status);
  checks++;
  return result;
};
const incomplete=expect(templateD,templateS,"NO_GO_PENDENTE");
assert.equal(incomplete.destinos.PENDENTE,30);
assert.equal(incomplete.seguranca.PENDENTE,14);
const d=fill(templateD,"destinos"),s=fill(templateS,"seguranca");
const pass=expect(d,s,"GO_HOMOLOGACAO_FISICA");
assert.deepEqual({d:pass.destinos.PASS,s:pass.seguranca.PASS},{d:30,s:14});
assert.equal(pass.destinos.waze_abertura_p95_ms,900);
expect(d.replace("D01;IPHONE;ENDERECO_COMPLETO;PUB-01;SIM","D01;IPHONE;ENDERECO_COMPLETO;PUB-01;NAO"),s,"NO_GO_FALHA");
expect(d.replace("D02;IPHONE;ENDERECO_COMPLETO;PUB-02","D02;IPHONE;ENDERECO_COMPLETO;PUB-01"),s,"NO_GO_FALHA");
expect(d.replace("D15;IPHONE","D15;ANDROID"),s,"NO_GO_FALHA");
expect(d.replace("D01;IPHONE;ENDERECO_COMPLETO;PUB-01;SIM","D01;IPHONE;ENDERECO_COMPLETO;PUB-01;"),s,"NO_GO_PENDENTE");
expect(d,s.replace("S03;IPHONE;IFOOD_SEM_CODIGO;PASS","S03;IPHONE;IFOOD_SEM_CODIGO;FALHA"),"NO_GO_FALHA");
expect(d,s.replace("S11;IPHONE;SESSAO_EXPIRADA_ISOLADA;PASS","S11;ANDROID;SESSAO_EXPIRADA_ISOLADA;PASS"),"NO_GO_FALHA");
expect(d.replace("OP-QA","OP @nome real"),s,"NO_GO_FALHA");
assert.throws(()=>validatePilotEvidence("csv errado",s),/CSV vazio|cabeçalho inesperado/);
checks++;
console.log("PASS physical mobile evidence fail-closed gate: "+checks+" simulated validations; template remains NO_GO.");
