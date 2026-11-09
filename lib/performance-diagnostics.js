// Opt-in staging diagnostics. No credentials, PII, request bodies, SQL text or IDs.
// Designed to measure middleware/session time as well as handler stages.
import { performance } from "node:perf_hooks";

const ROUTES = Object.freeze({
  "POST /api/login": "login",
  "POST /api/courier/pre-departures": "predeparture_create",
  "GET /api/admin/dashboard": "admin_dashboard",
  "GET /api/courier/pre-departure": "predeparture_read"
});
const round = n => Number(n.toFixed(2));

export function createPerformanceDiagnostics({ appEnv, env = process.env, pool, logger = console }) {
  const enabled = appEnv === "staging" && env.PERF_DIAGNOSTICS === "true";

  function snapshot() {
    return {
      pool_total: Number(pool.totalCount || 0),
      pool_idle: Number(pool.idleCount || 0),
      pool_waiting: Number(pool.waitingCount || 0)
    };
  }

  function middleware(req, res, next) {
    if (!enabled) return next();
    const name = ROUTES[req.method + " " + req.path];
    if (!name) return next();

    const started = performance.now();
    const atStart = snapshot();
    const stages = Object.create(null);
    req.perfStages = stages;
    res.once("finish", () => {
      const duration = performance.now() - started;
      // Deliberately no req URL, params, cookies, headers, usernames or SQL.
      logger.info("STAGING_PERF_V1 " + JSON.stringify({
        operation: name,
        status: res.statusCode,
        total_ms: round(duration),
        phases_ms: stages,
        pool_start: atStart,
        pool_end: snapshot()
      }));
    });
    next();
  }

  async function span(req, name, operation) {
    if (!enabled || !req?.perfStages) return operation();
    const start = performance.now();
    try {
      return await operation();
    } finally {
      if (/^[a-z_]{2,32}$/.test(name)) {
        req.perfStages[name] = round(performance.now() - start);
      }
    }
  }

  function transaction({ acquire_ms, hold_ms, success, wait_start = 0 }) {
    if (!enabled) return;
    logger.info("STAGING_PERF_TX_V1 " + JSON.stringify({
      operation: "predeparture_transaction",
      success: Boolean(success),
      acquire_ms: round(Math.max(0, acquire_ms)),
      hold_ms: round(Math.max(0, hold_ms)),
      waiting_on_acquire: Math.max(0, Number(wait_start) || 0),
      pool_end: snapshot()
    }));
  }

  return { enabled, middleware, span, transaction };
}
