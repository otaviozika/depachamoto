import fs from "node:fs";

const TARGET = String(process.env.TARGET_URL || "").replace(/\/$/, "");
const TOTAL = Math.max(1, Number(process.env.REQUESTS || 5000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 50));

if (!TARGET.startsWith("https://") && !TARGET.startsWith("http://")) {
  console.error("TARGET_URL inválida.");
  process.exit(2);
}

let next = 0;
let ok = 0;
let failed = 0;
const statusCounts = {};
const latencies = [];
const errors = [];

async function worker(workerId) {
  while (true) {
    const i = next++;
    if (i >= TOTAL) return;

    const started = performance.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(`${TARGET}/api/health`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "accept": "application/json",
          "user-agent": "DespachaMoto-Health-Load-Test/1.0"
        }
      });

      clearTimeout(timeout);

      statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;

      if (response.ok) ok++;
      else failed++;
    } catch (err) {
      failed++;
      const name = err?.name || "Error";
      statusCounts[name] = (statusCounts[name] || 0) + 1;
      if (errors.length < 20) {
        errors.push({
          worker: workerId,
          message: String(err?.message || err)
        });
      }
    }

    latencies.push(performance.now() - started);
  }
}

const startedAll = performance.now();

await Promise.all(
  Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1))
);

const elapsedMs = performance.now() - startedAll;

latencies.sort((a, b) => a - b);

function percentile(p) {
  if (!latencies.length) return 0;
  const index = Math.min(
    latencies.length - 1,
    Math.floor((latencies.length - 1) * p)
  );
  return latencies[index];
}

const report = {
  result: failed === 0 ? "PASS" : "FAIL",
  target: `${TARGET}/api/health`,
  requests: TOTAL,
  concurrency: CONCURRENCY,
  ok,
  failed,
  successRatePercent: Number(((ok / TOTAL) * 100).toFixed(3)),
  elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
  requestsPerSecond: Number((TOTAL / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: {
    min: Number((latencies[0] || 0).toFixed(1)),
    p50: Number(percentile(0.50).toFixed(1)),
    p95: Number(percentile(0.95).toFixed(1)),
    p99: Number(percentile(0.99).toFixed(1)),
    max: Number((latencies[latencies.length - 1] || 0).toFixed(1))
  },
  statusCounts,
  sampleErrors: errors
};

fs.writeFileSync(
  "load-test-report.json",
  JSON.stringify(report, null, 2) + "\n"
);

console.log(JSON.stringify(report, null, 2));

if (failed > 0) {
  process.exitCode = 1;
}
