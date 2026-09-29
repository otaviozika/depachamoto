import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;
const TARGET = String(process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.LOADTEST_ADMIN_USERNAME || process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
const SHIFT = String(process.env.STAGING_FORCE_SHIFT || "DINNER").toUpperCase();
const RUN = `e2e_${Date.now().toString(36)}`;
const COURIER_PASSWORD = "E2E-Courier-987654";

if (!DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) {
  throw new Error("E2E staging sem DATABASE_URL ou credenciais administrativas.");
}
if (!["LUNCH","DINNER"].includes(SHIFT)) throw new Error("STAGING_FORCE_SHIFT inválido.");

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false, max: 8 });
const courierIds = [];

function spDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function request(path, { cookie = "", ...options } = {}) {
  const res = await fetch(TARGET + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

async function login(username,password) {
  const r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username,password })
  });
  if (!r.res.ok) throw new Error(`login ${username}: HTTP ${r.res.status} ${JSON.stringify(r.body)}`);
  const cookie = String(r.res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("Login sem cookie.");
  return cookie;
}

function assert(condition,message) {
  if (!condition) throw new Error(message);
}

async function seed() {
  const hash = await bcrypt.hash(COURIER_PASSWORD, 10);
  const date = spDate();
  const admin = (await pool.query(
    "SELECT id FROM users WHERE username=$1 AND role='admin'",
    [String(ADMIN_USERNAME).toLowerCase()]
  )).rows[0];
  if (!admin) throw new Error("Admin de staging não encontrado.");

  for (let i=1;i<=4;i++) {
    const user = (await pool.query(`
      INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
      VALUES($1,$2,$3,'courier','APPROVED',true,false)
      RETURNING id
    `, [`E2E Courier ${i}`, `${RUN}_c${i}`, hash])).rows[0];
    const id=Number(user.id);
    courierIds.push(id);
    await pool.query(`
      INSERT INTO courier_attendance(
        courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason
      )
      VALUES($1,$2::date,$3,NOW(),'ADMIN_MANUAL',$4,'Homologação automática')
    `, [id,date,SHIFT,admin.id]);
  }
}

async function cleanup() {
  if (!courierIds.length) return;
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM operational_conflicts WHERE courier_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM notifications WHERE courier_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM active_order_locks WHERE courier_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM dispatches WHERE courier_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM courier_attendance WHERE courier_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM user_presence WHERE user_id=ANY($1::int[])", [courierIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [courierIds]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

await seed();
try {
  const adminCookie = await login(ADMIN_USERNAME,ADMIN_PASSWORD);
  const courierCookie = await login(`${RUN}_c1`,COURIER_PASSWORD);

  const health = await request("/api/health");
  assert(health.res.ok, `health HTTP ${health.res.status}`);
  assert(health.body?.environment === "staging", "APP_ENV não é staging");
  assert(health.body?.stagingSafeMode === true, "STAGING_SAFE_MODE não está ativo");
  assert(health.body?.externalMutationsAllowed === false, "mutações externas não estão bloqueadas");

  const courierDashboard = await request("/api/courier/dashboard", { cookie: courierCookie });
  assert(courierDashboard.res.ok, `dashboard do motoboy falhou: HTTP ${courierDashboard.res.status}`);

  const firstPayload = {
    courier_id: courierIds[0],
    order_numbers: [`#${RUN.toUpperCase()}-A1`, `#${RUN.toUpperCase()}-A2`],
    reason: "Teste E2E de homologação",
    client_token: `${RUN}-idem-1`,
    confirm_recent_orders: true
  };

  const first = await request("/api/admin/dispatches/manual", {
    cookie: adminCookie, method: "POST", body: JSON.stringify(firstPayload)
  });
  assert(first.res.status === 201, `saída manual esperava 201, recebeu ${first.res.status}: ${JSON.stringify(first.body)}`);
  assert(first.body?.dispatch?.id, "saída manual sem dispatch id");

  const replay = await request("/api/admin/dispatches/manual", {
    cookie: adminCookie, method: "POST", body: JSON.stringify(firstPayload)
  });
  assert(replay.res.status === 200 && replay.body?.duplicate === true,
    `idempotência falhou: ${replay.res.status} ${JSON.stringify(replay.body)}`);

  const persistedShift = (await pool.query(
    "SELECT operational_date,shift_code FROM dispatches WHERE id=$1",
    [first.body.dispatch.id]
  )).rows[0];
  assert(persistedShift?.shift_code === SHIFT, `turno persistido incorreto: ${persistedShift?.shift_code}`);
  assert(String(persistedShift?.operational_date || "").startsWith(spDate()),
    `data operacional incorreta: ${persistedShift?.operational_date}`);

  const release = await request(`/api/admin/dispatches/${first.body.dispatch.id}/release`, {
    cookie: adminCookie, method: "POST", body: JSON.stringify({ reason: "Liberação E2E" })
  });
  assert(release.res.ok, `liberação falhou: ${release.res.status} ${JSON.stringify(release.body)}`);

  const raceOrder = `#${RUN.toUpperCase()}-RACE`;
  const race = await Promise.all([courierIds[1],courierIds[2],courierIds[3]].map((courierId,index)=>
    request("/api/admin/dispatches/manual", {
      cookie: adminCookie,
      method: "POST",
      body: JSON.stringify({
        courier_id: courierId,
        order_numbers: [raceOrder],
        reason: "Corrida de duplicidade E2E",
        client_token: `${RUN}-race-${index+1}`,
        confirm_recent_orders: true
      })
    })
  ));

  const raceSuccess=race.filter(x=>x.res.status===201).length;
  const raceBlocked=race.filter(x=>x.res.status===409).length;
  const raceUnexpected=race.length-raceSuccess-raceBlocked;
  assert(raceSuccess===1, `corrida deveria criar 1 saída; criou ${raceSuccess}`);
  assert(raceBlocked===2, `corrida deveria bloquear 2 saídas; bloqueou ${raceBlocked}; HTTPs=${race.map(x=>x.res.status).join(",")}`);
  assert(raceUnexpected===0, `corrida retornou HTTP inesperado: ${race.map(x=>x.res.status).join(",")}`);

  const lockCount=Number((await pool.query(
    "SELECT COUNT(*)::int AS c FROM active_order_locks WHERE order_number=$1",
    [raceOrder]
  )).rows[0].c);
  assert(lockCount===1, `esperava 1 lock da corrida; encontrou ${lockCount}`);

  const dispatchRows=Number((await pool.query(
    "SELECT COUNT(*)::int AS c FROM dispatches WHERE courier_id=ANY($1::int[])",
    [courierIds]
  )).rows[0].c);
  assert(dispatchRows===2, `esperava 2 saídas persistidas; encontrou ${dispatchRows}`);

  console.log(JSON.stringify({
    result:"PASS",
    environment:health.body.environment,
    stagingSafeMode:health.body.stagingSafeMode,
    externalMutationsAllowed:health.body.externalMutationsAllowed,
    courierSession:true,
    adminManualDeparture:true,
    frozenShift:{date:spDate(),shift:SHIFT},
    idempotentReplay:true,
    duplicateRace:{attempts:3,created:raceSuccess,blocked:raceBlocked,unexpected:raceUnexpected,locks:lockCount},
    persistedDispatches:dispatchRows
  },null,2));
} finally {
  await cleanup();
  await pool.end();
}
