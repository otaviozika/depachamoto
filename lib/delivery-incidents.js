// Ocorrencia em entrega nao confirma pedido, nao cancela e nao libera nova saida.
// Somente admin pode autorizar o motoboy a seguir para outra parada.
export const INCIDENT_REASONS=Object.freeze({CLIENT_NOT_FOUND:"Cliente não localizado",CODE_UNAVAILABLE:"Sem código"});
const ACTIVE=["OPEN","CONTINUE_APPROVED"];
const error=(status,code,message)=>Object.assign(new Error(message),{status,code});
const goodId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
const note=v=>typeof v==="string"?v.trim().slice(0,200):"";
export function validateIncident({dispatchId,platform,orderId,reason}){
  if(!goodId(dispatchId))throw error(400,"INCIDENT_DISPATCH_INVALID","Saída inválida.");
  if(!["ifood","anotaai"].includes(platform))throw error(400,"INCIDENT_PLATFORM_INVALID","Plataforma inválida.");
  if(typeof orderId!=="string"||!orderId.trim()||orderId.length>160)throw error(400,"INCIDENT_ORDER_INVALID","Pedido inválido.");
  if(!Object.hasOwn(INCIDENT_REASONS,reason))throw error(400,"INCIDENT_REASON_INVALID","Selecione um motivo válido.");
  if(reason==="CODE_UNAVAILABLE"&&platform!=="ifood")throw error(400,"INCIDENT_CODE_ONLY_IFOOD","Anota AI não utiliza código.");
  return {dispatchId:Number(dispatchId),platform,orderId:orderId.trim(),reason};
}
export function createDeliveryIncidentService({pool,audit=async()=>{},notify=async()=>{},emitRealtime=()=>{}}){
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const value=await fn(c);await c.query("COMMIT");return value}
    catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}
    finally{c.release()}
  }
  async function announce(type,row,actor){
    emitRealtime("dispatch:changed",{courier_id:Number(row.courier_id),dispatch_id:Number(row.dispatch_id),change:type});
    try{await audit(actor,type,"dispatch",row.dispatch_id,{incident_id:Number(row.id),order_number:row.order_number,platform:row.platform,reason:row.reason,status:row.status})}catch(_){}
    if(type==="DELIVERY_INCIDENT_OPENED"){
      try{await notify({type:"DELIVERY_INCIDENT",severity:"warning",title:"Problema na entrega",
        message:"Pedido "+row.order_number+" ("+row.platform+") · "+INCIDENT_REASONS[row.reason]+". Motoboy #"+row.courier_id,
        courierId:Number(row.courier_id),dispatchId:Number(row.dispatch_id),uniqueKey:"delivery_incident:"+row.id})}catch(_){}
    }
  }
  async function report({courierId,dispatchId,platform,orderId,reason}){
    const p=validateIncident({dispatchId,platform,orderId,reason});
    if(!goodId(courierId))throw error(401,"INCIDENT_UNAUTHORIZED","Motoboy inválido.");
    const value=await tx(async c=>{
      const d=(await c.query("SELECT id,courier_id,status FROM dispatches WHERE id=$1 FOR UPDATE",[p.dispatchId])).rows[0];
      if(!d||Number(d.courier_id)!==Number(courierId))throw error(404,"INCIDENT_DISPATCH_NOT_FOUND","Saída não pertence a este motoboy.");
      if(d.status!=="ON_ROAD")throw error(409,"INCIDENT_DISPATCH_CLOSED","A saída já foi encerrada.");
      const sql=[
        "SELECT s.order_number,",
        "CASE WHEN s.platform='ifood' THEN (UPPER(COALESCE(io.status,'')) IN ('CONCLUDED','DELIVERED')",
        "OR UPPER(COALESCE(ic.status,'')) IN ('VERIFIED','CONCLUDED'))",
        "ELSE (ac.confirmed_at IS NOT NULL OR UPPER(COALESCE(ao.status,''))='FINISHED') END AS delivered,",
        "CASE WHEN s.platform='ifood' THEN UPPER(COALESCE(io.status,''))='CANCELLED'",
        "ELSE UPPER(COALESCE(ao.status,'')) IN ('CANCELLED','DENIED','CANCELLATION_REQUESTED') END AS cancelled",
        "FROM dispatch_route_stops s",
        "LEFT JOIN ifood_orders io ON s.platform='ifood' AND io.order_id=s.external_order_id",
        "LEFT JOIN ifood_delivery_confirmations ic ON s.platform='ifood' AND ic.ifood_order_id=s.external_order_id",
        "LEFT JOIN anotaai_orders ao ON s.platform='anotaai' AND ao.order_id=s.external_order_id",
        "LEFT JOIN anotaai_delivery_confirmations ac ON s.platform='anotaai' AND ac.anotaai_order_id=s.external_order_id AND ac.dispatch_id=s.dispatch_id",
        "WHERE s.dispatch_id=$1 AND s.platform=$2 AND s.external_order_id=$3",
        "AND EXISTS (SELECT 1 FROM dispatch_orders o WHERE o.dispatch_id=s.dispatch_id",
        "AND o.platform=s.platform AND LOWER(o.order_number)=LOWER(s.order_number)) LIMIT 1"
      ].join(" ");
      const stop=(await c.query(sql,[p.dispatchId,p.platform,p.orderId])).rows[0];
      if(!stop)throw error(404,"INCIDENT_ORDER_NOT_ASSIGNED","Pedido não está nesta rota.");
      if(stop.delivered||stop.cancelled)throw error(409,"INCIDENT_ORDER_FINISHED","Este pedido já foi concluído ou cancelado.");
      const added=await c.query(
        "INSERT INTO dispatch_delivery_incidents(dispatch_id,courier_id,platform,external_order_id,order_number,reason,status) VALUES($1,$2,$3,$4,$5,$6,'OPEN') ON CONFLICT DO NOTHING RETURNING *",
        [p.dispatchId,courierId,p.platform,p.orderId,stop.order_number,p.reason]);
      const incident=added.rows[0]||(await c.query(
        "SELECT * FROM dispatch_delivery_incidents WHERE dispatch_id=$1 AND platform=$2 AND external_order_id=$3 AND status = ANY($4::text[]) ORDER BY id DESC LIMIT 1",
        [p.dispatchId,p.platform,p.orderId,ACTIVE])).rows[0];
      if(!incident)throw error(409,"INCIDENT_CHANGED","A ocorrência mudou. Atualize a tela.");
      if(added.rowCount)await c.query(
        "INSERT INTO pre_departure_events(dispatch_id,event,actor_user_id,details) VALUES($1,'DELIVERY_INCIDENT_OPENED',$2,$3::jsonb)",
        [p.dispatchId,courierId,JSON.stringify({incident_id:incident.id,order_number:stop.order_number,reason:p.reason})]);
      return {incident,created:added.rowCount===1};
    });
    if(value.created)await announce("DELIVERY_INCIDENT_OPENED",value.incident,courierId);
    return value;
  }
  async function decide({adminId,incidentId,action,reason}){
    if(!goodId(adminId)||!goodId(incidentId))throw error(400,"INCIDENT_INVALID_ID","Identificação inválida.");
    if(!["APPROVE_CONTINUE","REQUIRE_RETRY"].includes(action))throw error(400,"INCIDENT_DECISION_INVALID","Decisão inválida.");
    const why=note(reason);
    if(why.length<5)throw error(400,"INCIDENT_DECISION_REASON_REQUIRED","Informe o motivo (mínimo de 5 caracteres).");
    const value=await tx(async c=>{
      // Consistent lock ordering: dispatch before incident.
      const ref=(await c.query("SELECT dispatch_id FROM dispatch_delivery_incidents WHERE id=$1",[incidentId])).rows[0];
      if(!ref)throw error(404,"INCIDENT_NOT_FOUND","Ocorrência não encontrada.");
      const d=(await c.query("SELECT id,status FROM dispatches WHERE id=$1 FOR UPDATE",[ref.dispatch_id])).rows[0];
      if(!d||d.status!=="ON_ROAD")throw error(409,"INCIDENT_DISPATCH_CLOSED","A saída já foi encerrada.");
      const row=(await c.query("SELECT * FROM dispatch_delivery_incidents WHERE id=$1 FOR UPDATE",[incidentId])).rows[0];
      if(!row||!ACTIVE.includes(row.status))throw error(409,"INCIDENT_NOT_ACTIVE","Ocorrência já resolvida.");
      const status=action==="APPROVE_CONTINUE"?"CONTINUE_APPROVED":"OPEN";
      if(row.status===status)return {incident:row,changed:false};
      const updated=(await c.query(
        "UPDATE dispatch_delivery_incidents SET status=$2,approved_at=CASE WHEN $2='CONTINUE_APPROVED' THEN NOW() ELSE NULL END, approved_by=CASE WHEN $2='CONTINUE_APPROVED' THEN $3::int ELSE NULL END, approval_reason=$4,updated_at=NOW() WHERE id=$1 RETURNING *",
        [incidentId,status,adminId,why])).rows[0];
      // Only the displayed route version changes. No delivery or courier release.
      await c.query("UPDATE dispatch_routes SET route_version=route_version+1,ack_required=TRUE,updated_at=NOW() WHERE dispatch_id=$1",[ref.dispatch_id]);
      await c.query("INSERT INTO pre_departure_events(dispatch_id,event,actor_user_id,details) VALUES($1,$2,$3,$4::jsonb)",
        [ref.dispatch_id,action==="APPROVE_CONTINUE"?"DELIVERY_INCIDENT_CONTINUE_APPROVED":"DELIVERY_INCIDENT_RETRY_REQUIRED",
          adminId,JSON.stringify({incident_id:incidentId,order_number:row.order_number,reason:why})]);
      return {incident:updated,changed:true};
    });
    if(value.changed)await announce(action==="APPROVE_CONTINUE"?"DELIVERY_INCIDENT_CONTINUE_APPROVED":"DELIVERY_INCIDENT_RETRY_REQUIRED",value.incident,adminId);
    return value;
  }
  async function resolveConfirmed({dispatchId,platform,orderId}){
    if(!goodId(dispatchId)||!["ifood","anotaai"].includes(platform)||typeof orderId!=="string"||!orderId)return 0;
    const result=await pool.query(
      "UPDATE dispatch_delivery_incidents SET status='RESOLVED',resolution_reason='CONFIRMED_BY_PLATFORM',resolved_at=NOW(),updated_at=NOW() WHERE dispatch_id=$1 AND platform=$2 AND external_order_id=$3 AND status = ANY($4::text[]) RETURNING id,courier_id",
      [dispatchId,platform,orderId,ACTIVE]);
    if(result.rowCount)emitRealtime("dispatch:changed",{courier_id:Number(result.rows[0].courier_id),dispatch_id:Number(dispatchId),change:"DELIVERY_INCIDENT_RESOLVED"});
    return result.rowCount;
  }
  async function list({includeResolved=false,limit=100}={}){
    const max=Math.max(1,Math.min(100,Number(limit)||100));
    const sql=[
      "SELECT i.id,i.dispatch_id,i.courier_id,i.platform,i.order_number,i.reason,i.status,",
      "i.reported_at,i.updated_at,i.approved_at,i.approved_by,i.approval_reason,i.resolved_at,i.resolution_reason,",
      "d.status AS dispatch_status,u.name AS courier_name FROM dispatch_delivery_incidents i",
      "JOIN dispatches d ON d.id=i.dispatch_id JOIN users u ON u.id=i.courier_id",
      "WHERE ($1::boolean OR i.status = ANY($2::text[]))",
      "ORDER BY CASE WHEN i.status='OPEN' THEN 0 WHEN i.status='CONTINUE_APPROVED' THEN 1 ELSE 2 END,",
      "i.reported_at DESC LIMIT $3"
    ].join(" ");
    return (await pool.query(sql,[includeResolved,ACTIVE,max])).rows;
  }
  return {report,decide,resolveConfirmed,list};
}
