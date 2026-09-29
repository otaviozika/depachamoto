import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const checks = [
  ["dispatches bootstrap adds operational_date", /ALTER TABLE dispatches\s+ADD COLUMN IF NOT EXISTS operational_date DATE;/.test(server)],
  ["dispatches bootstrap adds shift_code", /ALTER TABLE dispatches\s+ADD COLUMN IF NOT EXISTS shift_code TEXT[\s\S]{0,180}dispatches_shift_code_check/.test(server)],
  ["dispatches bootstrap restricts shift codes", server.includes("dispatches_shift_code_check") && server.includes("shift_code IN ('LUNCH','DINNER')")],
  ["dispatches bootstrap creates operational shift index", server.includes("CREATE INDEX IF NOT EXISTS dispatches_operational_shift_idx") && server.includes("ON dispatches(operational_date,shift_code,courier_id)")],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failed++;
}

if (failed) {
  console.error(`Fresh database schema self-test failed: ${failed} check(s).`);
  process.exit(1);
}

console.log(`Fresh database schema self-test passed: ${checks.length}/${checks.length}.`);
