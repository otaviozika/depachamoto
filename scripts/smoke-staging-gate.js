import pg from "pg";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import { operationalShiftAt } from "../lib/operational-shift.js";

const { Pool } = pg;

const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const DATABASE_URL = String(process.env.DATABASE_URL || "");
const ADMIN_USERNAME = String(process.env.LOADTEST_ADMIN_USERNAME || "");
const ADMIN_PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || "");
const LOAD_TEST_KEY = String(process.env.LOAD_TEST_KEY || "");
const CONFIRM = String(process.env.LOAD_TEST_CONFIRM || "");
const FIXED_NOW = String(process.env.OPERATIONAL_NOW_OVERRIDE || "");

const COURIERS = Math.max(2, Number(process.env.COURIERS || 8));
const DEPARTURES = Math.max(1, Number(process.env.DEPARTURES_PER_COURIER || 3));
const TEST_PASSWORD = "StagingCourier!987654";
const RUN = String(Date.now()).slice(-8);

if (CONFIRM !== "STAGING_ONLY_I_UNDERSTAND") {
  console.error("ABORTADO: LOAD_TEST_CONFIRM incorreto.");
  process.exit(2);
}
if (!TARGET || !DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD || !FIXED_NOW) {
  console.error("Faltam variáveis obrigatórias do smoke de staging.");
  process.exit(2);
}

const fixedDate = new Date(FIXED_NOW);
const shift = operationalShiftAt(fixedDate, { required: true });

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false, max: 12 });
const userIds = [];
const latencies = [];
const failures = [];
const statusCounts = {};
let created = 0;
let duplicateReplays = 0;
let releases = 0;

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

async function call(path, cookie, options = {}) {
  const started = performance.now();
  const res = await fetch(`${TARGET}${path}`, {
    ...options,
    headers: {
      ...headers(),
      cookie,
      ...(options.headers || {})
    }
  });
  latencies.push(performance.now() - started);
  addStatus(res.status);
  return res;
}

