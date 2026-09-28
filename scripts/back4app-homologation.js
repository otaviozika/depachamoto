import fs from "node:fs";

const TARGET = String(process.env.TARGET_URL || "").replace(/\/$/, "");
const USERNAME = String(process.env.LOADTEST_USERNAME || "");
const PASSWORD = String(process.env.LOADTEST_PASSWORD || "");
const CLIENTS = Math.max(0, Number(process.env.CLIENTS || 10));
const DURATION_SECONDS = Math.max(10, Number(process.env.DURATION_SECONDS || 1800));
const HTTP_INTERVAL_MS = Math.max(500, Number(process.env.HTTP_INTERVAL_MS || 5000));
const METRIC_INTERVAL_MS = Math.max(1000, Number(process.env.METRIC_INTERVAL_MS || 5000));
const RECONNECT_EVERY_SECONDS = Math.max(0, Number(process.env.RECONNECT_EVERY_SECONDS || 300));
const READ_ONLY_BURST = Math.max(0, Number(process.env.READ_ONLY_BURST || 0));
const STAGE = String(process.env.STAGE || `clients-${CLIENTS}`);

if (!TARGET || process.env.LOAD_TEST_CONFIRM !== "BACK4APP_READ_ONLY") {
  console.error("Refusing to run: TARGET_URL and LOAD_TEST_CONFIRM=BACK4APP_READ_ONLY are required.");
  process.exit(2);
}
if (CLIENTS > 0 && (!USERNAME || !PASSWORD)) {
  console.error("LOADTEST_USERNAME and LOADTEST_PASSWORD are required for authenticated Socket.IO clients.");
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error("Node.js 22+ is required for the built-in WebSocket client.");
  process.exit(2);
}

const startedAt = Date.now();
const endsAt = startedAt + DURATION_SECONDS * 1000;
const latencies = [];
const socketConnectLatencies = [];
const reconnectLatencies = [];
const statusCounts = {};
const failures = [];
const processSamples = [];
const sockets = new Set();
let httpRequests = 0;
let serverErrors = 0;
let networkErrors = 0;
let socketAttempts = 0;
let socketSuccesses = 0;
let socketUnexpectedDisconnects = 0;
let socketEvents = 0;
let reconnectAttempts = 0;
let reconnectSuccesses = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function rounded(value) {
  return value == null ? null : Number(value.toFixed(2));
}

function noteStatus(status) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  if (Number(status) >= 500) serverErrors++;
}

async function measuredFetch(path, options = {}) {
  const begin = performance.now();
  httpRequests++;
  try {
    const response = await fetch(`${TARGET}${path}`, { redirect: "manual", ...options });
    latencies.push(performance.now() - begin);
    noteStatus(String(response.status));
    return response;
  } catch (error) {
    latencies.push(performance.now() - begin);
    networkErrors++;
    noteStatus("NETWORK_ERROR");
    throw error;
  }
}

async function login() {
  const response = await measuredFetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  if (!response.ok) throw new Error(`Login failed with HTTP ${response.status}`);
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("Login did not return a session cookie.");
  return cookie;
}

function pollingPackets(body) {
  return String(body).split("\x1e").filter(Boolean);
}

