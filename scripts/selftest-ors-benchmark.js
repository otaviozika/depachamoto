// Benchmark historical ORS must be testable with zero secrets, database or external calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const stdout=execFileSync(process.execPath, [new URL("./benchmark-ors-historical.js",import.meta.url).pathname,"--selftest"],{
  encoding:"utf8", timeout:30000,env:{...process.env,DATABASE_URL:"",OPENROUTESERVICE_API_KEY:""}
});
const result=JSON.parse(stdout.trim());
assert.equal(result.result,"PASS");
assert.equal(result.real_external_api_requests,0);
assert.equal(result.tests,16);
console.log("PASS: benchmark historico ORS validado sem rede/segredos/dados pessoais.");
