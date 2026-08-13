import pg from "pg";
import bcrypt from "bcryptjs";
import fs from "node:fs";

const { Pool } = pg;

const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.LOADTEST_ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
const LOAD_TEST_KEY = process.env.LOAD_TEST_KEY || "";
const CONFIRM = process.env.LOAD_TEST_CONFIRM;

const COURIERS = Math.max(1, Number(process.env.COURIERS || 50));
const DEPARTURES = Math.max(1, Number(process.env.DEPARTURES_PER_COURIER || 40));
const ORDERS_PER_DEPARTURE = Math.min(5, Math.max(1, Number(process.env.ORDERS_PER_DEPARTURE || 3)));
const TEST_PASSWORD = "LoadTest!987654";
const RUN = `lt_${Date.now().toString(36)}`;

if (CONFIRM !== "STAGING_ONLY_I_UNDERSTAND") {
  console.error("ABORTADO: LOAD_TEST_CONFIRM incorreto.");
  process.exit(2);
}
if (!TARGET || !DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error("Faltam variáveis obrigatórias do teste.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
  max: 15
});

const userIds = [];
const latencies = [];
const failures = [];
const statusCounts = {};
let createdDepartures = 0;
let createdOrders = 0;
let adminConcurrentChecks = 0;
let replayRequests = 0;
let replayAccepted = 0;

const headers = () => ({
  "content-type": "application/json",
  ...(LOAD_TEST_KEY ? { "x-load-test-key": LOAD_TEST_KEY } : {})
});

function addStatus(status) {
  statusCounts[String(status)] = (statusCounts[String(status)] || 0) + 1;
}

function cookieFrom(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(username, password) {
  const started = performance.now();
  const res = await fetch(`${TARGET}/api/login`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username, password })
  });
  latencies.push(performance.now() - started);
  addStatus(res.status);

  if (!res.ok) {
    throw new Error(`login ${username}: HTTP ${res.status} ${await res.text()}`);
  }
  return cookieFrom(res);
}

