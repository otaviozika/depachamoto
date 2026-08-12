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
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";

const { Pool } = pg;
const PgSession = connectPg(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VERSION = "1.4.0";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.warn("AVISO: SESSION_SECRET ausente ou curta. Use pelo menos 32 caracteres em produção.");
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
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "troque-esta-chave-em-producao",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." }
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Muitos cadastros a partir deste acesso. Tente novamente mais tarde." }
});

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

ALTER TABLE users
ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

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
  ('alert_critical_minutes','60'),
  ('public_registration_enabled','true')
ON CONFLICT (setting_key) DO NOTHING;
`);

async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const exists = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (!exists.rowCount) {
    await pool.query(
      `INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
       VALUES($1,$2,$3,'admin','APPROVED',true,false)`,
      [
        process.env.ADMIN_NAME || "Administrador",
        username,
        await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 12)
      ]
    );
  } else {
    await pool.query(
      "UPDATE users SET approval_status='APPROVED',active=true WHERE username=$1 AND role='admin'",
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
async function currentUser(userId) {
  const q = await pool.query(
    "SELECT id,name,username,role,active,approval_status,must_change_password,password_hash FROM users WHERE id=$1",
    [userId]
  );
  return q.rows[0] || null;
}
async function audit(userId, action, entity, entityId, details = {}) {
  await pool.query(
    "INSERT INTO audit_logs(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [userId || null, action, entity, entityId || null, JSON.stringify(details)]
  );
}
function requestMeta(req) {
  return {
    ip: req.ip || null,
    user_agent: String(req.get("user-agent") || "").slice(0, 250)
  };
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
async function getSetting(key, fallback) {
  const q = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key=$1", [key]);
  return q.rows[0]?.setting_value ?? fallback;
}
async function setSetting(key, value) {
  await pool.query(`
    INSERT INTO app_settings(setting_key,setting_value,updated_at)
    VALUES($1,$2,NOW())
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
  `, [key, String(value)]);
}
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

app.get("/api/public/config", asyncRoute(async (req, res) => {
  res.json({
    registrationEnabled: (await getSetting("public_registration_enabled", "true")) === "true",
    version: VERSION
  });
}));

app.post("/api/login", loginLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const q = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const user = q.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await audit(null, "LOGIN_FAILED", "security", null, { username, ...requestMeta(req) });
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  if (!user.active) return res.status(403).json({ error: "Este usuário está desativado. Procure o administrador." });
  if (user.role === "courier" && user.approval_status === "PENDING") {
    return res.status(403).json({ error: "Seu cadastro está aguardando aprovação do administrador." });
  }
  if (user.role === "courier" && user.approval_status === "REJECTED") {
    return res.status(403).json({ error: "Seu cadastro não foi aprovado. Procure o administrador." });
  }

  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role
  };

  await audit(user.id, "LOGIN", "user", user.id, requestMeta(req));
  res.json({
    user: {
      ...req.session.user,
      mustChangePassword: !!user.must_change_password
    },
    server_now: new Date().toISOString()
  });
}));

app.post("/api/register", registrationLimiter, asyncRoute(async (req, res) => {
  const registrationEnabled = (await getSetting("public_registration_enabled", "true")) === "true";
  if (!registrationEnabled) {
    return res.status(403).json({ error: "O cadastro público está desativado. Procure o administrador." });
  }

  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 3) return res.status(400).json({ error: "Informe o nome completo." });
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: "Usuário deve ter 3 a 30 caracteres: letras, números, ponto, hífen ou underline." });
  }
  if (password.length < 8) return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });

  try {
    const result = await pool.query(
      `INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
       VALUES($1,$2,$3,'courier','PENDING',true,false)
       RETURNING id,name,username,role,active,approval_status`,
      [name, username, await bcrypt.hash(password, 12)]
    );
    const user = result.rows[0];
    await audit(user.id, "PUBLIC_REGISTRATION_PENDING", "user", user.id, requestMeta(req));
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
  await audit(req.session.user.id, "LOGOUT", "user", req.session.user.id, requestMeta(req));
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get("/api/me", auth, asyncRoute(async (req, res) => {
  const user = await currentUser(req.session.user.id);
  if (!user || !user.active) return res.status(401).json({ error: "Sessão inválida." });

  res.json({
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      mustChangePassword: !!user.must_change_password
    },
    server_now: new Date().toISOString()
  });
}));

app.post("/api/account/password", auth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.current_password || "");
  const newPassword = String(req.body.new_password || "");

  if (newPassword.length < 8) {
    return res.status(400).json({ error: "A nova senha deve ter pelo menos 8 caracteres." });
  }

  const user = await currentUser(req.session.user.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    await audit(req.session.user.id, "PASSWORD_CHANGE_FAILED", "security", req.session.user.id, requestMeta(req));
    return res.status(400).json({ error: "Senha atual incorreta." });
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) {
    return res.status(400).json({ error: "A nova senha deve ser diferente da senha atual." });
  }

  await pool.query(
    "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2",
    [await bcrypt.hash(newPassword, 12), user.id]
  );

  await audit(user.id, "PASSWORD_CHANGED", "user", user.id, requestMeta(req));
  res.json({ ok: true, message: "Senha alterada com sucesso." });
}));

app.get("/api/courier/dashboard", auth, courierOnly, asyncRoute(async (req, res) => {
  const user = await currentUser(req.session.user.id);

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

  res.json({
    active,
    stats,
    recent,
    mustChangePassword: !!user?.must_change_password,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/courier/depart", auth, courierOnly, asyncRoute(async (req, res) => {
  const user = await currentUser(req.session.user.id);
  if (user?.must_change_password) {
    return res.status(403).json({ error: "Altere sua senha temporária antes de registrar uma saída." });
  }

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
      order_numbers: orders,
      order_count: orders.length,
      departed_at: dispatch.departed_at
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


function normalizePeriodQuery(query) {
  const from = validDate(query.from) ? String(query.from) : null;
  const to = validDate(query.to) ? String(query.to) : null;
  if (!from || !to) {
    const err = new Error("Informe as datas inicial e final.");
    err.status = 400;
    throw err;
  }
  if (from > to) {
    const err = new Error("A data inicial não pode ser maior que a data final.");
    err.status = 400;
    throw err;
  }
  return { from, to };
}

function parsePositiveInt(v, fallback, max = 500) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseHistoryFilters(query) {
  const page = parsePositiveInt(query.page, 1, 100000);
  const pageSize = parsePositiveInt(query.page_size, 25, 100);
  const courierId = query.courier_id && /^\d+$/.test(String(query.courier_id))
    ? Number(query.courier_id)
    : null;
  const status = ["ON_ROAD", "RELEASED"].includes(String(query.status || "").toUpperCase())
    ? String(query.status).toUpperCase()
    : null;
  const from = validDate(query.from) ? String(query.from) : null;
  const to = validDate(query.to) ? String(query.to) : null;
  const search = String(query.search || "").trim().slice(0, 100);

  if (from && to && from > to) {
    const err = new Error("A data inicial não pode ser maior que a data final.");
    err.status = 400;
    throw err;
  }
  return { page, pageSize, courierId, status, from, to, search };
}

app.get("/api/admin/history", auth, adminOnly, asyncRoute(async (req, res) => {
  const f = parseHistoryFilters(req.query);
  const params = [];
  const where = [];

  if (f.courierId) {
    params.push(f.courierId);
    where.push(`d.courier_id=$${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`d.status=$${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`(d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`(d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`);
  }
  if (f.search) {
    params.push(`%${f.search}%`);
    const p = params.length;
    where.push(`(
      u.name ILIKE $${p}
      OR u.username ILIKE $${p}
      OR d.dispatch_code ILIKE $${p}
      OR d.order_number ILIKE $${p}
      OR EXISTS (
        SELECT 1 FROM dispatch_orders so
        WHERE so.dispatch_id=d.id AND so.order_number ILIKE $${p}
      )
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countQ = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    ${whereSql}
  `, params);

  const total = countQ.rows[0].total;
  const offset = (f.page - 1) * f.pageSize;
  params.push(f.pageSize);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const rows = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.released_at,d.status,
           u.id AS courier_id,u.name AS courier_name,u.username,
           ${orderArraySql("d")}
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    ${whereSql}
    ORDER BY d.departed_at DESC,d.id DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, params)).rows;

  res.json({
    rows,
    pagination: {
      page: f.page,
      pageSize: f.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / f.pageSize))
    },
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/reports/period", auth, adminOnly, asyncRoute(async (req, res) => {
  const { from, to } = normalizePeriodQuery(req.query);

  const metrics = (await pool.query(`
    WITH dispatch_counts AS (
      SELECT d.id,d.courier_id,d.departed_at,COUNT(o.id)::int AS order_count
      FROM dispatches d
      JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
            BETWEEN $1::date AND $2::date
      GROUP BY d.id,d.courier_id,d.departed_at
    )
    SELECT
      COUNT(*)::int AS dispatches,
      COALESCE(SUM(order_count),0)::int AS orders,
      COUNT(DISTINCT courier_id)::int AS couriers,
      ROUND(COALESCE(AVG(order_count),0)::numeric,2) AS avg_orders_per_dispatch,
      COALESCE(MAX(order_count),0)::int AS max_orders_per_dispatch
    FROM dispatch_counts
  `, [from, to])).rows[0];

  const byCourier = (await pool.query(`
    SELECT
      u.id,u.name,u.username,
      COUNT(DISTINCT d.id)::int AS dispatches,
      COUNT(o.id)::int AS orders,
      ROUND((COUNT(o.id)::numeric / NULLIF(COUNT(DISTINCT d.id),0)),2) AS avg_orders_per_dispatch,
      MIN(d.departed_at) AS first_departure,
      MAX(d.departed_at) AS last_departure
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
          BETWEEN $1::date AND $2::date
    GROUP BY u.id,u.name,u.username
    ORDER BY orders DESC,dispatches DESC,u.name
  `, [from, to])).rows;

  const byDay = (await pool.query(`
    SELECT
      to_char((d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date,'YYYY-MM-DD') AS day,
      COUNT(DISTINCT d.id)::int AS dispatches,
      COUNT(o.id)::int AS orders
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
          BETWEEN $1::date AND $2::date
    GROUP BY 1
    ORDER BY 1
  `, [from, to])).rows;

  const byHour = (await pool.query(`
    SELECT
      EXTRACT(HOUR FROM (d.departed_at AT TIME ZONE 'America/Sao_Paulo'))::int AS hour,
      COUNT(DISTINCT d.id)::int AS dispatches,
      COUNT(o.id)::int AS orders
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
          BETWEEN $1::date AND $2::date
    GROUP BY 1
    ORDER BY 1
  `, [from, to])).rows;

  const busiestHour = byHour.reduce(
    (best, row) => !best || row.orders > best.orders ? row : best,
    null
  );

  res.json({
    from,
    to,
    metrics: {
      orders: metrics.orders,
      dispatches: metrics.dispatches,
      couriers: metrics.couriers,
      avgOrdersPerDispatch: Number(metrics.avg_orders_per_dispatch || 0),
      maxOrdersPerDispatch: metrics.max_orders_per_dispatch,
      busiestHour: busiestHour ? busiestHour.hour : null,
      busiestHourOrders: busiestHour ? busiestHour.orders : 0
    },
    byCourier,
    byDay,
    byHour,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/reports/comparison", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    WITH base AS (
      SELECT
        (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
        date_trunc('month', d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date AS month_start,
        o.id AS order_id,
        d.id AS dispatch_id
      FROM dispatches d
      JOIN dispatch_orders o ON o.dispatch_id=d.id
    )
    SELECT
      COUNT(order_id) FILTER (
        WHERE day=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_orders,
      COUNT(order_id) FILTER (
        WHERE day=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date-1
      )::int AS yesterday_orders,
      COUNT(DISTINCT dispatch_id) FILTER (
        WHERE day=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_dispatches,
      COUNT(DISTINCT dispatch_id) FILTER (
        WHERE day=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date-1
      )::int AS yesterday_dispatches,
      COUNT(order_id) FILTER (
        WHERE month_start=date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS current_month_orders,
      COUNT(order_id) FILTER (
        WHERE month_start=(date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')-INTERVAL '1 month')::date
      )::int AS previous_month_orders,
      COUNT(DISTINCT dispatch_id) FILTER (
        WHERE month_start=date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS current_month_dispatches,
      COUNT(DISTINCT dispatch_id) FILTER (
        WHERE month_start=(date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')-INTERVAL '1 month')::date
      )::int AS previous_month_dispatches
    FROM base
  `);

  const r = q.rows[0];
  const pct = (current, previous) => {
    if (!previous) return current ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(1));
  };

  res.json({
    todayVsYesterday: {
      orders: {
        current: r.today_orders,
        previous: r.yesterday_orders,
        changePct: pct(r.today_orders, r.yesterday_orders)
      },
      dispatches: {
        current: r.today_dispatches,
        previous: r.yesterday_dispatches,
        changePct: pct(r.today_dispatches, r.yesterday_dispatches)
      }
    },
    monthVsPrevious: {
      orders: {
        current: r.current_month_orders,
        previous: r.previous_month_orders,
        changePct: pct(r.current_month_orders, r.previous_month_orders)
      },
      dispatches: {
        current: r.current_month_dispatches,
        previous: r.previous_month_dispatches,
        changePct: pct(r.current_month_dispatches, r.previous_month_dispatches)
      }
    },
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/reports/period.csv", auth, adminOnly, asyncRoute(async (req, res) => {
  const { from, to } = normalizePeriodQuery(req.query);

  const rows = (await pool.query(`
    SELECT
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS date_br,
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS time_br,
      u.name AS courier_name,
      u.username,
      o.order_number,
      d.dispatch_code,
      CASE d.status WHEN 'ON_ROAD' THEN 'NA RUA' ELSE 'LIBERADO' END AS status,
      CASE WHEN d.released_at IS NULL THEN '' ELSE
        to_char(d.released_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS released_br
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
          BETWEEN $1::date AND $2::date
    ORDER BY d.departed_at,o.id
  `, [from, to])).rows;

  const header = [
    "Data","Horário da saída","Motoboy","Usuário","Pedido",
    "Código da saída","Status","Liberado em"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      r.date_br,r.time_br,r.courier_name,r.username,r.order_number,
      r.dispatch_code,r.status,r.released_br
    ].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="despachamoto-${from}-a-${to}.csv"`
  );
  res.send("\uFEFF" + lines.join("\r\n"));

  await audit(req.session.user.id, "PERIOD_REPORT_EXPORTED", "report", null, {
    from,
    to,
    rows: rows.length
  });
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
    SELECT u.id,u.name,u.username,u.active,u.approval_status,u.must_change_password,
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

  res.json({
    metrics: {
      activeCouriers: metrics.active_couriers,
      pendingCouriers: metrics.pending_couriers,
      onRoad: metrics.on_road,
      available: Math.max(0, metrics.active_couriers - metrics.on_road),
      todayOrders: metrics.today_orders,
      activeOrders: metrics.active_orders
    },
    active,
    recent,
    couriers,
    alerts: await getAlertSettings(),
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/couriers", auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 3 || username.length < 3 || password.length < 8) {
    return res.status(400).json({ error: "Preencha nome, usuário e senha de pelo menos 8 caracteres." });
  }

  try {
    const q = await pool.query(`
      INSERT INTO users(name,username,password_hash,role,approval_status,active,must_change_password)
      VALUES($1,$2,$3,'courier','APPROVED',true,false)
      RETURNING id,name,username,active,approval_status,must_change_password
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
    RETURNING id,name,username,active,approval_status,must_change_password
  `, [active, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, active ? "COURIER_ACTIVATED" : "COURIER_DEACTIVATED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/approve", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE users SET approval_status='APPROVED',active=true
    WHERE id=$1 AND role='courier'
    RETURNING id,name,username,active,approval_status,must_change_password
  `, [req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "COURIER_APPROVED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/reject", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE users SET approval_status='REJECTED',active=false
    WHERE id=$1 AND role='courier'
    RETURNING id,name,username,active,approval_status,must_change_password
  `, [req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "COURIER_REJECTED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/reset-password", auth, adminOnly, asyncRoute(async (req, res) => {
  const newPassword = String(req.body.new_password || "");
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "A senha temporária deve ter pelo menos 8 caracteres." });
  }

  const q = await pool.query(`
    UPDATE users
    SET password_hash=$1,must_change_password=true
    WHERE id=$2 AND role='courier'
    RETURNING id,name,username,must_change_password
  `, [await bcrypt.hash(newPassword, 12), req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "PASSWORD_RESET_BY_ADMIN", "user", q.rows[0].id, {
    target_username: q.rows[0].username,
    ...requestMeta(req)
  });

  res.json({
    user: q.rows[0],
    message: "Senha redefinida. O motoboy deverá alterá-la no próximo acesso."
  });
}));

app.post("/api/admin/dispatches/:id/release", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE dispatches SET status='RELEASED',released_at=NOW(),released_by=$1
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

app.get("/api/admin/security", auth, adminOnly, asyncRoute(async (req, res) => {
  const adminUser = await currentUser(req.session.user.id);
  const defaultAdminPassword = adminUser?.role === "admin"
    ? await bcrypt.compare("admin123", adminUser.password_hash)
    : false;

  res.json({
    registrationEnabled: (await getSetting("public_registration_enabled", "true")) === "true",
    adminPasswordLooksDefault: defaultAdminPassword,
    version: VERSION
  });
}));

app.put("/api/admin/security/registration", auth, adminOnly, asyncRoute(async (req, res) => {
  const enabled = !!req.body.enabled;
  await setSetting("public_registration_enabled", enabled ? "true" : "false");
  await audit(req.session.user.id, "PUBLIC_REGISTRATION_SETTING_CHANGED", "settings", null, { enabled });
  io.emit("security:changed");
  res.json({ registrationEnabled: enabled });
}));

app.get("/api/admin/system-health", auth, adminOnly, asyncRoute(async (req, res) => {
  const started = Date.now();
  const dbResult = await pool.query("SELECT NOW() AS db_now");
  const dbLatencyMs = Date.now() - started;

  let sessionCount = null;
  try {
    const s = await pool.query("SELECT COUNT(*)::int AS c FROM user_sessions");
    sessionCount = s.rows[0].c;
  } catch {}

  res.json({
    version: VERSION,
    server: "online",
    database: "connected",
    dbLatencyMs,
    databaseTime: dbResult.rows[0].db_now,
    serverTime: new Date().toISOString(),
    activeSessions: sessionCount,
    nodeEnv: process.env.NODE_ENV || "development"
  });
}));

app.get("/api/admin/backup/dispatches.csv", auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = (await pool.query(`
    SELECT
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS date_br,
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS time_br,
      u.name AS courier_name,
      u.username,
      o.order_number,
      d.dispatch_code,
      CASE d.status WHEN 'ON_ROAD' THEN 'NA RUA' ELSE 'LIBERADO' END AS status,
      CASE WHEN d.released_at IS NULL THEN '' ELSE
        to_char(d.released_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS released_br
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    ORDER BY d.departed_at,o.id
  `)).rows;

  const header = [
    "Data","Horário da saída","Motoboy","Usuário","Pedido",
    "Código da saída","Status","Liberado em"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      r.date_br,r.time_br,r.courier_name,r.username,r.order_number,
      r.dispatch_code,r.status,r.released_br
    ].map(csvCell).join(";"));
  }

  const stamp = new Date().toISOString().slice(0,10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachamoto-backup-${stamp}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));

  await audit(req.session.user.id, "FULL_HISTORY_EXPORTED", "backup", null, {
    rows: rows.length,
    ...requestMeta(req)
  });
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
    return res.status(400).json({ error: "Use minutos inteiros e mantenha Atenção < Demorado < Crítico." });
  }

  for (const [key, value] of [
    ["alert_attention_minutes", attention],
    ["alert_delayed_minutes", delayed],
    ["alert_critical_minutes", critical]
  ]) {
    await setSetting(key, value);
  }

  await audit(req.session.user.id, "ALERT_SETTINGS_UPDATED", "settings", null, {
    attention, delayed, critical
  });

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
    lines.push([
      r.date_br,r.time_br,r.courier_name,r.order_number,r.dispatch_code,r.status
    ].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachamoto-${date}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));
}));

app.get("/api/admin/audit", auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = (await pool.query(`
    SELECT a.id,a.action,a.entity,a.entity_id,a.details,a.created_at,u.name AS user_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 300
  `)).rows;

  res.json({ rows, server_now: new Date().toISOString() });
}));

app.get("/api/health", (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  version: VERSION
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
server.listen(port, () => console.log(`DespachaMoto ${VERSION} rodando na porta ${port}`));
