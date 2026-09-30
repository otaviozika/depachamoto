import fs from "node:fs";
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const checks=[
 ["panel exists",/id="loadTestLive"/.test(html)],
 ["staging only",/body\.staging-mode #adminApp \.loadtest-live\{display:block\}/.test(html)],
 ["waiting state",/>AGUARDANDO INÍCIO</.test(html)],
 ["L1 normal",/L1 • NORMAL • 20 MOTOBOYS/.test(html)],
 ["L2 peak",/L2 • PICO REAL • 40/.test(html)],
 ["L3 stress",/L3 • STRESS • 60–80/.test(html)],
 ["L4 burst",/L4 • BURST/.test(html)],
 ["courier metric",/id="ltCouriers"/.test(html)],
 ["request metric",/id="ltRequests"/.test(html)],
 ["rps metric",/id="ltRps"/.test(html)],
 ["p50 metric",/id="ltP50"/.test(html)],
 ["p95 metric",/id="ltP95"/.test(html)],
 ["p99 metric",/id="ltP99"/.test(html)],
 ["5xx metric",/id="lt5xx"/.test(html)],
 ["lost orders invariant",/id="ltLost"/.test(html)],
 ["duplicate invariant",/id="ltDuplicates"/.test(html)],
 ["orphan locks invariant",/id="ltOrphanLocks"/.test(html)],
 ["corruption invariant",/id="ltCorruption"/.test(html)],
 ["integrity metric",/id="ltIntegrity">100%/.test(html)]
];
let failed=0;for(const [name,ok] of checks){console.log((ok?"PASS":"FAIL")+" - "+name);if(!ok)failed++}
if(failed)process.exit(1);
console.log(`Load test live panel self-test passed: ${checks.length}/${checks.length}.`);
