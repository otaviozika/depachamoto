import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import pg from "pg";
import helmet from "helmet";
import { Server } from "socket.io";

const { Pool } = pg;
const PgSession = connectPg(session);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "troque-esta-chave",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

// Estrutura base + migrações compatíveis com v1.0/v1.1.
await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','courier')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'APPROVED';

CREATE TABLE IF NOT EXISTS dispatches (
  id BIGSERIAL PRIMARY KEY,
  dispatch_code TEXT UNIQUE NOT NULL,
  order_number TEXT NOT NULL,
  courier_id INTEGER NOT NULL REFERENCES users(id),
  departed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  released_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ON_ROAD' CHECK (status IN ('ON_ROAD','RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dispatches_courier_idx ON dispatches(courier_id);
CREATE INDEX IF NOT EXISTS dispatches_departed_idx ON dispatches(departed_at);
CREATE INDEX IF NOT EXISTS dispatches_status_idx ON dispatches(status);

CREATE TABLE IF NOT EXISTS dispatch_orders (
  id BIGSERIAL PRIMARY KEY,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dispatch_id, order_number)
);

CREATE INDEX IF NOT EXISTS dispatch_orders_dispatch_idx ON dispatch_orders(dispatch_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id BIGINT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`);

await pool.query(`
INSERT INTO dispatch_orders(dispatch_id, order_number)
SELECT d.id, d.order_number
FROM dispatches d
WHERE NOT EXISTS (SELECT 1 FROM dispatch_orders o WHERE o.dispatch_id=d.id)
ON CONFLICT DO NOTHING;

INSERT INTO app_settings(setting_key,setting_value) VALUES
  ('alert_attention_minutes','40'),
  ('alert_delayed_minutes','50'),
  ('alert_critical_minutes','60')
ON CONFLICT (setting_key) DO NOTHING;
`);

async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const exists = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (!exists.rowCount) {
    await pool.query(
      `INSERT INTO users(name,username,password_hash,role,approval_status,active)
       VALUES($1,$2,$3,'admin','APPROVED',true)`,
      [process.env.ADMIN_NAME || "Administrador", username, await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 12)]
    );
  } else {
    await pool.query(
      "UPDATE users SET approval_status='APPROVED', active=true WHERE username=$1 AND role='admin'",
      [username]
    );
  }
}
await seedAdmin();

app.use(express.static(path.join(__dirname, "public")));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Não autenticado." });
  next();
}
function adminOnly(req, res, next) {
  if (req.session.user?.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
  next();
}
function courierOnly(req, res, next) {
  if (req.session.user?.role !== "courier") return res.status(403).json({ error: "Acesso restrito ao motoboy." });
  next();
}
async function audit(userId, action, entity, entityId, details = {}) {
  await pool.query(
    "INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [userId || null, action, entity, entityId || null, JSON.stringify(details)]
  );
}
function normalizeOrders(body) {
  const raw = Array.isArray(body.order_numbers)
    ? body.order_numbers
    : body.order_number != null ? [body.order_number] : [];

  const orders = [];
  const seen = new Set();

  for (const item of raw) {
    let order = String(item ?? "").trim();
    if (!order) continue;
    if (order.length > 50) throw Object.assign(new Error("Número de pedido muito longo."), { status: 400 });
    if (!order.startsWith("#")) order = "#" + order;
    const key = order.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  }

  if (!orders.length) throw Object.assign(new Error("Informe pelo menos um número de pedido."), { status: 400 });
  if (orders.length > 5) throw Object.assign(new Error("É permitido registrar no máximo 5 pedidos por saída."), { status: 400 });
  return orders;
}
const orderArraySql = alias => `
COALESCE(
  (SELECT json_agg(o.order_number ORDER BY o.id) FROM dispatch_orders o WHERE o.dispatch_id=${alias}.id),
  json_build_array(${alias}.order_number)
) AS order_numbers
`;
async function getAlertSettings() {
  const q = await pool.query(`
    SELECT setting_key,setting_value FROM app_settings
    WHERE setting_key IN ('alert_attention_minutes','alert_delayed_minutes','alert_critical_minutes')
  `);
  const obj = Object.fromEntries(q.rows.map(r => [r.setting_key, Number(r.setting_value)]));
  return {
    attention: obj.alert_attention_minutes || 40,
    delayed: obj.alert_delayed_minutes || 50,
    critical: obj.alert_critical_minutes || 60
  };
}
async function getSPDate() {
  const q = await pool.query("SELECT to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS d");
  return q.rows[0].d;
}
function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}
function csvCell(v) {
  const s = String(v ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

app.post("/api/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const q = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const user = q.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  if (!user.active) return res.status(403).json({ error: "Este usuário está desativado. Procure o administrador." });
  if (user.role === "courier" && user.approval_status === "PENDING") {
    return res.status(403).json({ error: "Seu cadastro está aguardando aprovação do administrador." });
  }
  if (user.role === "courier" && user.approval_status === "REJECTED") {
    return res.status(403).json({ error: "Seu cadastro não foi aprovado. Procure o administrador." });
  }

  req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
  await audit(user.id, "LOGIN", "user", user.id, {});
  res.json({ user: req.session.user, server_now: new Date().toISOString() });
}));

app.post("/api/register", asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 3) return res.status(400).json({ error: "Informe o nome completo." });
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: "Usuário deve ter 3 a 30 caracteres: letras, números, ponto, hífen ou underline." });
  }
  if (password.length < 6) return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });

  try {
    const result = await pool.query(
      `INSERT INTO users(name,username,password_hash,role,approval_status,active)
       VALUES($1,$2,$3,'courier','PENDING',true)
       RETURNING id,name,username,role,active,approval_status`,
      [name, username, await bcrypt.hash(password, 12)]
    );
    const user = result.rows[0];
    await audit(user.id, "PUBLIC_REGISTRATION_PENDING", "user", user.id, {});
    io.emit("courier:changed");
    res.status(201).json({
      user,
      message: "Cadastro recebido. Aguarde a aprovação do administrador."
    });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Esse usuário já existe." });
    throw e;
  }
}));

app.post("/api/logout", auth, asyncRoute(async (req, res) => {
  await audit(req.session.user.id, "LOGOUT", "user", req.session.user.id, {});
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get("/api/me", auth, (req, res) => res.json({ user: req.session.user, server_now: new Date().toISOString() }));

app.get("/api/courier/dashboard", auth, courierOnly, asyncRoute(async (req, res) => {
  const active = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1 AND d.status='ON_ROAD'
    ORDER BY d.id DESC LIMIT 1
  `, [req.session.user.id])).rows[0] || null;

  const stats = (await pool.query(`
    SELECT
      COUNT(o.id) FILTER (
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today,
      COUNT(o.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '6 days')::int AS week,
      COUNT(o.id) FILTER (
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo') >=
              date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
      )::int AS month
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE d.courier_id=$1
  `, [req.session.user.id])).rows[0];

  const recent = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,d.released_at,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1
    ORDER BY d.id DESC LIMIT 30
  `, [req.session.user.id])).rows;

  res.json({ active, stats, recent, server_now: new Date().toISOString() });
}));

app.post("/api/courier/depart", auth, courierOnly, asyncRoute(async (req, res) => {
  const orders = normalizeOrders(req.body);

  const existing = await pool.query(`
    SELECT d.id,d.order_number,${orderArraySql("d")}
    FROM dispatches d WHERE d.courier_id=$1 AND d.status='ON_ROAD' LIMIT 1
  `, [req.session.user.id]);

  if (existing.rowCount) {
    const current = existing.rows[0].order_numbers || [existing.rows[0].order_number];
    return res.status(409).json({
      error: `Você já está na rua com ${current.length} pedido(s): ${current.join(", ")}. O administrador precisa liberar seu status antes de uma nova saída.`
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = "DSP-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const result = await client.query(`
      INSERT INTO dispatches(dispatch_code,order_number,courier_id)
      VALUES($1,$2,$3)
      RETURNING id,dispatch_code,order_number,departed_at,status
    `, [code, orders[0], req.session.user.id]);

    const dispatch = result.rows[0];
    for (const order of orders) {
      await client.query("INSERT INTO dispatch_orders(dispatch_id,order_number) VALUES($1,$2)", [dispatch.id, order]);
    }
    await client.query("COMMIT");

    dispatch.order_numbers = orders;
    await audit(req.session.user.id, "DEPARTURE_REGISTERED", "dispatch", dispatch.id, {
      order_numbers: orders, order_count: orders.length, departed_at: dispatch.departed_at
    });

    io.emit("dispatch:changed");
    res.status(201).json({ dispatch, server_now: new Date().toISOString() });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}));

app.get("/api/admin/dashboard", auth, adminOnly, asyncRoute(async (req, res) => {
  const metrics = (await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='courier' AND active=true AND approval_status='APPROVED')::int AS active_couriers,
      (SELECT COUNT(*) FROM users WHERE role='courier' AND approval_status='PENDING')::int AS pending_couriers,
      (SELECT COUNT(*) FROM dispatches WHERE status='ON_ROAD')::int AS on_road,
      (
        SELECT COUNT(o.id) FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_orders,
      (
        SELECT COUNT(o.id) FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id
        WHERE d.status='ON_ROAD'
      )::int AS active_orders
  `)).rows[0];

  const active = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,
           u.id AS courier_id,u.name AS courier_name,u.username,${orderArraySql("d")}
    FROM dispatches d JOIN users u ON u.id=d.courier_id
    WHERE d.status='ON_ROAD'
    ORDER BY d.departed_at ASC
  `)).rows;

  const recent = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.released_at,d.status,
           u.name AS courier_name,${orderArraySql("d")}
    FROM dispatches d JOIN users u ON u.id=d.courier_id
    ORDER BY d.id DESC LIMIT 150
  `)).rows;

  const couriers = (await pool.query(`
    SELECT u.id,u.name,u.username,u.active,u.approval_status,
      (
        SELECT COUNT(o.id)
        FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
        WHERE d.courier_id=u.id
        AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
            (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_count,
      EXISTS(SELECT 1 FROM dispatches d2 WHERE d2.courier_id=u.id AND d2.status='ON_ROAD') AS on_road
    FROM users u WHERE u.role='courier'
    ORDER BY
      CASE u.approval_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 2 ELSE 1 END,
      u.name
  `)).rows;

  const alerts = await getAlertSettings();

  res.json({
    metrics: {
      activeCouriers: metrics.active_couriers,
      pendingCouriers: metrics.pending_couriers,
      onRoad: metrics.on_road,
      available: Math.max(0, metrics.active_couriers - metrics.on_road),
      todayOrders: metrics.today_orders,
      activeOrders: metrics.active_orders
    },
    active, recent, couriers, alerts,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/couriers", auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 3 || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: "Preencha nome, usuário e senha de pelo menos 6 caracteres." });
  }

  try {
    const q = await pool.query(`
      INSERT INTO users(name,username,password_hash,role,approval_status,active)
      VALUES($1,$2,$3,'courier','APPROVED',true)
      RETURNING id,name,username,active,approval_status
    `, [name, username, await bcrypt.hash(password, 12)]);

    await audit(req.session.user.id, "COURIER_CREATED_APPROVED", "user", q.rows[0].id, { username });
    io.emit("courier:changed");
    res.status(201).json({ user: q.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Esse usuário já existe." });
    throw e;
  }
}));

