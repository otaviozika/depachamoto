import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const adminRouteStart = server.indexOf('app.post("/api/admin/dispatches/manual"');
const adminRouteEnd = server.indexOf('app.get("/api/admin/notifications"', adminRouteStart);
const route = adminRouteStart >= 0 && adminRouteEnd > adminRouteStart
  ? server.slice(adminRouteStart, adminRouteEnd)
  : "";

const checks = [
  ["Admin manual route exists", Boolean(route)],
  ["Admin manual catches PostgreSQL unique races", route.includes('e.code === "23505"')],
  ["Admin manual limits race mapping to active_order_locks", route.includes('String(e.constraint || "").includes("active_order_locks")')],
  ["Admin race is returned as HTTP 409", /active_order_locks[\s\S]{0,1200}res\.status\(409\)/.test(route)],
  ["Admin race returns ORDER_ALREADY_ACTIVE", route.includes('code: "ORDER_ALREADY_ACTIVE"')],
  ["Admin race is audited as operational conflict", route.includes('"ACTIVE_ORDER_RACE_BLOCKED_ADMIN"')],
  ["Courier race protection remains present", server.includes('"ACTIVE_ORDER_RACE_BLOCKED"') && server.includes('String(e.constraint || "").includes("active_order_locks")')]
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failed++;
}
if (failed) {
  console.error(`Admin manual race self-test failed: ${failed} check(s).`);
  process.exit(1);
}
console.log(`Admin manual race self-test passed: ${checks.length}/${checks.length}.`);
