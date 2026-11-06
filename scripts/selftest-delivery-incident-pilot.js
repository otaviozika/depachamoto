import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  INCIDENT_PILOT_KEYS,
  validCourierId, incidentEnabledForCourier,
  readIncidentPilotSettings, saveIncidentPilotSettings
} from "../lib/delivery-incident-pilot.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let checks=0;
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++};
const yes=(value,label)=>{assert.ok(value,label);checks++};
async function reject(fn,code){
  await assert.rejects(fn,err=>err?.code===code,"Expected "+code);checks++;
}
function db({preDeparture=false,enabled=false,courier=null,approved=[11]}={}){
  const map=new Map([
    [INCIDENT_PILOT_KEYS.preDeparture,preDeparture?"true":"false"],
    [INCIDENT_PILOT_KEYS.enabled,enabled?"true":"false"],
    [INCIDENT_PILOT_KEYS.courierId,courier?String(courier):""]
  ]);
  const calls=[];
  const query=async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes("SELECT setting_key,setting_value FROM app_settings")){
      return {rows:[...map].map(([setting_key,setting_value])=>({setting_key,setting_value})),rowCount:map.size};
    }
    if(sql.includes("SELECT id FROM users WHERE")){
      const ok=approved.includes(Number(args[0]));
      return {rows:ok?[{id:Number(args[0])}]:[],rowCount:ok?1:0};
    }
    if(sql.includes("INSERT INTO app_settings(")){
      map.set(args[0],args[1]);return {rows:[],rowCount:1};
    }
    return {rows:[],rowCount:0};
  };
  return {
    map,calls,query,
    async connect(){return {query,release(){calls.push({sql:"RELEASE"})}};}
  };
}
const audit=[];
const events=[];
const services=(pool,{enabled,courierId=11,reason="Piloto restrito para validação"}={})=>({
  pool,adminId:99,enabled,courierId,reason,
  audit:async(...args)=>audit.push(args),
  emitRealtime:(...args)=>events.push(args)
});

equal(validCourierId("11"),11,"string integer");
equal(validCourierId(11),11,"numeric id");
equal(validCourierId("0"),null,"zero invalid");
equal(validCourierId("-1"),null,"negative invalid");
equal(validCourierId("1.1"),null,"fraction invalid");
equal(validCourierId(""),null,"empty invalid");
equal(validCourierId(null),null,"null invalid");
equal(validCourierId("1e100"),null,"huge invalid");
equal(validCourierId({id:11}),null,"objects forbidden");

const settings={enabled:true,pre_departure_enabled:true,courier_id:11};
equal(incidentEnabledForCourier(settings,11),true,"selected courier");
equal(incidentEnabledForCourier(settings,12),false,"different courier");
equal(incidentEnabledForCourier({...settings,enabled:false},11),false,"off");
equal(incidentEnabledForCourier({...settings,pre_departure_enabled:false},11),false,"no predeparture");
equal(incidentEnabledForCourier({...settings,courier_id:null},11),false,"missing pilot");
equal(incidentEnabledForCourier(null,11),false,"absent settings");
equal(incidentEnabledForCourier(settings,null),false,"anonymous");

