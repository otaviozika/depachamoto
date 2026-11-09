import assert from "node:assert/strict";
import {getCurrentOperationalShift,operationalShiftAt} from "../lib/operational-shift.js";
const keys=["APP_ENV","NODE_ENV","STAGING_SAFE_MODE","OPERATIONAL_NOW_OVERRIDE","STAGING_SHIFT_OVERRIDE_UNTIL"];
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const simulate="2026-11-08T20:00:00-03:00";
function use(values){for(const [k,v] of Object.entries(values)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
try {
  use({APP_ENV:"staging",NODE_ENV:"production",STAGING_SAFE_MODE:"true",OPERATIONAL_NOW_OVERRIDE:simulate,STAGING_SHIFT_OVERRIDE_UNTIL:new Date(Date.now()+900_000).toISOString()});
  const open=getCurrentOperationalShift();
  assert.equal(open?.shift_code,"DINNER");
  assert.equal(open?.operational_date,"2026-11-08");
  // Past expiry, even with configured fake time, uses live wall clock.
  process.env.STAGING_SHIFT_OVERRIDE_UNTIL=new Date(Date.now()-900_000).toISOString();
  assert.deepEqual(getCurrentOperationalShift(),operationalShiftAt(new Date()));
  process.env.STAGING_SHIFT_OVERRIDE_UNTIL="not-a-date";
  assert.deepEqual(getCurrentOperationalShift(),operationalShiftAt(new Date()));
  // Even with a future expiry and a dangerous flag, production never accepts override.
  use({APP_ENV:"production",NODE_ENV:"production",STAGING_SAFE_MODE:"true",STAGING_SHIFT_OVERRIDE_UNTIL:new Date(Date.now()+900_000).toISOString()});
  assert.deepEqual(getCurrentOperationalShift(),operationalShiftAt(new Date()));
  use({APP_ENV:"staging",NODE_ENV:"production",STAGING_SAFE_MODE:"false"});
  assert.deepEqual(getCurrentOperationalShift(),operationalShiftAt(new Date()));
  // Keep the CI behavior for an isolated test runner.
  use({APP_ENV:"staging",NODE_ENV:"test",STAGING_SAFE_MODE:"true",STAGING_SHIFT_OVERRIDE_UNTIL:undefined});
  assert.equal(getCurrentOperationalShift()?.shift_code,"DINNER");
  console.log("PASS staging temporary operational shift: 6 isolation/expiry assertions");
} finally {
  for(const k of keys){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k]}
}
