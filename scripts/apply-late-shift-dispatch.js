import fs from 'node:fs';
const shiftFile=new URL('../lib/operational-shift.js',import.meta.url);
const serverFile=new URL('../server.js',import.meta.url);
let shift=fs.readFileSync(shiftFile,'utf8'),server=fs.readFileSync(serverFile,'utf8');
if(!shift.includes('export function dispatchShiftAt(')){
 const insertion=`
/**
 * Janela de despacho independente do encerramento nominal do turno.
 * Almoço: até 17:59; janta: até 01:59 do dia seguinte.
 * A data operacional da madrugada permanece a do turno de janta anterior.
 */
export function dispatchShiftAt(value=operationalClockNow()){
  const sp=spParts(value);
  const minutes=minutesOfDay(sp.time);
  const todayGroup=ruleGroupForWeekday(sp.weekday);
  if(minutes>=minutesOfDay(todayGroup?.LUNCH?.start||'11:30')&&minutes<18*60&&todayGroup?.LUNCH){
    return {date:sp.date,operational_date:sp.date,shift_code:SHIFT_LUNCH,shift_label:'Almoço',time_zone:SP_TIME_ZONE,source:'LATE_LUNCH'};
  }
  if(minutes>=18*60&&todayGroup?.DINNER){
    return {date:sp.date,operational_date:sp.date,shift_code:SHIFT_DINNER,shift_label:'Janta',time_zone:SP_TIME_ZONE,source:'LATE_DINNER'};
  }
  if(minutes<2*60){
    const previous=new Date(sp.timestamp.getTime()-24*60*60*1000);
    const prev=spParts(previous);
    if(ruleGroupForWeekday(prev.weekday)?.DINNER){
      return {date:prev.date,operational_date:prev.date,shift_code:SHIFT_DINNER,shift_label:'Janta',time_zone:SP_TIME_ZONE,source:'AFTER_MIDNIGHT'};
    }
  }
  return null;
}
`;
 const currentShiftSignatures=[
   'export function getCurrentOperationalShift(now = operationalClockNow()) {',
   'export function getCurrentOperationalShift(now = new Date()) {'
 ];
 const signature=currentShiftSignatures.find(candidate=>shift.includes(candidate));
 if(!signature)throw Error('Current shift signature not found');
 shift=shift.replace(signature,insertion+'\n'+signature);
 shift=shift.replace('const derived = operationalShiftAt(departedAt);','const derived = dispatchShiftAt(departedAt);');
 if(!shift.includes('export function dispatchShiftAt('))throw Error('Shift insertion failed');
 fs.writeFileSync(shiftFile,shift);
}
if(!server.includes('dispatchShiftAt, resolveDispatchShift')){
 server=server.replace('operationalShiftAt, resolveDispatchShift,','operationalShiftAt, dispatchShiftAt, resolveDispatchShift,');
}
const original='const routeShift = getCurrentOperationalShift();';
if(server.includes(original))server=server.replace(original,'const routeShift = dispatchShiftAt();');
const departure='const departureShift = getCurrentOperationalShift();';
let count=server.split(departure).length-1;
if(count>0)server=server.split(departure).join('const departureShift = dispatchShiftAt();');
if(!server.includes('const routeShift = dispatchShiftAt();')||server.split('const departureShift = dispatchShiftAt();').length!==3)throw Error('Departure replacements not verified');
fs.writeFileSync(serverFile,server);
console.log('Late dispatch windows installed; lunch until 17:59, dinner until 01:59.');
