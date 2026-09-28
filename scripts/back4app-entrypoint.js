import crypto from "node:crypto";
import http from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

const deploymentTarget = String(process.env.DEPLOYMENT_TARGET || "").trim();
if (deploymentTarget !== "back4app-homologation") {
  console.error("Refusing to start: DEPLOYMENT_TARGET must be back4app-homologation.");
  process.exit(78);
}

const forcedOff = {
  IFOOD_ENABLED: "false",
  IFOOD_DISPATCH_ENABLED: "false",
  IFOOD_CLIENT_ID: "",
  IFOOD_CLIENT_SECRET: "",
  IFOOD_CUSTOMER_ID: "",
  IFOOD_MERCHANT_ID: "",
  IFOOD_ALLOWED_MERCHANT_IDS: "",
  ANOTAAI_ENABLED: "false",
  ANOTAAI_CLIENT_ID: "",
  ANOTAAI_CLIENT_SECRET: "",
  ANOTAAI_PAGE_ID: "",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
  GOOGLE_SHEETS_SPREADSHEET_ID: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_SUBJECT: ""
};

for (const [key, value] of Object.entries(forcedOff)) process.env[key] = value;

// The homologation instance may talk to Postgres, but it must not call third-party HTTP APIs.
// Loopback remains available for local health checks inside the container.
const nativeFetch = globalThis.fetch;
const allowedHosts = new Set(
  String(process.env.HOMOLOGATION_ALLOWED_HTTP_HOSTS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);
for (const host of ["localhost", "127.0.0.1", "::1"]) allowedHosts.add(host);

globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" || input instanceof URL ? input : input?.url;
  const url = new URL(String(raw));
  if (!["http:", "https:"].includes(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase())) {
    const error = new Error(`Outbound HTTP blocked in Back4app homologation: ${url.hostname}`);
    error.code = "HOMOLOGATION_EGRESS_BLOCKED";
    throw error;
  }
  return nativeFetch(input, init);
};

const bootId = crypto.randomUUID();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

function processSnapshot() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    source: "back4app-homologation",
    bootId,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    rssMb: Number((memory.rss / 1048576).toFixed(2)),
    heapUsedMb: Number((memory.heapUsed / 1048576).toFixed(2)),
    heapTotalMb: Number((memory.heapTotal / 1048576).toFixed(2)),
    externalMb: Number((memory.external / 1048576).toFixed(2)),
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    eventLoopP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
    eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(2)),
    externalIntegrations: "forced-off"
  };
}

// Expose process-only diagnostics on the isolated homologation container. This
// path contains no configuration values and accepts no writes.
const nativeServerEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function homologationServerEmit(event, ...args) {
  if (event === "request") {
    const [request, response] = args;
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/api/homologation/metrics") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(processSnapshot()));
      return true;
    }
  }
  return nativeServerEmit.call(this, event, ...args);
};

let previousCpu = process.cpuUsage();
let previousSample = process.hrtime.bigint();

function writeMetric(type, fields = {}) {
  console.log(JSON.stringify({
    source: "back4app-homologation",
    type,
    bootId,
    timestamp: new Date().toISOString(),
    ...fields
  }));
}

writeMetric("boot", {
  node: process.version,
  pid: process.pid,
  deploymentTarget,
  externalIntegrations: "forced-off"
});

const metricTimer = setInterval(() => {
  const now = process.hrtime.bigint();
  const elapsedMs = Number(now - previousSample) / 1e6;
  const cpu = process.cpuUsage(previousCpu);
  const cpuCores = elapsedMs > 0 ? (cpu.user + cpu.system) / 1000 / elapsedMs : 0;

  writeMetric("runtime", {
    ...processSnapshot(),
    cpuCores: Number(cpuCores.toFixed(4)),
  });

  previousCpu = process.cpuUsage();
  previousSample = now;
  eventLoop.reset();
}, Math.max(5000, Number(process.env.HOMOLOGATION_METRIC_INTERVAL_MS || 15000)));
metricTimer.unref();

process.on("exit", code => writeMetric("exit", { code }));
process.on("uncaughtExceptionMonitor", error => {
  writeMetric("uncaughtException", { message: error?.message || String(error) });
});

await import("../server.js");