async function call(path, cookie, opt = {}) {
  const started = performance.now();
  const res = await fetch(`${TARGET}${path}`, {
    ...opt,
    headers: {
      ...headers(),
      cookie,
      ...(opt.headers || {})
    }
  });
  latencies.push(performance.now() - started);
  addStatus(res.status);
  return res;
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
    `, [`Load Test ${i}`, `${RUN}_c${i}`, hash]);
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

function percentile(p) {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function round(n) {
  return Number(Number(n).toFixed(1));
}

function writeReport(report) {
  fs.writeFileSync(
    "full-staging-load-report.json",
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report, null, 2));
}

await seedCouriers();

let running = true;
let watcher = null;

try {
  const adminCookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD);

  // 50 logins acontecem de forma concorrente.
  const courierCookies = await Promise.all(
    Array.from({ length: COURIERS }, (_, i) =>
      login(`${RUN}_c${i + 1}`, TEST_PASSWORD)
    )
  );

  // Admin usa o sistema durante todo o pico.
  watcher = (async () => {
    while (running) {
      try {
        const responses = await Promise.all([
          call("/api/admin/dashboard", adminCookie),
          call("/api/admin/peak", adminCookie),
          call("/api/admin/history?page=1&page_size=25", adminCookie),
          call("/api/admin/conflicts?limit=30", adminCookie)
        ]);

        adminConcurrentChecks += responses.length;

        for (const r of responses) {
          if (!r.ok) failures.push(`admin-check:${r.status}`);
        }
      } catch (err) {
        failures.push(`admin-check:${err.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 150));
    }
  })();

  const started = performance.now();

  // Pico principal: todos os motoboys fazem saídas ao mesmo tempo.
  await Promise.all(courierCookies.map(async (cookie, courierIndex) => {
    for (let n = 1; n <= DEPARTURES; n++) {
      const orders = Array.from(
        { length: ORDERS_PER_DEPARTURE },
        (_, j) => `#${RUN.toUpperCase()}-${courierIndex + 1}-${n}-${j + 1}`
      );

      const token = `${RUN}-${courierIndex + 1}-${n}`;
      const payload = {
        order_numbers: orders,
        confirm_new_departure: true,
        confirm_recent_orders: true,
        client_token: token
      };

      const res = await call("/api/courier/depart", cookie, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        createdDepartures++;
        createdOrders += orders.length;
      } else {
        failures.push(
          `depart-c${courierIndex + 1}-n${n}:HTTP${res.status}:${await res.text()}`
        );
      }

      // 10% recebem replay deliberado do MESMO client_token.
      if (n % 10 === 0) {
        replayRequests++;
        const replay = await call("/api/courier/depart", cookie, {
          method: "POST",
          body: JSON.stringify(payload)
        });

        if (replay.ok) replayAccepted++;
        else failures.push(`idempotent-replay:HTTP${replay.status}`);
      }
    }
  }));

  const mainElapsed = performance.now() - started;

  // Validação após pico principal.
  const expectedDepartures = COURIERS * DEPARTURES;
  const activeBeforeRace = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatches
    WHERE courier_id=ANY($1::int[]) AND status='ON_ROAD'
  `, [userIds]);

  const duplicateActiveBeforeRace = await pool.query(`
    SELECT o.order_number,COUNT(*)::int AS c
    FROM dispatch_orders o
    JOIN dispatches d ON d.id=o.dispatch_id
    WHERE d.courier_id=ANY($1::int[]) AND d.status='ON_ROAD'
    GROUP BY o.order_number
    HAVING COUNT(*)>1
  `, [userIds]);

  const totalDispatchRows = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatches
    WHERE courier_id=ANY($1::int[])
  `, [userIds]);

  const totalOrderRows = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM dispatch_orders o
    JOIN dispatches d ON d.id=o.dispatch_id
    WHERE d.courier_id=ANY($1::int[])
  `, [userIds]);

  if (createdDepartures !== expectedDepartures) {
    failures.push(`created-departures:${createdDepartures}/${expectedDepartures}`);
  }
  if (activeBeforeRace.rows[0].c !== COURIERS) {
    failures.push(`active-before-race:${activeBeforeRace.rows[0].c}/${COURIERS}`);
  }
  if (duplicateActiveBeforeRace.rowCount !== 0) {
    failures.push(`duplicate-active-before-race:${duplicateActiveBeforeRace.rowCount}`);
  }
  if (totalDispatchRows.rows[0].c !== expectedDepartures) {
    failures.push(`db-dispatch-count:${totalDispatchRows.rows[0].c}/${expectedDepartures}`);
  }
  if (totalOrderRows.rows[0].c !== expectedDepartures * ORDERS_PER_DEPARTURE) {
    failures.push(
      `db-order-count:${totalOrderRows.rows[0].c}/${expectedDepartures * ORDERS_PER_DEPARTURE}`
    );
  }

  // Corrida real: 50 motoboys tentam registrar o mesmo pedido.
  const raceOrder = `#${RUN.toUpperCase()}-RACE-SAME-ORDER`;
  const raceStarted = performance.now();

  const raceResponses = await Promise.all(
    courierCookies.map((cookie, i) =>
      call("/api/courier/depart", cookie, {
        method: "POST",
        body: JSON.stringify({
          order_numbers: [raceOrder],
          confirm_new_departure: true,
          confirm_recent_orders: true,
          client_token: `${RUN}-race-${i + 1}`
        })
      })
    )
  );

  const raceElapsed = performance.now() - raceStarted;
  const raceSuccess = raceResponses.filter(r => r.ok).length;
  const raceBlocked = raceResponses.filter(r => r.status === 409).length;
  const raceOther = raceResponses.length - raceSuccess - raceBlocked;

  if (raceSuccess !== 1) failures.push(`race-success:${raceSuccess}/1`);
  if (raceBlocked !== COURIERS - 1) {
    failures.push(`race-blocked:${raceBlocked}/${COURIERS - 1}`);
  }
  if (raceOther !== 0) failures.push(`race-unexpected-http:${raceOther}`);

  const raceRows = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM active_order_locks
    WHERE order_number=$1
  `, [raceOrder]);

  if (raceRows.rows[0].c !== 1) {
    failures.push(`race-db-locks:${raceRows.rows[0].c}/1`);
  }

  const duplicateActiveAfterRace = await pool.query(`
    SELECT order_number,COUNT(*)::int AS c
    FROM active_order_locks
    WHERE courier_id=ANY($1::int[])
    GROUP BY order_number
    HAVING COUNT(*)>1
  `, [userIds]);

  if (duplicateActiveAfterRace.rowCount !== 0) {
    failures.push(`duplicate-active-after-race:${duplicateActiveAfterRace.rowCount}`);
  }

  running = false;
  await watcher;

  const report = {
    result: failures.length ? "FAIL" : "PASS",
    profile: {
      couriers: COURIERS,
      departuresPerCourier: DEPARTURES,
      ordersPerDeparture: ORDERS_PER_DEPARTURE,
      requestedDepartures: COURIERS * DEPARTURES,
      requestedOrders: COURIERS * DEPARTURES * ORDERS_PER_DEPARTURE
    },
    mainLoad: {
      createdDepartures,
      createdOrders,
      databaseDispatchRows: totalDispatchRows.rows[0].c,
      databaseOrderRows: totalOrderRows.rows[0].c,
      activeCouriersAtEnd: activeBeforeRace.rows[0].c,
      duplicateActiveOrders: duplicateActiveBeforeRace.rowCount,
      idempotentReplayRequests: replayRequests,
      idempotentReplaysAcceptedWithoutDuplicate: replayAccepted,
      adminConcurrentChecks,
      elapsedSeconds: Number((mainElapsed / 1000).toFixed(2)),
      throughputDeparturesPerSecond: Number(
        (createdDepartures / (mainElapsed / 1000)).toFixed(2)
      )
    },
    deliberateDatabaseRace: {
      sameOrder: raceOrder,
      simultaneousAttempts: COURIERS,
      successful: raceSuccess,
      blockedWith409: raceBlocked,
      unexpectedResponses: raceOther,
      activeLocksForSameOrder: raceRows.rows[0].c,
      elapsedMs: round(raceElapsed)
    },
    http: {
      totalMeasuredRequests: latencies.length,
      statusCounts,
      latencyMs: {
        p50: round(percentile(0.50)),
        p95: round(percentile(0.95)),
        p99: round(percentile(0.99)),
        max: round(Math.max(...latencies))
      }
    },
    failures: failures.slice(0, 50)
  };

  writeReport(report);

  if (failures.length) process.exitCode = 1;
} catch (err) {
  running = false;
  if (watcher) {
    try { await watcher; } catch {}
  }

  failures.push(`fatal:${err.message}`);

  writeReport({
    result: "FAIL",
    fatal: err.message,
    failures: failures.slice(0, 50)
  });

  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error("Falha ao limpar dados temporários:", err);
    process.exitCode = 1;
  }
  await pool.end();
}
