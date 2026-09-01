import fs from "node:fs";
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const checks = [
  [pkg.version === "3.5.4", "package version 3.5.4"],
  [server.includes('const VERSION = "3.5.4"'), "server version 3.5.4"],
  [server.includes("const cancellationPayload = {"), "cancellation payload helper"],
  [server.includes("reason: cancellationCodeRaw"), "reason field preserved"],
  [server.includes("cancellationCode"), "cancellationCode field sent"],
  [server.includes("JSON.stringify(cancellationPayload)"), "payload is posted to iFood"],
  [server.includes("cancellation_code: cancellationCode"), "audit stores cancellationCode"],
];
let failed = 0;
for (const [ok, label] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} - ${label}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