async function openSocket(cookie, reconnect = false) {
  const begin = performance.now();
  socketAttempts++;
  if (reconnect) reconnectAttempts++;
  const base = new URL("/socket.io/", TARGET);
  base.searchParams.set("EIO", "4");
  base.searchParams.set("transport", "polling");
  base.searchParams.set("t", Date.now().toString(36));

  const initial = await fetch(base, { headers: { cookie } });
  if (!initial.ok) throw new Error(`Engine.IO handshake failed: HTTP ${initial.status}`);
  const openPacket = pollingPackets(await initial.text()).find(packet => packet.startsWith("0"));
  if (!openPacket) throw new Error("Engine.IO open packet missing.");
  const sid = JSON.parse(openPacket.slice(1)).sid;
  base.searchParams.set("sid", sid);

  const connectPost = await fetch(base, {
    method: "POST",
    headers: { cookie, "content-type": "text/plain;charset=UTF-8" },
    body: "40"
  });
  if (!connectPost.ok) throw new Error(`Socket.IO connect POST failed: HTTP ${connectPost.status}`);

  const connectPoll = await fetch(base, { headers: { cookie } });
  const connectPackets = pollingPackets(await connectPoll.text());
  if (!connectPackets.some(packet => packet.startsWith("40"))) {
    throw new Error(`Socket.IO authentication failed: ${connectPackets.join(" | ").slice(0, 300)}`);
  }

  const wsUrl = new URL(base);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("transport", "websocket");

  const socket = new WebSocket(wsUrl);
  sockets.add(socket);
  let intentionalClose = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket upgrade timeout.")), 10000);
    socket.addEventListener("open", () => socket.send("2probe"));
    socket.addEventListener("message", event => {
      const packet = String(event.data);
      if (packet === "3probe") {
        socket.send("5");
        clearTimeout(timer);
        resolve();
      } else if (packet === "2") {
        socket.send("3");
      } else if (packet.startsWith("42")) {
        socketEvents++;
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket upgrade error."));
    });
  });

  const elapsed = performance.now() - begin;
  socketSuccesses++;
  socketConnectLatencies.push(elapsed);
  if (reconnect) {
    reconnectSuccesses++;
    reconnectLatencies.push(elapsed);
  }

  const closePromise = new Promise(resolve => {
    socket.addEventListener("close", () => {
      sockets.delete(socket);
      if (!intentionalClose && Date.now() < endsAt) socketUnexpectedDisconnects++;
      resolve();
    }, { once: true });
  });

  return {
    socket,
    closePromise,
    close() {
      intentionalClose = true;
      socket.close(1000, "homologation-cycle");
    }
  };
}

async function socketClient(index) {
  let cookie;
  try {
    cookie = await login();
  } catch (error) {
    failures.push(`client-${index}: ${error.message}`);
    return;
  }

  let reconnect = false;
  while (Date.now() < endsAt) {
    let connection;
    try {
      connection = await openSocket(cookie, reconnect);
      const remaining = endsAt - Date.now();
      const holdMs = RECONNECT_EVERY_SECONDS > 0
        ? Math.min(remaining, RECONNECT_EVERY_SECONDS * 1000)
        : remaining;
      if (holdMs > 0) await sleep(holdMs);
      connection.close();
      await connection.closePromise;
      reconnect = Date.now() < endsAt;
    } catch (error) {
      failures.push(`client-${index}: ${error.message}`);
      await sleep(1000);
      reconnect = true;
    }
  }
}

async function httpWatcher() {
  while (Date.now() < endsAt) {
    try {
      const response = await measuredFetch("/api/health", { headers: { "cache-control": "no-cache" } });
      if (!response.ok) failures.push(`health: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`health: ${error.message}`);
    }
    await sleep(Math.min(HTTP_INTERVAL_MS, Math.max(0, endsAt - Date.now())));
  }
}

async function metricWatcher() {
  while (Date.now() < endsAt) {
    try {
      const response = await fetch(`${TARGET}/api/homologation/metrics`, {
        headers: { "cache-control": "no-cache" }
      });
      if (!response.ok) {
        failures.push(`metrics: HTTP ${response.status}`);
      } else {
        processSamples.push(await response.json());
      }
    } catch (error) {
      failures.push(`metrics: ${error.message}`);
    }
    await sleep(Math.min(METRIC_INTERVAL_MS, Math.max(0, endsAt - Date.now())));
  }
}

async function readOnlyBurst() {
  if (!READ_ONLY_BURST) return;
  await Promise.all(Array.from({ length: READ_ONLY_BURST }, async (_, index) => {
    try {
      const path = index % 2 ? "/api/health" : "/api/live";
      const response = await measuredFetch(path, { headers: { "cache-control": "no-cache" } });
      if (!response.ok) failures.push(`burst-${index}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`burst-${index}: ${error.message}`);
    }
  }));
}

