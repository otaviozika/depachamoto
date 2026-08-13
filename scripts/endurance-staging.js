import pg from "pg";
import bcrypt from "bcryptjs";
import fs from "node:fs";

const { Pool } = pg;

const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.LOADTEST_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
const CONFIRM = process.env.LOAD_TEST_CONFIRM;

const COURIERS = Math.max(1, Number(process.env.COURIERS || 40));
const DURATION_MINUTES = Math.max(1, Number(process.env.DURATION_MINUTES || 30));
const DEPARTURE_INTERVAL_SECONDS = Math.max(5, Number(process.env.DEPARTURE_INTERVAL_SECONDS || 30));
const ORDERS_PER_DEPARTURE = Math.min(5, Math.max(1, Number(process.env.ORDERS_PER_DEPARTURE || 3)));

const TEST_PASSWORD = "EnduranceTest!987654";
const RUN = `end_${Date.now().toString(36)}`;

if (CONFIRM !== "STAGING_ONLY_I_UNDERSTAND") {
  console.error("ABORTADO: este teste só pode rodar em staging isolado.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
  max: 15
});

const userIds = [];
const latencies = [];
const errors = [];
const statusCounts = {};
const minuteBuckets = new Map();

let createdDepartures = 0;
let createdOrders = 0;
let adminChecks = 0;
let healthChecks = 0;
let replayRequests = 0;
let replayAccepted = 0;

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

function noteStatus(status) {
  const k = String(status);
  statusCounts[k] = (statusCounts[k] || 0) + 1;
}

function noteLatency(ms) {
  latencies.push(ms);
  const minute = Math.floor((Date.now() - startedWallClock) / 60000);
  if (!minuteBuckets.has(minute)) minuteBuckets.set(minute, []);
  minuteBuckets.get(minute).push(ms);
}