app.patch("/api/admin/couriers/:id", auth, adminOnly, asyncRoute(async (req, res) => {
  const active = !!req.body.active;
  const q = await pool.query(`
    UPDATE users SET active=$1
    WHERE id=$2 AND role='courier'
    RETURNING id,name,username,active,approval_status
  `, [active, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, active ? "COURIER_ACTIVATED" : "COURIER_DEACTIVATED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/approve", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE users SET approval_status='APPROVED', active=true
    WHERE id=$1 AND role='courier'
    RETURNING id,name,username,active,approval_status
  `, [req.params.id]);
  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "COURIER_APPROVED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/reject", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE users SET approval_status='REJECTED', active=false
    WHERE id=$1 AND role='courier'
    RETURNING id,name,username,active,approval_status
  `, [req.params.id]);
  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "COURIER_REJECTED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/dispatches/:id/release", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE dispatches SET status='RELEASED', released_at=NOW(), released_by=$1
    WHERE id=$2 AND status='ON_ROAD'
    RETURNING *
  `, [req.session.user.id, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Saída ativa não encontrada." });

  await audit(req.session.user.id, "COURIER_RELEASED", "dispatch", q.rows[0].id, {
    order_number: q.rows[0].order_number
  });

  io.emit("dispatch:changed");
  res.json({ dispatch: q.rows[0], server_now: new Date().toISOString() });
}));

app.get("/api/admin/settings/alerts", auth, adminOnly, asyncRoute(async (req, res) => {
  res.json({ alerts: await getAlertSettings() });
}));

app.put("/api/admin/settings/alerts", auth, adminOnly, asyncRoute(async (req, res) => {
  const attention = Number(req.body.attention);
  const delayed = Number(req.body.delayed);
  const critical = Number(req.body.critical);

  if (![attention, delayed, critical].every(Number.isInteger) ||
      attention < 1 || critical > 720 || !(attention < delayed && delayed < critical)) {
    return res.status(400).json({
      error: "Use minutos inteiros e mantenha Atenção < Demorado < Crítico."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of [
      ["alert_attention_minutes", attention],
      ["alert_delayed_minutes", delayed],
      ["alert_critical_minutes", critical]
    ]) {
      await client.query(`
        INSERT INTO app_settings(setting_key,setting_value,updated_at)
        VALUES($1,$2,NOW())
        ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
      `, [key, String(value)]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await audit(req.session.user.id, "ALERT_SETTINGS_UPDATED", "settings", null, { attention, delayed, critical });
  io.emit("settings:changed");
  res.json({ alerts: { attention, delayed, critical } });
}));

app.get("/api/admin/reports/daily", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : await getSPDate();

  const metrics = (await pool.query(`
    WITH counts AS (
      SELECT d.id,d.courier_id,d.departed_at,COUNT(o.id)::int AS order_count
      FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
      GROUP BY d.id,d.courier_id,d.departed_at
    )
    SELECT
      COUNT(*)::int AS dispatches,
      COALESCE(SUM(order_count),0)::int AS orders,
      COUNT(DISTINCT courier_id)::int AS couriers,
      COALESCE(MAX(order_count),0)::int AS max_orders_per_dispatch
    FROM counts
  `, [date])).rows[0];

  const byCourier = (await pool.query(`
    SELECT
      u.id,u.name,
      COUNT(DISTINCT d.id)::int AS dispatches,
      COUNT(o.id)::int AS orders,
      MIN(d.departed_at) AS first_departure,
      MAX(d.departed_at) AS last_departure
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
    GROUP BY u.id,u.name
    ORDER BY orders DESC,u.name
  `, [date])).rows;

  res.json({ date, metrics, byCourier, server_now: new Date().toISOString() });
}));

app.get("/api/admin/reports/daily.csv", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : await getSPDate();
  const rows = (await pool.query(`
    SELECT
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS date_br,
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS time_br,
      u.name AS courier_name,
      o.order_number,
      d.dispatch_code,
      CASE d.status WHEN 'ON_ROAD' THEN 'NA RUA' ELSE 'LIBERADO' END AS status
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
    ORDER BY d.departed_at,o.id
  `, [date])).rows;

  const header = ["Data","Horário da saída","Motoboy","Pedido","Código da saída","Status"];
  const lines = [header.map(csvCell).join(";")];
  for (const r of rows) {
    lines.push([r.date_br,r.time_br,r.courier_name,r.order_number,r.dispatch_code,r.status].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachamoto-${date}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));
}));

app.get("/api/admin/audit", auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = (await pool.query(`
    SELECT a.id,a.action,a.entity,a.entity_id,a.details,a.created_at,u.name AS user_name
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 300
  `)).rows;
  res.json({ rows, server_now: new Date().toISOString() });
}));

app.get("/api/health", (req, res) => res.json({
  ok: true, time: new Date().toISOString(), version: "1.2.0"
}));

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", socket => {
  socket.emit("server:time", { now: new Date().toISOString() });
});

setInterval(() => io.emit("server:time", { now: new Date().toISOString() }), 1000);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Erro interno do servidor." });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`DespachaMoto 1.2 rodando na porta ${port}`));
