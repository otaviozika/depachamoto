const TARGET = (process.env.TARGET_URL || "http://localhost:3000").replace(/\/$/, "");
const TOTAL = Math.max(1, Number(process.env.REQUESTS || 1000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 25));

let next = 0;
let ok = 0;
let failed = 0;
const latencies = [];

async function worker() {
  while (true) {
    const i = next++;
    if (i >= TOTAL) return;
    const start = performance.now();
    try {
      const r = await fetch(`${TARGET}/api/health`, { cache: "no-store" });
      if (r.ok) ok++; else failed++;
    } catch {
      failed++;
    }
    latencies.push(performance.now() - start);
  }
}

const startAll = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const totalMs = performance.now() - startAll;
latencies.sort((a,b)=>a-b);
const pct = p => latencies[Math.min(latencies.length-1, Math.floor(latencies.length*p))] || 0;

console.log(JSON.stringify({
  target: TARGET,
  requests: TOTAL,
  concurrency: CONCURRENCY,
  ok,
  failed,
  seconds: Number((totalMs/1000).toFixed(2)),
  requestsPerSecond: Number((TOTAL/(totalMs/1000)).toFixed(2)),
  latencyMs: {
    p50: Number(pct(.50).toFixed(1)),
    p95: Number(pct(.95).toFixed(1)),
    p99: Number(pct(.99).toFixed(1))
  }
}, null, 2));

if (failed) process.exitCode = 1;
