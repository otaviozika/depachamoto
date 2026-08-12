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

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id BIGINT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`);

async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const exists = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (!exists.rowCount) {
    await pool.query(
      "INSERT INTO users(name,username,password_hash,role) VALUES($1,$2,$3,'admin')",
      [
        process.env.ADMIN_NAME || "Administrador",
        username,
        await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 12)
      ]
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

app.post("/api/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const q = await pool.query("SELECT * FROM users WHERE username=$1 AND active=true", [username]);
  const user = q.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role
  };

  await audit(user.id, "LOGIN", "user", user.id, {});
  res.json({ user: req.session.user });
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
      "INSERT INTO users(name,username,password_hash,role) VALUES($1,$2,$3,'courier') RETURNING id,name,username,role,active",
      [name, username, await bcrypt.hash(password, 12)]
    );
    const user = result.rows[0];
    await audit(user.id, "PUBLIC_REGISTRATION", "user", user.id, {});
    io.emit("courier:changed");
    res.status(201).json({ user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Esse usuário já existe." });
    throw e;
  }
}));

app.post("/api/logout", auth, asyncRoute(async (req, res) => {
  await audit(req.session.user.id, "LOGOUT", "user", req.session.user.id, {});
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get("/api/me", auth, (req, res) => res.json({ user: req.session.user }));

app.get("/api/courier/dashboard", auth, courierOnly, asyncRoute(async (req, res) => {
  const active = (await pool.query(`
    SELECT id,dispatch_code,order_number,departed_at,status
    FROM dispatches
    WHERE courier_id=$1 AND status='ON_ROAD'
    ORDER BY id DESC LIMIT 1
  `, [req.session.user.id])).rows[0] || null;

  const stats = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE departed_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS today,
      COUNT(*) FILTER (WHERE departed_at >= NOW()-INTERVAL '6 days') AS week,
      COUNT(*) FILTER (
        WHERE (departed_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
      ) AS month
    FROM dispatches WHERE courier_id=$1
  `, [req.session.user.id])).rows[0];

  const recent = (await pool.query(`
    SELECT id,dispatch_code,order_number,departed_at,status,released_at
    FROM dispatches
    WHERE courier_id=$1
    ORDER BY id DESC LIMIT 30
  `, [req.session.user.id])).rows;

  res.json({ active, stats, recent });
}));

app.post("/api/courier/depart", auth, courierOnly, asyncRoute(async (req, res) => {
  let order = String(req.body.order_number || "").trim();
  if (!order) return res.status(400).json({ error: "Informe o número do pedido." });
  if (order.length > 50) return res.status(400).json({ error: "Número de pedido muito longo." });
  if (!order.startsWith("#")) order = "#" + order;

  const existing = await pool.query(
    "SELECT id,order_number FROM dispatches WHERE courier_id=$1 AND status='ON_ROAD' LIMIT 1",
    [req.session.user.id]
  );
  if (existing.rowCount) {
    return res.status(409).json({
      error: `Você já está na rua com o pedido ${existing.rows[0].order_number}. O administrador precisa liberar seu status antes de uma nova saída.`
    });
  }

  const code = "DSP-" + Date.now().toString(36).toUpperCase();
  const result = await pool.query(`
    INSERT INTO dispatches(dispatch_code,order_number,courier_id)
    VALUES($1,$2,$3)
    RETURNING id,dispatch_code,order_number,departed_at,status
  `, [code, order, req.session.user.id]);

  const dispatch = result.rows[0];
  await audit(req.session.user.id, "DEPARTURE_REGISTERED", "dispatch", dispatch.id, {
    order_number: order,
    departed_at: dispatch.departed_at
  });

  io.emit("dispatch:changed");
  res.status(201).json({ dispatch });
}));

app.get("/api/admin/dashboard", auth, adminOnly, asyncRoute(async (req, res) => {
  const metrics = (await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='courier' AND active=true)::int AS active_couriers,
      (SELECT COUNT(*) FROM dispatches WHERE status='ON_ROAD')::int AS on_road,
      (SELECT COUNT(*) FROM dispatches
       WHERE (departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
             (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today
  `)).rows[0];

  const active = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,
           u.id AS courier_id,u.name AS courier_name,u.username
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    WHERE d.status='ON_ROAD'
    ORDER BY d.departed_at ASC
  `)).rows;

  const recent = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.released_at,d.status,
           u.name AS courier_name
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    ORDER BY d.id DESC LIMIT 150
  `)).rows;

  const couriers = (await pool.query(`
    SELECT u.id,u.name,u.username,u.active,
      (
        SELECT COUNT(*) FROM dispatches d
        WHERE d.courier_id=u.id
        AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
            (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_count,
      EXISTS(
        SELECT 1 FROM dispatches d2 WHERE d2.courier_id=u.id AND d2.status='ON_ROAD'
      ) AS on_road
    FROM users u
    WHERE u.role='courier'
    ORDER BY u.name
  `)).rows;

  res.json({
    metrics: {
      activeCouriers: metrics.active_couriers,
      onRoad: metrics.on_road,
      available: Math.max(0, metrics.active_couriers - metrics.on_road),
      today: metrics.today
    },
    active,
    recent,
    couriers
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
      INSERT INTO users(name,username,password_hash,role)
      VALUES($1,$2,$3,'courier')
      RETURNING id,name,username,active
    `, [name, username, await bcrypt.hash(password, 12)]);

    await audit(req.session.user.id, "COURIER_CREATED", "user", q.rows[0].id, { username });
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
    RETURNING id,name,username,active
  `, [active, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, active ? "COURIER_ACTIVATED" : "COURIER_DEACTIVATED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/dispatches/:id/release", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE dispatches
    SET status='RELEASED', released_at=NOW(), released_by=$1
    WHERE id=$2 AND status='ON_ROAD'
    RETURNING *
  `, [req.session.user.id, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Saída ativa não encontrada." });

  await audit(req.session.user.id, "COURIER_RELEASED", "dispatch", q.rows[0].id, {
    order_number: q.rows[0].order_number
  });

  io.emit("dispatch:changed");
  res.json({ dispatch: q.rows[0] });
}));

app.get("/api/admin/audit", auth, adminOnly, asyncRoute(async (req, res) => {
  const rows = (await pool.query(`
    SELECT a.id,a.action,a.entity,a.entity_id,a.details,a.created_at,u.name AS user_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 300
  `)).rows;
  res.json({ rows });
}));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", socket => {
  socket.emit("server:time", { now: new Date().toISOString() });
});

setInterval(() => io.emit("server:time", { now: new Date().toISOString() }), 1000);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`DespachaMoto 1.0 rodando na porta ${port}`));