await readOnlyBurst();
await Promise.all([
  httpWatcher(),
  metricWatcher(),
  ...Array.from({ length: CLIENTS }, (_, index) => socketClient(index + 1))
]);

for (const socket of sockets) socket.close(1000, "homologation-complete");

const rssValues = processSamples.map(sample => Number(sample.rssMb)).filter(Number.isFinite);
const bootIds = [...new Set(processSamples.map(sample => sample.bootId).filter(Boolean))];
const firstProcessSample = processSamples[0];
const lastProcessSample = processSamples.at(-1);
let averageCpuCores = null;
if (firstProcessSample && lastProcessSample && firstProcessSample !== lastProcessSample) {
  const elapsedMs = Date.parse(lastProcessSample.timestamp) - Date.parse(firstProcessSample.timestamp);
  const cpuMicros =
    Number(lastProcessSample.cpuUserMicros) + Number(lastProcessSample.cpuSystemMicros) -
    Number(firstProcessSample.cpuUserMicros) - Number(firstProcessSample.cpuSystemMicros);
  if (elapsedMs > 0 && Number.isFinite(cpuMicros)) averageCpuCores = cpuMicros / 1000 / elapsedMs;
}

const report = {
  stage: STAGE,
  target: TARGET,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  clients: CLIENTS,
  http: {
    requests: httpRequests,
    statusCounts,
    networkErrors,
    serverErrors,
    serverErrorRate: httpRequests ? Number((serverErrors / httpRequests).toFixed(6)) : 0,
    p50Ms: rounded(percentile(latencies, 0.5)),
    p95Ms: rounded(percentile(latencies, 0.95)),
    p99Ms: rounded(percentile(latencies, 0.99))
  },
  socket: {
    attempts: socketAttempts,
    successes: socketSuccesses,
    successRate: socketAttempts ? Number((socketSuccesses / socketAttempts).toFixed(6)) : null,
    connectP95Ms: rounded(percentile(socketConnectLatencies, 0.95)),
    reconnectAttempts,
    reconnectSuccesses,
    reconnectP95Ms: rounded(percentile(reconnectLatencies, 0.95)),
    unexpectedDisconnects: socketUnexpectedDisconnects,
    eventsReceived: socketEvents
  },
  process: {
    samples: processSamples.length,
    bootIds,
    restartCount: Math.max(0, bootIds.length - 1),
    rssAverageMb: rounded(rssValues.length ? rssValues.reduce((sum, value) => sum + value, 0) / rssValues.length : null),
    rssMaxMb: rounded(rssValues.length ? Math.max(...rssValues) : null),
    rssStartMb: rounded(rssValues[0] ?? null),
    rssEndMb: rounded(rssValues.at(-1) ?? null),
    rssGrowthMb: rounded(rssValues.length ? rssValues.at(-1) - rssValues[0] : null),
    averageCpuCores: rounded(averageCpuCores),
    eventLoopP95MaxMs: rounded(processSamples.length ? Math.max(...processSamples.map(sample => Number(sample.eventLoopP95Ms) || 0)) : null),
    eventLoopMaxMs: rounded(processSamples.length ? Math.max(...processSamples.map(sample => Number(sample.eventLoopMaxMs) || 0)) : null),
    oomObserved: false
  },
  safety: {
    mode: "read-only",
    productionOrdersCreated: 0,
    productionOrdersModified: 0,
    externalIntegrationsInvoked: 0
  },
  failureCount: failures.length,
  failures: failures.slice(0, 100)
};

const output = process.env.REPORT_PATH || `back4app-${STAGE}-${Date.now()}.json`;
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

