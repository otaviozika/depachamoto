import fs from "node:fs";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
}

const start = source.indexOf('app.get("/api/health", async (req, res) => {');
const end = source.indexOf('\n\napp.get("/{*splat}"', start);
const health = start >= 0 && end > start ? source.slice(start, end) : "";

check("health route exists", Boolean(health));
check("preserves ok contract", health.includes("ok: true"));
check("preserves database contract", health.includes('database: "connected"'));
check("preserves environment contract", health.includes("environment: APP_ENV"));
check("preserves staging safety contract", health.includes("stagingSafeMode: STAGING_SAFE_MODE"));
check("publishes canonical health status", health.includes("status,"));
check("checks iFood terminal queue", health.includes("ifood_failed"));
check("checks Anota AI DEAD queue", health.includes("anota_dead"));
check("checks stale workers", health.includes("staleQueue"));
check("checks overdue and retry queue", health.includes("delayedQueue"));
check("checks recent 5xx", health.includes("errors_5xx_15m"));
check("checks critical operational conflicts", health.includes("critical_conflicts"));
check("checks abnormal order locks", health.includes("abnormal_locks"));
check("checks DB latency", health.includes("dbLatencyMs >= 1500") && health.includes("dbLatencyMs > 250"));
check("checks DB pool pressure", health.includes("pool.waitingCount > 0"));
check("reports WebSocket engine", health.includes("connectedClients") && health.includes("io.engine?.clientsCount"));
check("reports memory without secrets", health.includes("rssMb") && health.includes("heapUsedMb"));
check("staging integrations are protected", health.includes('STAGING_SAFE_MODE ? "protected" : "healthy"'));
check("operational critical state stays HTTP 200", health.includes("res.json({") && health.includes("criticalReasons"));
check("infrastructure failure returns 503", health.includes("res.status(503).json({"));
check("503 response is sanitized", !health.includes("err.message") && !health.includes("CLIENT_SECRET"));
check("health center uses environment-aware iFood requirement", source.includes("if (ifoodRequired && !ifoodConfigured()) criticalReasons.push"));
check("health center uses environment-aware Anota requirement", source.includes("if (anotaRequired && !anotaAiConfigured()) criticalReasons.push"));

const failed = checks.filter(x => !x.ok);
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"} - ${item.name}`);
console.log(`Health observability: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
