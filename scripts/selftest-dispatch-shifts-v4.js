import assert from "node:assert/strict";
import { dispatchShiftAt, operationalShiftAt, resolveDispatchShift } from "../lib/operational-shift.js";
const sp=local=>`${local}-03:00`;
const lunch=resolveDispatchShift({departedAt:sp("2026-09-18T12:35:00")});
assert.equal(lunch.operational_date,"2026-09-18"); assert.equal(lunch.shift_code,"LUNCH");
assert.equal(resolveDispatchShift({departedAt:sp("2026-09-18T19:10:00")}).shift_code,"DINNER");
const inherited=resolveDispatchShift({departedAt:sp("2026-09-18T19:10:00"),existingOperationalDate:"2026-09-18",existingShiftCode:"LUNCH"});
assert.equal(inherited.shift_code,"LUNCH"); assert.equal(inherited.source,"EXISTING_ROUTE");
assert.equal(resolveDispatchShift({departedAt:sp("2026-09-18T12:35:00"),recovery:true}).shift_code,"LUNCH");
assert.throws(()=>resolveDispatchShift({departedAt:sp("2026-09-20T12:00:00")}),e=>e?.code==="OUTSIDE_OPERATIONAL_SHIFT");
assert.throws(()=>resolveDispatchShift({departedAt:sp("2026-09-18T09:00:00")}),e=>e?.code==="OUTSIDE_OPERATIONAL_SHIFT");
assert.throws(()=>resolveDispatchShift({departedAt:sp("2026-09-18T09:00:00"),recovery:true}),e=>e?.code==="RECOVERY_SHIFT_REQUIRED");
const override=resolveDispatchShift({departedAt:sp("2026-09-18T09:00:00"),recovery:true,recoveryShiftCode:"LUNCH"});
assert.equal(override.shift_code,"LUNCH"); assert.equal(override.source,"ADMIN_OVERRIDE");
// Run after npm run prestart, exactly as production is built. Attendance
// retains nominal windows; departure windows extend lunch and dinner.
const cases=[
  ['2026-09-14T11:29:59',null],
  ['2026-09-14T11:30:00','LUNCH'],
  ['2026-09-14T14:31:00','LUNCH'],
  ['2026-09-14T17:59:59','LUNCH'],
  ['2026-09-14T18:00:00','DINNER'],
  ['2026-09-18T10:59:59',null],
  ['2026-09-18T11:00:00','LUNCH'],
  ['2026-09-18T15:01:00','LUNCH'],
  ['2026-09-18T16:00:00','LUNCH'],
  ['2026-09-18T17:59:59','LUNCH'],
  ['2026-09-18T18:00:00','DINNER'],
  ['2026-09-18T23:59:59','DINNER'],
  ['2026-09-19T00:00:00','DINNER','2026-09-18'],
  ['2026-09-19T01:59:59','DINNER','2026-09-18'],
  ['2026-09-19T02:00:00',null],
  ['2026-09-19T10:59:59',null],
  ['2026-09-19T11:00:00','LUNCH'],
  ['2026-09-19T17:59:59','LUNCH'],
  ['2026-09-20T01:59:59','DINNER','2026-09-19'],
  ['2026-09-20T02:00:00',null],
  ['2026-09-20T12:00:00',null],
  ['2026-09-20T17:59:59',null],
  ['2026-09-20T18:00:00','DINNER'],
  ['2026-09-21T01:59:59','DINNER','2026-09-20'],
  ['2026-10-01T00:30:00','DINNER','2026-09-30'],
  ['2027-01-01T00:30:00','DINNER','2026-12-31']
];
for(const [local,code,date=local.slice(0,10)] of cases){
  const actual=dispatchShiftAt(sp(local));
  assert.equal(actual?.shift_code||null,code,local);
  if(code){
    assert.equal(actual.operational_date,date,local);
    assert.equal(actual.time_zone,'America/Sao_Paulo');
    const resolved=resolveDispatchShift({departedAt:sp(local)});
    assert.equal(resolved.shift_code,code);assert.equal(resolved.operational_date,date);
  }else{
    for(const recovery of [false,true])assert.throws(
      ()=>resolveDispatchShift({departedAt:sp(local),recovery}),
      error=>error?.code===(recovery?'RECOVERY_SHIFT_REQUIRED':'OUTSIDE_OPERATIONAL_SHIFT')&&error?.statusCode===409,local
    );
  }
}
assert.equal(operationalShiftAt(sp('2026-09-18T16:00:00')),null,'late lunch does not extend check-in');
assert.equal(operationalShiftAt(sp('2026-09-19T00:30:00')),null,'midnight departure does not extend check-in');
const frozen=resolveDispatchShift({departedAt:sp('2026-09-19T02:10:00'),existingOperationalDate:'2026-09-18',existingShiftCode:'LUNCH'});
assert.equal(frozen.shift_code,'LUNCH');assert.equal(frozen.operational_date,'2026-09-18');assert.equal(frozen.source,'EXISTING_ROUTE');
assert.throws(()=>resolveDispatchShift({departedAt:sp('2026-09-18T09:00:00'),recovery:true,recoveryShiftCode:'UNKNOWN'}),error=>error.code==='RECOVERY_SHIFT_REQUIRED');
assert.throws(()=>dispatchShiftAt('invalid-date'),TypeError);
console.log(JSON.stringify({result:'PASS',feature:'dispatch_shift_freeze',boundary_cases:cases.length}));