async function login(username, password) {
  const res = await call("/api/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${await res.text()}`);
  return cookieFrom(res);
}

async function seedCouriers(adminId) {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  for (let i = 1; i <= COURIERS; i++) {
    const row = (await pool.query(`
      INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
      VALUES($1,$2,$3,'courier','APPROVED',TRUE,FALSE)
      RETURNING id
    `, [`Staging Smoke ${i}`, `stg_${RUN}_${i}`, hash])).rows[0];

    userIds.push(Number(row.id));

    await pool.query(`
      INSERT INTO courier_attendance(
        courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason
      )
      VALUES($1,$2::date,$3,$4::timestamptz,'ADMIN',$5,'Smoke de homologacao')
      ON CONFLICT(courier_id,attendance_date,shift_code)
      WHERE shift_code IS NOT NULL
      DO NOTHING
    `, [row.id, shift.operational_date, shift.shift_code, FIXED_NOW, adminId]);
  }
}

async function cleanup() {
  if (!userIds.length) return;
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM operational_conflicts WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM notifications WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM active_order_locks WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM dispatches WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM courier_attendance WHERE courier_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

function percentile(p) {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

let report = null;

try {
  const admin = (await pool.query(
    "SELECT id FROM users WHERE username=$1 AND role='admin' LIMIT 1",
    [ADMIN_USERNAME.toLowerCase()]
  )).rows[0];
  if (!admin) throw new Error("Admin de staging não encontrado após bootstrap.");

  await seedCouriers(Number(admin.id));
  const adminCookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD);

  const health = await call("/api/health", adminCookie);
  const healthBody = await health.json();
  if (!health.ok || healthBody.environment !== "staging" ||
      healthBody.stagingSafeMode !== true ||
      healthBody.externalMutationsAllowed !== false) {
    throw new Error(`Health de staging inválido: ${JSON.stringify(healthBody)}`);
  }

  const started = performance.now();

  for (let cycle = 1; cycle <= DEPARTURES; cycle++) {
    await Promise.all(userIds.map(async (courierId, index) => {
      const orders = [
        `#9${RUN.slice(-5)}${String(cycle).padStart(2,"0")}${String(index + 1).padStart(2,"0")}1`,
        `#8${RUN.slice(-5)}${String(cycle).padStart(2,"0")}${String(index + 1).padStart(2,"0")}2`
      ];
      const clientToken = `staging-${RUN}-${courierId}-${cycle}`;
      const payload = {
        courier_id: courierId,
        order_numbers: orders,
        reason: "Smoke automatizado de homologacao",
        client_token: clientToken,
        confirm_recent_orders: true
      };

      const res = await call("/api/admin/dispatches/manual", adminCookie, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (res.status !== 201) {
        failures.push(`manual-c${courierId}-n${cycle}:HTTP${res.status}:${await res.text()}`);
        return;
      }

      const body = await res.json();
      const dispatchId = Number(body.dispatch?.id);
      if (!dispatchId) {
        failures.push(`manual-c${courierId}-n${cycle}:missing-dispatch`);
        return;
      }
      created++;

      if (cycle === 1) {
        const replay = await call("/api/admin/dispatches/manual", adminCookie, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (replay.ok) {
          const replayBody = await replay.json();
          if (replayBody.duplicate === true && Number(replayBody.dispatch?.id) === dispatchId) {
            duplicateReplays++;
          } else {
            failures.push(`replay-c${courierId}:not-idempotent`);
          }
        } else {
          failures.push(`replay-c${courierId}:HTTP${replay.status}`);
        }
      }

      const release = await call(`/api/admin/dispatches/${dispatchId}/release`, adminCookie, {
        method: "POST",
        body: JSON.stringify({ reason: "Liberacao do smoke de homologacao" })
      });
      if (!release.ok) failures.push(`release-c${courierId}-n${cycle}:HTTP${release.status}:${await release.text()}`);
      else releases++;
    }));
  }

  const raceOrder = `#7${RUN}77`;
  const race = await Promise.all(userIds.map(async courierId => {
    const res = await call("/api/admin/dispatches/manual", adminCookie, {
      method: "POST",
      body: JSON.stringify({
        courier_id: courierId,
        order_numbers: [raceOrder],
        reason: "Corrida de duplicidade do staging",
        client_token: `race-${RUN}-${courierId}`,
        confirm_recent_orders: true
      })
    });
    return { courierId, status: res.status, text: res.ok ? "" : await res.text(), body: res.ok ? await res.json() : null };
  }));

  const raceSuccess = race.filter(x => x.status === 201);
  const raceBlocked = race.filter(x => x.status === 409);
  const raceUnexpected = race.filter(x => ![201,409].includes(x.status));

  const lockCount = Number((await pool.query(
    "SELECT COUNT(*)::int AS c FROM active_order_locks WHERE LOWER(order_number)=LOWER($1)",
    [raceOrder]
  )).rows[0].c || 0);

  if (raceSuccess.length !== 1) failures.push(`race-success:${raceSuccess.length}/1`);
  if (raceBlocked.length !== COURIERS - 1) failures.push(`race-blocked:${raceBlocked.length}/${COURIERS - 1}`);
  if (raceUnexpected.length) failures.push(`race-unexpected-http:${raceUnexpected.map(x=>x.status).join(",")}`);
  if (lockCount !== 1) failures.push(`race-locks:${lockCount}/1`);

  const elapsedMs = performance.now() - started;
  const expected = COURIERS * DEPARTURES;

  if (created !== expected) failures.push(`created:${created}/${expected}`);
  if (duplicateReplays !== COURIERS) failures.push(`idempotent-replays:${duplicateReplays}/${COURIERS}`);
  if (releases !== expected) failures.push(`releases:${releases}/${expected}`);

  report = {
    result: failures.length ? "FAIL" : "PASS",
    environment: {
      appEnv: healthBody.environment,
      stagingSafeMode: healthBody.stagingSafeMode,
      externalMutationsAllowed: healthBody.externalMutationsAllowed,
      operationalDate: shift.operational_date,
      shift: shift.shift_code
    },
    profile: { couriers: COURIERS, departuresPerCourier: DEPARTURES, expectedDepartures: expected },
    flow: { created, duplicateReplays, releases },
    duplicateRace: {
      order: raceOrder,
      attempts: COURIERS,
      successful: raceSuccess.length,
      blocked409: raceBlocked.length,
      unexpected: raceUnexpected.length,
      activeLocks: lockCount
    },
    http: {
      requests: latencies.length,
      statusCounts,
      latencyMs: {
        p50: Number(percentile(0.50).toFixed(1)),
        p95: Number(percentile(0.95).toFixed(1)),
        p99: Number(percentile(0.99).toFixed(1)),
        max: Number(Math.max(...latencies, 0).toFixed(1))
      }
    },
    elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
    failures: failures.slice(0, 30)
  };

  fs.writeFileSync("staging-smoke-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await cleanup().catch(error => console.error("cleanup:", error.message));
  await pool.end();
}