const missing=db();
equal(await readIncidentPilotSettings(missing),{enabled:false,pre_departure_enabled:false,courier_id:null},"fail closed default");
const active=db({preDeparture:true,enabled:true,courier:11});
equal(await readIncidentPilotSettings(active),settings,"read selected pilot");
const off=db({preDeparture:false});
await reject(()=>saveIncidentPilotSettings(services(off,{enabled:true,courierId:null})),"INCIDENT_PILOT_REQUIRED");
await reject(()=>saveIncidentPilotSettings(services(off,{enabled:"true"})),"INCIDENT_FLAG_INVALID");
await reject(()=>saveIncidentPilotSettings(services(off,{enabled:true,reason:"x"})),"INCIDENT_SETTINGS_REASON_REQUIRED");
await reject(()=>saveIncidentPilotSettings(services(off,{enabled:true,courierId:11})),"INCIDENT_PRE_DEPARTURE_REQUIRED");
equal(off.map.get(INCIDENT_PILOT_KEYS.enabled),"false","predeparture denial unchanged");
yes(off.calls.some(x=>x.sql==="ROLLBACK"),"predeparture deny rolls back");
const unapproved=db({preDeparture:true,approved:[]});
await reject(()=>saveIncidentPilotSettings(services(unapproved,{enabled:true,courierId:14})),"INCIDENT_PILOT_NOT_ELIGIBLE");
equal(unapproved.map.get(INCIDENT_PILOT_KEYS.enabled),"false","unapproved denial unchanged");

const ready=db({preDeparture:true,approved:[11,12]});
const first=await saveIncidentPilotSettings(services(ready,{enabled:true,courierId:11}));
equal(first,{enabled:true,pre_departure_enabled:true,courier_id:11},"enable pilot");
equal(incidentEnabledForCourier(await readIncidentPilotSettings(ready),12),false,"pilot isolation");
equal(ready.map.get(INCIDENT_PILOT_KEYS.enabled),"true","setting stored");
yes(ready.calls.some(x=>x.sql.includes("pg_advisory_xact_lock")),"transaction lock");
yes(ready.calls.some(x=>x.sql==="COMMIT"),"transaction commit");
const moved=await saveIncidentPilotSettings(services(ready,{enabled:true,courierId:12,reason:"Trocar para piloto numero dois"}));
equal(moved.courier_id,12,"switch pilot");
equal(incidentEnabledForCourier(await readIncidentPilotSettings(ready),11),false,"old pilot revoked");
equal(incidentEnabledForCourier(await readIncidentPilotSettings(ready),12),true,"new pilot active");
const disabled=await saveIncidentPilotSettings(services(ready,{enabled:false,courierId:12,reason:"Encerrar piloto por seguranca"}));
equal(disabled.enabled,false,"disable");
equal(incidentEnabledForCourier(await readIncidentPilotSettings(ready),12),false,"disable immediate");
equal(ready.map.get(INCIDENT_PILOT_KEYS.enabled),"false","off persisted");
equal(audit.length,3,"audit three changes");
equal(events.filter(e=>e[0]==="settings:changed").length,3,"notify changes");

const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
yes(server.includes('incidentEnabledForCourier(pilot,req.session.user.id)'),"server gates incident report");
yes(server.includes('code:"INCIDENT_FEATURE_DISABLED"'),"fail closed http error");
yes(server.includes('app.put("/api/admin/delivery-incidents/pilot",auth,adminOnly'),"admin-only pilot endpoint");
yes(server.includes("ALTER TABLE dispatch_delivery_incidents ENABLE ROW LEVEL SECURITY"),"incident RLS");
yes(server.includes("REVOKE ALL ON TABLE dispatch_delivery_incidents FROM PUBLIC"),"public grants revoked");
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
yes(pkg.scripts.prestart.includes("apply-delivery-incident-pilot-ui.js"),"UI prestart enabled");
const script=fs.readFileSync(path.join(root,"scripts","apply-delivery-incident-pilot-ui.js"),"utf8");
yes(script.includes("adminSetIncidentPilot"),"admin UI contract validation");
yes(script.includes("incident_feature?.enabled!==true"),"courier UI contract validation");
const html=fs.readFileSync(path.join(root,"public","index.html"),"utf8");
yes(html.includes("function adminSetIncidentPilot(enabled)"),"admin UI wired");
yes(html.includes("if(courierPreDeparture?.incident_feature?.enabled!==true)return ''"),"courier action gated");
yes(html.includes("id=\\\"incidentPilotCourier\\\"".replaceAll("\\","")),"pilot dropdown present");
console.log("PASS delivery incident pilot gate: "+checks+" checks");
