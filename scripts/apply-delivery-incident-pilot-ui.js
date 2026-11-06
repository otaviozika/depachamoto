import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const file=path.join(root,"public","index.html");
let html=fs.readFileSync(file,"utf8");
const patched=html.includes('id="incidentPilotAdmin"') && html.includes("function renderIncidentPilotAdmin(st)");
if(patched){
  console.log("Delivery incident pilot UI already applied.");
  process.exit(0);
}
function replaceExactlyOnce(before,after){
  const first=html.indexOf(before);
  if(first<0||html.lastIndexOf(before)!==first)throw new Error("Incident pilot UI anchor not found or ambiguous: "+before.slice(0,75));
  html=html.slice(0,first)+after+html.slice(first+before.length);
}

replaceExactlyOnce(
  '<div id="deliveryIncidentAdmin" class="pd-admin-list" aria-live="polite"></div>',
  '<div id="incidentPilotAdmin" class="pd-admin-list" aria-live="polite"></div>\n          <div id="deliveryIncidentAdmin" class="pd-admin-list" aria-live="polite"></div>'
);
replaceExactlyOnce(
  "let courierPreDeparture={enabled:{pre_departure:false,route_planner:false},pre_departure:null,route:null};",
  "let courierPreDeparture={enabled:{pre_departure:false,route_planner:false},incident_feature:{enabled:false,pilot_only:true},pre_departure:null,route:null};"
);
replaceExactlyOnce(
  " return '<button type=\"button\" class=\"incident-btn\" data-platform=\"'+escapeHtml(stop.platform)+",
  " if(courierPreDeparture?.incident_feature?.enabled!==true)return '';\n return '<button type=\"button\" class=\"incident-btn\" data-platform=\"'+escapeHtml(stop.platform)+"
);

const adminFunctions=[
  "function renderIncidentPilotAdmin(st){",
  " const el=$('incidentPilotAdmin');if(!el)return;",
  " const current=st.incident_pilot||{enabled:false,courier_id:null};",
  " const couriers=(dashboard?.couriers||[]).filter(c=>c.approval_status==='APPROVED'&&c.active);",
  " const options=['<option value=\"\">Selecione um motoboy</option>'].concat(couriers.map(c=>",
  "  '<option value=\"'+Number(c.id)+'\" '+(Number(current.courier_id)===Number(c.id)?'selected':'')+'>'+escapeHtml(c.name)+'</option>'",
  " )).join('');",
  " el.innerHTML='<div class=\"pd-admin-item\" style=\"border:1px solid #b7791f\">'+",
  "  '<b>Ativação independente · Problemas na entrega</b>'+",
  "  '<p class=\"small muted\">Padrão DESLIGADO. Piloto limitado a um motoboy. Ocorrência não confirma nem libera pedido.</p>'+",
  "  '<div style=\"margin:8px 0\"><span class=\"badge '+(current.enabled?'orange':'gray')+'\">'+(current.enabled?'PILOTO LIGADO':'DESLIGADO')+'</span></div>'+",
  "  '<label class=\"small\">Motoboy piloto <select id=\"incidentPilotCourier\" style=\"display:block;max-width:100%;margin:6px 0 10px;padding:9px\">'+options+'</select></label>'+",
  "  '<button type=\"button\" class=\"btn outline\" onclick=\"changeIncidentPilot()\">Ativar ou trocar motoboy piloto</button>'+",
  "  (current.enabled?'<button type=\"button\" class=\"btn danger\" style=\"margin-left:8px\" onclick=\"changeIncidentPilot(false)\">Desligar ocorrências agora</button>':'')+",
  "  '</div>';",
  "}",
  "async function changeIncidentPilot(forceOff){",
  " const selected=Number($('incidentPilotCourier')?.value||0);",
  " const enabled=forceOff!==false;",
  " if(enabled&&!selected)return alert('Escolha um motoboy aprovado antes de ligar o piloto.');",
  " if(enabled&&preDepartureAdminState?.settings?.pre_departure!==true)return alert('Ative a conferência de sacolas antes do piloto.');",
  " if(enabled&&!confirm('Ativar somente para este motoboy? Os demais continuam sem acesso.'))return;",
  " const reason=prompt(enabled?'Motivo da ativação ou troca de piloto:':'Motivo para desligar o piloto:');",
  " if(reason===null)return;",
  " if(reason.trim().length<5||reason.trim().length>250)return alert('Informe motivo de 5 a 250 caracteres.');",
  " try {",
  "  await api('/api/admin/delivery-incidents/pilot',{method:'PUT',body:JSON.stringify({enabled,courier_id:selected||null,reason:reason.trim()})});",
  "  await loadPreDepartureAdmin();",
  " } catch(error){alert(error.message||'Falha ao salvar a configuração.');}",
  "}"
].join("\n");
replaceExactlyOnce("function renderIncidentAdmin(st){",adminFunctions+"\nfunction renderIncidentAdmin(st){");
replaceExactlyOnce(
 "  renderIncidentAdmin(st);\n  const flag=",
 "  renderIncidentPilotAdmin(st);\n  renderIncidentAdmin(st);\n  const flag="
);
fs.writeFileSync(file,html,"utf8");
console.log("Delivery incident pilot UI applied (single courier, fail closed).");
