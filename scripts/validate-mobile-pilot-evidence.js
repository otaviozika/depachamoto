/**
 * Gate de evidências físicas (iPhone/Android) — ZERO coleta de PII.
 *
 * Uso:
 *   node scripts/validate-mobile-pilot-evidence.js \
 *     docs/mobile-pilot/destinos-30.csv docs/mobile-pilot/seguranca-14.csv
 *
 * Template em branco => NO_GO_PENDENTE (exit 2).
 * Evidência preenchida com falha => NO_GO_FALHA (exit 1).
 * Todos os 30 destinos e 14 cenários físicos aprovados => GO_HOMOLOGACAO_FISICA (exit 0).
 *
 * GO aqui significa SOMENTE evidência física; não autoriza merge/deploy na produção.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEST_FIELDS=[
  "id","aparelho","categoria","local_publico_codigo","waze_pino","maps_pino",
  "retorno_waze","retorno_maps","estado_preservado","sem_overflow",
  "abertura_waze_ms","abertura_maps_ms","responsavel_codigo","data_iso","erro_codigo"
];
const SAFETY_FIELDS=[
  "id","aparelho","cenario","resultado","sem_confirmacao_falsa",
  "sem_duplicidade","permissao_correta","responsavel_codigo","data_iso","erro_codigo"
];
const REQUIRED_CATEGORIES={
  ENDERECO_COMPLETO:10,ENDERECO_CORRIGIDO:5,MAO_UNICA_RETORNO:5,
  COMPLEMENTO_PORTARIA:5,DESTINO_DISTANTE:5
};
const CRITICAL_SCENARIOS=[
  ["IPHONE","CLIENTE_NAO_LOCALIZADO"],["ANDROID","CLIENTE_NAO_LOCALIZADO"],
  ["IPHONE","IFOOD_SEM_CODIGO"],["ANDROID","IFOOD_SEM_CODIGO"],
  ["IPHONE","ANOTAAI_SEM_CODIGO_OCULTO"],
  ["ANDROID","ALTERACAO_ROTA_ADMIN_CIENTE"],
  ["IPHONE","OFFLINE_RELATO_OCORRENCIA"],
  ["ANDROID","OFFLINE_AUTORIZACAO_ADMIN"],
  ["IPHONE","OFFLINE_CONFIRMAR_ENTREGA"],
  ["ANDROID","RECONEXAO_SEM_DUPLICAR"],
  ["IPHONE","SESSAO_EXPIRADA_ISOLADA"],
  ["ANDROID","ROLLBACK_FLUXO_LEGADO"],
  ["ANDROID","BLOQUEIO_NOVA_SAIDA_PENDENTE"],
  ["IPHONE","PILOTO_RESTRITO_OUTRO_MOTOBOY"]
];
function parseLine(line){
  const fields=[];let current="",quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"' && quoted && line[i+1]==='"'){current+='"';i++;continue;}
    if(c==='"'){quoted=!quoted;continue;}
    if(c===';'&&!quoted){fields.push(current.trim());current="";continue;}
    current+=c;
  }
  if(quoted)throw new Error("CSV_UNTERMINATED_QUOTE");
  fields.push(current.trim());
  return fields;
}
function parseCsv(csv,fields,type){
  const lines=String(csv).replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").trimEnd().split("\n");
  if(lines.length<2)throw new Error(type+": CSV vazio");
  const header=parseLine(lines[0]);
  if(header.join(";")!==fields.join(";"))throw new Error(type+": cabeçalho inesperado");
  return lines.slice(1).map((line,i)=>{
    const cells=parseLine(line);
    if(cells.length!==fields.length)throw new Error(type+": linha "+(i+2)+" tem "+cells.length+" campos");
    return Object.fromEntries(fields.map((f,j)=>[f,cells[j]]));
  });
}
const dateOk=s=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s));
const operatorOk=s=>/^OP-[A-Z0-9]{2,8}$/.test(s);
const numericOk=s=>/^[0-9]+$/.test(s)&&Number(s)>=1&&Number(s)<=120000;
const p95=a=>{
  if(!a.length)return null;
  const sorted=a.slice().sort((x,y)=>x-y);
  return sorted[Math.ceil(sorted.length*.95)-1];
};
function statusRow(row,booleanFields,fields){
  // An incomplete row is not an error; it is an explicit NO-GO.
  const missing=fields.filter(f=>!row[f]);
  if(missing.length)return {status:"PENDENTE",reason:"campos não preenchidos"};
  if(!booleanFields.every(f=>row[f]==="SIM"))return {status:"FALHA",reason:"critério obrigatório não satisfeito"};
  if(!operatorOk(row.responsavel_codigo)||!dateOk(row.data_iso)){
    return {status:"FALHA",reason:"evidência sem operador codificado ou data ISO válida"};
  }
  if(row.erro_codigo!=="OK")return {status:"FALHA",reason:"ocorrência técnica registrada"};
  return {status:"PASS"};
}
export function validatePilotEvidence(destinationsCsv,safetyCsv){
  const d=parseCsv(destinationsCsv,DEST_FIELDS,"destinos");
  const s=parseCsv(safetyCsv,SAFETY_FIELDS,"seguranca");
  const problems=[],counts={destinos:{PASS:0,PENDENTE:0,FALHA:0},seguranca:{PASS:0,PENDENTE:0,FALHA:0}};
  const durationW=[],durationM=[];
  if(d.length!==30)problems.push({id:"DESTINOS",reason:"esperados 30 registros"});
  if(s.length!==14)problems.push({id:"SEGURANCA",reason:"esperados 14 registros"});
  const locations=new Set(),categories={};
  d.forEach((r,i)=>{
    const expectedId="D"+String(i+1).padStart(2,"0");
    if(r.id!==expectedId)problems.push({id:expectedId,reason:"ID ou ordem alterado"});
    if(r.aparelho!==(i<15?"IPHONE":"ANDROID"))problems.push({id:expectedId,reason:"aparelho incorreto"});
    if(r.local_publico_codigo!=="PUB-"+String(i+1).padStart(2,"0")||locations.has(r.local_publico_codigo)){
      problems.push({id:expectedId,reason:"referência pública duplicada ou inválida"});
    }
    locations.add(r.local_publico_codigo);
    categories[r.categoria]=(categories[r.categoria]||0)+1;
    const x=statusRow(r,["waze_pino","maps_pino","retorno_waze","retorno_maps","estado_preservado","sem_overflow"],DEST_FIELDS);
    if(x.status==="PASS"&&(!numericOk(r.abertura_waze_ms)||!numericOk(r.abertura_maps_ms))){
      x.status="FALHA";x.reason="tempo de abertura inválido";
    }
    if(x.status==="PASS"){durationW.push(Number(r.abertura_waze_ms));durationM.push(Number(r.abertura_maps_ms));}
    counts.destinos[x.status]++;
    if(x.status==="FALHA")problems.push({id:expectedId,reason:x.reason});
  });
  for(const [category,n] of Object.entries(REQUIRED_CATEGORIES)){
    if(categories[category]!==n)problems.push({id:"CATEGORIAS",reason:category+" esperado "+n});
  }
  for(const category of Object.keys(categories)){
    if(!(category in REQUIRED_CATEGORIES))problems.push({id:"CATEGORIAS",reason:"categoria desconhecida"});
  }
  s.forEach((r,i)=>{
    const expectedId="S"+String(i+1).padStart(2,"0");
    const [device,scenario]=CRITICAL_SCENARIOS[i]||["",""];
    if(r.id!==expectedId||r.aparelho!==device||r.cenario!==scenario){
      problems.push({id:expectedId,reason:"cenário crítico alterado"});
    }
    const x=statusRow(r,["sem_confirmacao_falsa","sem_duplicidade","permissao_correta"],SAFETY_FIELDS);
    if(x.status==="PASS"&&r.resultado!=="PASS"){x.status="FALHA";x.reason="resultado crítico reprovado";}
    else if(x.status==="PENDENTE"&&r.resultado==="FALHA"){x.status="FALHA";x.reason="cenário crítico falhou";}
    counts.seguranca[x.status]++;
    if(x.status==="FALHA")problems.push({id:expectedId,reason:x.reason});
  });
  const failures=counts.destinos.FALHA+counts.seguranca.FALHA+problems.length;
  const pending=counts.destinos.PENDENTE+counts.seguranca.PENDENTE;
  const decision=failures?"NO_GO_FALHA":pending?"NO_GO_PENDENTE":"GO_HOMOLOGACAO_FISICA";
  return {
    decision,
    destinos:{...counts.destinos,exigidos:30,iphone:15,android:15,
      waze_abertura_p95_ms:p95(durationW),maps_abertura_p95_ms:p95(durationM)},
    seguranca:{...counts.seguranca,exigidos:14},
    problemas:problems.slice(0,30),
    observacao:"Este gate apenas valida evidências físicas; publicação em produção exige autorização separada."
  };
}
const isMain=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(isMain){
  try{
    const a=process.argv[2]||"docs/mobile-pilot/destinos-30.csv";
    const b=process.argv[3]||"docs/mobile-pilot/seguranca-14.csv";
    const result=validatePilotEvidence(fs.readFileSync(a,"utf8"),fs.readFileSync(b,"utf8"));
    console.log("MOBILE_PILOT_EVIDENCE_REPORT "+JSON.stringify(result));
    if(result.decision!=="GO_HOMOLOGACAO_FISICA")process.exitCode=result.decision==="NO_GO_PENDENTE"?2:1;
  }catch(e){
    console.error("MOBILE_PILOT_EVIDENCE_ERROR "+String(e?.message||"input inválido").slice(0,150));
    process.exitCode=1;
  }
}