async function request(path, cookie = "", opt = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${TARGET}${path}`, {
      ...opt,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(opt.headers || {})
      }
    });
    noteLatency(performance.now() - started);
    noteStatus(res.status);
    return res;
  } catch (err) {
    noteLatency(performance.now() - started);
    noteStatus("NETWORK_ERROR");
    throw err;
  }
}

async function login(username, password) {
  const res = await request("/api/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`Falha login ${username}: ${res.status} ${await res.text()}`);
  return cookieFrom(res);
}

async function seedCouriers() {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  for (let i = 1; i <= COURIERS; i++) {
    const q = await pool.query(`
      INSERT INTO users(
        name,username,password_hash,role,
        approval_status,active,must_change_password
      )
      VALUES($1,$2,$3,'courier','APPROVED',true,false)
      RETURNING id
    `, [`Endurance ${i}`, `${RUN}_c${i}`, hash]);
    userIds.push(q.rows[0].id);
  }
}

async function cleanup() {
  if (!userIds.length) return;
  await pool.query("BEGIN");
  try {
    await pool.query(
      "DELETE FROM operational_conflicts WHERE actor_user_id=ANY($1::int[]) OR courier_id=ANY($1::int[])",
      [userIds]
    );
    await pool.query("DELETE FROM notifications WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM audit_logs WHERE user_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM active_order_locks WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM dispatches WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b) => a-b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function round(n) {
  return Number(Number(n).toFixed(1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const startedWallClock = Date.now();
const endAt = startedWallClock + DURATION_MINUTES * 60_000;

await seedCouriers();

try {
  const adminCookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD);

  const courierCookies = await Promise.all(
    Array.from({ length: COURIERS }, (_, i) =>
      login(`${RUN}_c${i + 1}`, TEST_PASSWORD)
    )
  );

  let running = true;

  const adminWatcher = (async () => {
    while (running) {
      try {
        const rs = await Promise.all([
          request("/api/admin/dashboard", adminCookie),
          request("/api/admin/peak", adminCookie),
          request("/api/admin/history?page=1&page_size=25", adminCookie),
          request("/api/admin/conflicts?limit=30", adminCookie),
          request("/api/admin/monitoring", adminCookie)
        ]);
        adminChecks += rs.length;
        for (const r of rs) {
          if (!r.ok) errors.push(`admin:${r.status}`);
        }
      } catch (err) {
        errors.push(`admin:${err.message}`);
      }
      await sleep(5000);
    }
  })();

  const healthWatcher = (async () => {
    while (running) {
      try {
        const r = await request("/api/health");
        healthChecks++;
        if (!r.ok) errors.push(`health:${r.status}`);
      } catch (err) {
        errors.push(`health:${err.message}`);
      }
      await sleep(3000);
    }
  })();

  // 40 fluxos independentes: cada motoboy registra nova saída periodicamente.
  await Promise.all(courierCookies.map(async (cookie, courierIndex) => {
    let sequence = 0;

    // Espalha o primeiro disparo para não sincronizar todos exatamente no mesmo milissegundo.
    await sleep((courierIndex % 10) * 150);

    while (Date.now() < endAt) {
      sequence++;

      const orders = Array.from(
        { length: ORDERS_PER_DEPARTURE },
        (_, j) => `#${RUN.toUpperCase()}-${courierIndex + 1}-${sequence}-${j + 1}`
      );

      const token = `${RUN}-${courierIndex + 1}-${sequence}`;

      try {
        const r = await request("/api/courier/depart", cookie, {
          method: "POST",
          body: JSON.stringify({
            order_numbers: orders,
            confirm_new_departure: true,
            confirm_recent_orders: true,
            client_token: token
          })
        });

        if (r.ok) {
          createdDepartures++;
          createdOrders += orders.length;
        } else {
          errors.push(`depart-c${courierIndex + 1}-${sequence}:${r.status}`);
        }

        // A cada 10 saídas, reenvia o mesmo token para validar idempotência ao longo do tempo.
        if (sequence % 10 === 0) {
          replayRequests++;
          const replay = await request("/api/courier/depart", cookie, {
            method: "POST",
            body: JSON.stringify({
              order_numbers: orders,
              confirm_new_departure: true,
              confirm_recent_orders: true,
              client_token: token
            })
          });
          if (replay.ok) replayAccepted++;
          else errors.push(`replay-c${courierIndex + 1}-${sequence}:${replay.status}`);
        }

        // Simula uma pequena "queda" do aparelho: alguns motoboys ficam sem enviar por 90s.
        if (sequence % 20 === 0 && courierIndex % 8 === 0) {
          await sleep(90_000);
        }
      } catch (err) {
        errors.push(`depart-c${courierIndex + 1}-${sequence}:${err.message}`);
      }

      await sleep(DEPARTURE_INTERVAL_SECONDS * 1000);
    }
  }));

  running = false;
  await Promise.all([adminWatcher, healthWatcher]);

  const active = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatches
    WHERE courier_id=ANY($1::int[]) AND status='ON_ROAD'
  `, [userIds]);

  const duplicateActive = await pool.query(`
    SELECT order_number,COUNT(*)::int AS c
    FROM active_order_locks
    WHERE courier_id=ANY($1::int[])
    GROUP BY order_number
    HAVING COUNT(*) > 1
  `, [userIds]);

  const dispatchRows = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatches
    WHERE courier_id=ANY($1::int[])
  `, [userIds]);

  const orderRows = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatch_orders o
    JOIN dispatches d ON d.id=o.dispatch_id
    WHERE d.courier_id=ANY($1::int[])
  `, [userIds]);

  const perMinute = [...minuteBuckets.entries()].map(([minute, values]) => ({
    minute,
    requests: values.length,
    p50Ms: round(percentile(values, .50)),
    p95Ms: round(percentile(values, .95)),
    p99Ms: round(percentile(values, .99)),
    maxMs: round(Math.max(...values))
  }));

  // Degradação: compara os primeiros 5 minutos com os últimos 5 minutos.
  const first = perMinute.slice(0, 5).flatMap(x => minuteBuckets.get(x.minute) || []);
  const last = perMinute.slice(-5).flatMap(x => minuteBuckets.get(x.minute) || []);
  const firstP95 = percentile(first, .95);
  const lastP95 = percentile(last, .95);
  const degradationPercent = firstP95 > 0 ? ((lastP95 - firstP95) / firstP95) * 100 : 0;

  const hardFailures = errors.filter(e =>
    !e.startsWith("depart-") || !e.endsWith(":409")
  );

  const report = {
    result:
      hardFailures.length === 0 &&
      duplicateActive.rowCount === 0 &&
      active.rows[0].c === COURIERS &&
      replayAccepted === replayRequests
        ? "PASS"
        : "FAIL",
    profile: {
      couriers: COURIERS,
      durationMinutes: DURATION_MINUTES,
      departureIntervalSeconds: DEPARTURE_INTERVAL_SECONDS,
      ordersPerDeparture: ORDERS_PER_DEPARTURE
    },
    operation: {
      createdDepartures,
      createdOrders,
      databaseDispatchRows: dispatchRows.rows[0].c,
      databaseOrderRows: orderRows.rows[0].c,
      activeCouriersAtEnd: active.rows[0].c,
      duplicateActiveOrders: duplicateActive.rowCount,
      replayRequests,
      replayAccepted,
      adminChecks,
      healthChecks
    },
    latency: {
      overallP50Ms: round(percentile(latencies, .50)),
      overallP95Ms: round(percentile(latencies, .95)),
      overallP99Ms: round(percentile(latencies, .99)),
      maxMs: round(Math.max(...latencies)),
      first5MinutesP95Ms: round(firstP95),
      last5MinutesP95Ms: round(lastP95),
      degradationPercent: round(degradationPercent)
    },
    statusCounts,
    perMinute,
    errors: errors.slice(0, 100)
  };

  fs.writeFileSync(
    "endurance-report.json",
    JSON.stringify(report, null, 2) + "\n"
  );

  console.log(JSON.stringify(report, null, 2));

  if (report.result !== "PASS") process.exitCode = 1;
} catch (err) {
  const report = {
    result: "FAIL",
    fatal: err.message,
    errors: errors.slice(0, 100)
  };
  fs.writeFileSync("endurance-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error("Falha na limpeza:", err);
    process.exitCode = 1;
  }
  await pool.end();
}
