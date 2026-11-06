// Regressao: liberacao administrativa nao pode manter uma conexao do pool
// enquanto a auditoria pede outra. Uma conexao no pool reproduz o deadlock.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const begin = source.indexOf("async function completeDispatchReturn(");
const end = source.indexOf("\nasync function getSPDate()",begin);
assert.ok(begin>=0&&end>begin,"completeDispatchReturn nao encontrada");

let count=0;
async function scenario(name,{active=true,resolved=true,administrative=false,failUpdate=false,failAudit=false}={}) {
  let inUse=false,releases=0,rollbacks=0,commits=0,committed=false,audited=0;
  const events=[];
  const client = {
    async query(sql){
      if (/^BEGIN$/.test(sql)){assert.equal(inUse,true);return {rowCount:0,rows:[]};}
      if (/^COMMIT$/.test(sql)){committed=true;commits++;return {rowCount:0,rows:[]};}
      if (/^ROLLBACK$/.test(sql)){rollbacks++;return {rowCount:0,rows:[]};}
      if (/SELECT \* FROM dispatches/.test(sql)) return active?{rowCount:1,rows:[{id:19,courier_id:42,status:"ON_ROAD"}]}:{rowCount:0,rows:[]};
      if (/UPDATE dispatches/.test(sql)){
        if(failUpdate)throw Error("simulated update error");
        return {rowCount:1,rows:[{id:19,courier_id:42,status:"RELEASED"}]};
      }
      if (/DELETE FROM active_order_locks/.test(sql))return {rowCount:1,rows:[]};
      throw Error("unexpected query "+sql.slice(0,80));
    },
    release(){assert.equal(inUse,true,"release duplicated");inUse=false;releases++;}
  };
  const context=vm.createContext({
    pool:{
      async connect(){assert.equal(inUse,false,"connection already acquired");inUse=true;return client;}
    },
    getDispatchProgressMap:async() => new Map([[19,{all_orders_resolved:resolved}]]),
    auditBestEffort:async()=>{assert.equal(committed,true);assert.equal(inUse,false,"auditoria nao pode compartilhar o mesmo client");audited++;if(failAudit)throw Error("simulated audit failure");},
    emitRealtime:(event,payload)=>events.push({event,payload}),
    console
  });
  vm.runInContext(source.slice(begin,end),context);
  const args={dispatchId:19,actorUserId:1,...(administrative?{source:"ADMIN_PENDING_DELIVERIES_OVERRIDE"}:{})};
  let exception=null,result;
  try{result=await context.completeDispatchReturn(args);}catch(e){exception=e;}
  if(failUpdate||failAudit)assert.ok(exception,"expected simulated exception");
  else assert.equal(exception,null,String(exception));
  assert.equal(releases,1,"connection must be released once");
  assert.equal(inUse,false,"connection leaked");
  if(failUpdate){assert.equal(commits,0);assert.equal(rollbacks,1);assert.equal(audited,0);}
  else if(!active||(!resolved&&!administrative)){assert.equal(result,null);assert.equal(commits,0);assert.equal(rollbacks,1);assert.equal(audited,0);}
  else{assert.equal(commits,1);assert.equal(rollbacks,0);assert.equal(audited,1);if(!failAudit)assert.equal(result.status,"RELEASED");}
  count++;console.log("PASS",name);
}
await scenario("retorno normal libera conexao ANTES de auditBestEffort");
await scenario("excecao administrativa com pedidos pendentes libera antes da auditoria",{resolved:false,administrative:true});
await scenario("sem saida ativa faz ROLLBACK e libera",{active:false});
await scenario("entrega pendente sem autorizacao nao libera o pedido",{resolved:false});
await scenario("erro de escrita desfaz transacao e libera",{failUpdate:true});
await scenario("erro de auditoria apos COMMIT nao desfaz transacao nem prende conexao",{failAudit:true});
console.log(JSON.stringify({result:"PASS",checks:count}));
