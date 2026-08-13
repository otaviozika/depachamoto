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
import crypto from "crypto";
import webpush from "web-push";

const { Pool } = pg;
const PgSession = connectPg(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VERSION = "2.0.1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.warn("AVISO: SESSION_SECRET ausente ou curta. Use pelo menos 32 caracteres em produção.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on("error", err => {
  console.error("PostgreSQL pool error:", err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});


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
  skip: req => !!process.env.LOAD_TEST_KEY &&
    req.get("x-load-test-key") === process.env.LOAD_TEST_KEY,
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

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS registered_by INTEGER REFERENCES users(id);

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS registration_source TEXT NOT NULL DEFAULT 'COURIER';

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS admin_reason TEXT;

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS closed_reason TEXT;

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS client_token TEXT;

CREATE TABLE IF NOT EXISTS dispatch_orders (
  id BIGSERIAL PRIMARY KEY,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dispatch_id, order_number)
);

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

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  courier_id INTEGER REFERENCES users(id),
  dispatch_id BIGINT REFERENCES dispatches(id) ON DELETE CASCADE,
  unique_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_errors (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  message TEXT NOT NULL,
  stack_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS dispatches_client_token_unique_idx
ON dispatches(client_token) WHERE client_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS dispatches_courier_idx ON dispatches(courier_id);
CREATE INDEX IF NOT EXISTS dispatches_departed_idx ON dispatches(departed_at DESC);
CREATE INDEX IF NOT EXISTS dispatches_status_idx ON dispatches(status);
CREATE INDEX IF NOT EXISTS dispatches_active_courier_idx
ON dispatches(courier_id,departed_at DESC) WHERE status='ON_ROAD';
CREATE INDEX IF NOT EXISTS dispatch_orders_dispatch_idx ON dispatch_orders(dispatch_id);
CREATE INDEX IF NOT EXISTS dispatch_orders_number_idx ON dispatch_orders(order_number);
CREATE INDEX IF NOT EXISTS users_courier_status_idx
ON users(role,approval_status,active);
CREATE INDEX IF NOT EXISTS notifications_unread_idx
ON notifications(read_at,created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_dispatch_idx
ON notifications(dispatch_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx
ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS system_errors_created_idx
ON system_errors(created_at DESC);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'WEB'
);

CREATE INDEX IF NOT EXISTS user_presence_seen_idx
ON user_presence(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS active_order_locks (
  order_number TEXT PRIMARY KEY,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  courier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS active_order_locks_courier_idx
ON active_order_locks(courier_id);

CREATE TABLE IF NOT EXISTS operational_conflicts (
  id BIGSERIAL PRIMARY KEY,
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  courier_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_numbers JSONB,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS operational_conflicts_created_idx
ON operational_conflicts(created_at DESC);

CREATE INDEX IF NOT EXISTS operational_conflicts_open_idx
ON operational_conflicts(resolved_at,created_at DESC);

CREATE TABLE IF NOT EXISTS ifood_merchants (
  merchant_id TEXT PRIMARY KEY,
  name TEXT,
  corporate_name TEXT,
  payload JSONB,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ifood_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT,
  merchant_id TEXT,
  code TEXT,
  full_code TEXT,
  event_created_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ifood_events_order_idx
ON ifood_events(order_id,event_created_at DESC);

CREATE INDEX IF NOT EXISTS ifood_events_received_idx
ON ifood_events(received_at DESC);

CREATE TABLE IF NOT EXISTS ifood_orders (
  order_id TEXT PRIMARY KEY,
  display_id TEXT,
  merchant_id TEXT,
  status TEXT,
  order_type TEXT,
  category TEXT,
  sales_channel TEXT,
  delivered_by TEXT,
  is_test BOOLEAN,
  order_created_at TIMESTAMPTZ,
  last_event_code TEXT,
  last_event_at TIMESTAMPTZ,
  payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ifood_orders_display_idx
ON ifood_orders(display_id);

CREATE INDEX IF NOT EXISTS ifood_orders_updated_idx
ON ifood_orders(updated_at DESC);

CREATE TABLE IF NOT EXISTS ifood_sync_state (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton=1),
  last_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  last_event_count INTEGER NOT NULL DEFAULT 0,
  total_events_received BIGINT NOT NULL DEFAULT 0
);

INSERT INTO ifood_sync_state(singleton)
VALUES(1)
ON CONFLICT(singleton) DO NOTHING;
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
  ('public_registration_enabled','true'),
  ('notify_attention','true'),
  ('notify_delayed','true'),
  ('notify_critical','true'),
  ('notify_registration','true'),
  ('notification_sound','true'),
  ('vapid_public_key',''),
  ('vapid_private_key_enc',''),
  ('vapid_subject','')
ON CONFLICT (setting_key) DO NOTHING;
`);


await pool.query(`
INSERT INTO active_order_locks(order_number,dispatch_id,courier_id)
SELECT o.order_number,d.id,d.courier_id
FROM dispatch_orders o
JOIN dispatches d ON d.id=o.dispatch_id
WHERE d.status='ON_ROAD'
ON CONFLICT(order_number) DO NOTHING;
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

const IFOOD_AUTH_URL = "https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token";
const IFOOD_MERCHANT_BASE = "https://merchant-api.ifood.com.br/merchant/v1.0";
const IFOOD_EVENTS_BASE = "https://merchant-api.ifood.com.br/events/v1.0";
const IFOOD_ORDER_BASE = "https://merchant-api.ifood.com.br/order/v1.0";

let ifoodTokenCache = {
  accessToken: null,
  expiresAt: 0
};

let ifoodSyncRunning = false;

function ifoodConfigured() {
  return Boolean(
    String(process.env.IFOOD_CLIENT_ID || "").trim() &&
    String(process.env.IFOOD_CLIENT_SECRET || "").trim()
  );
}

function ifoodAutoEnabled() {
  return String(process.env.IFOOD_ENABLED || "false").toLowerCase() === "true";
}

function ifoodSafeError(err) {
  const raw = String(err?.message || err || "Erro desconhecido.");
  return raw
    .replace(String(process.env.IFOOD_CLIENT_SECRET || ""), "[SECRET]")
    .replace(String(process.env.IFOOD_CLIENT_ID || ""), "[CLIENT_ID]")
    .slice(0, 600);
}

async function fetchIfood(url, options = {}, timeoutMs = 12000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const err = new Error(`iFood HTTP ${response.status}`);
    err.statusCode = response.status;
    err.ifoodBody = typeof body === "string" ? body.slice(0, 300) : body;
    throw err;
  }

  return { response, body };
}

async function getIfoodAccessToken(force = false) {
  if (!ifoodConfigured()) {
    const err = new Error("Credenciais do iFood não configuradas no servidor.");
    err.status = 503;
    throw err;
  }

  const now = Date.now();
  if (
    !force &&
    ifoodTokenCache.accessToken &&
    ifoodTokenCache.expiresAt > now + 60_000
  ) {
    return ifoodTokenCache.accessToken;
  }

  const form = new URLSearchParams({
    grantType: "client_credentials",
    clientId: String(process.env.IFOOD_CLIENT_ID).trim(),
    clientSecret: String(process.env.IFOOD_CLIENT_SECRET).trim()
  });

  const { body } = await fetchIfood(IFOOD_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const token = body?.accessToken;
  const expiresIn = Number(body?.expiresIn || 21600);

  if (!token) {
    throw new Error("iFood autenticou sem retornar accessToken.");
  }

  ifoodTokenCache = {
    accessToken: token,
    expiresAt: now + Math.max(300, expiresIn) * 1000
  };

  return token;
}

async function ifoodApi(url, options = {}) {
  let token = await getIfoodAccessToken(false);

  try {
    return await fetchIfood(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
  } catch (err) {
    // Token expirado/revogado: uma única renovação e retry.
    if (err?.statusCode !== 401) throw err;

    token = await getIfoodAccessToken(true);
    return fetchIfood(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
  }
}

async function fetchAndStoreIfoodMerchants() {
  const { body } = await ifoodApi(`${IFOOD_MERCHANT_BASE}/merchants?page=1&size=100`);
  const merchants = Array.isArray(body) ? body : (body?.merchants || body?.content || []);

  for (const merchant of merchants) {
    if (!merchant?.id) continue;

    await pool.query(`
      INSERT INTO ifood_merchants(merchant_id,name,corporate_name,payload,last_seen_at)
      VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(merchant_id) DO UPDATE SET
        name=EXCLUDED.name,
        corporate_name=EXCLUDED.corporate_name,
        payload=EXCLUDED.payload,
        last_seen_at=NOW()
    `, [
      String(merchant.id),
      merchant.name || null,
      merchant.corporateName || null,
      JSON.stringify(merchant)
    ]);
  }

  return merchants
    .filter(x => x?.id)
    .map(x => ({
      id: String(x.id),
      name: x.name || "Loja iFood",
      corporateName: x.corporateName || null
    }));
}

function normalizeIfoodEvents(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.events)) return body.events;
  return [];
}

async function upsertIfoodOrderFromDetails(order, fallback = {}) {
  if (!order?.id && !fallback.orderId) return false;

  const orderId = String(order?.id || fallback.orderId);
  const merchantId = order?.merchant?.id || fallback.merchantId || null;
  const lastEventCode = fallback.fullCode || fallback.code || order?.status || null;
  const lastEventAt = fallback.createdAt || null;

  await pool.query(`
    INSERT INTO ifood_orders(
      order_id,display_id,merchant_id,status,order_type,category,sales_channel,
      delivered_by,is_test,order_created_at,last_event_code,last_event_at,payload,updated_at
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT(order_id) DO UPDATE SET
      display_id=COALESCE(EXCLUDED.display_id,ifood_orders.display_id),
      merchant_id=COALESCE(EXCLUDED.merchant_id,ifood_orders.merchant_id),
      status=COALESCE(EXCLUDED.status,ifood_orders.status),
      order_type=COALESCE(EXCLUDED.order_type,ifood_orders.order_type),
      category=COALESCE(EXCLUDED.category,ifood_orders.category),
      sales_channel=COALESCE(EXCLUDED.sales_channel,ifood_orders.sales_channel),
      delivered_by=COALESCE(EXCLUDED.delivered_by,ifood_orders.delivered_by),
      is_test=COALESCE(EXCLUDED.is_test,ifood_orders.is_test),
      order_created_at=COALESCE(EXCLUDED.order_created_at,ifood_orders.order_created_at),
      last_event_code=COALESCE(EXCLUDED.last_event_code,ifood_orders.last_event_code),
      last_event_at=COALESCE(EXCLUDED.last_event_at,ifood_orders.last_event_at),
      payload=COALESCE(EXCLUDED.payload,ifood_orders.payload),
      updated_at=NOW()
  `, [
    orderId,
    order?.displayId || null,
    merchantId ? String(merchantId) : null,
    order?.status || lastEventCode || null,
    order?.orderType || null,
    order?.category || null,
    order?.salesChannel || null,
    order?.delivery?.deliveredBy || null,
    typeof order?.isTest === "boolean" ? order.isTest : null,
    order?.createdAt || null,
    lastEventCode,
    lastEventAt,
    JSON.stringify(order || {})
  ]);

  return true;
}

async function storeIfoodEvent(event) {
  if (!event?.id) return { stored: false, duplicate: false };

  const result = await pool.query(`
    INSERT INTO ifood_events(
      event_id,order_id,merchant_id,code,full_code,event_created_at,payload
    )
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(event_id) DO NOTHING
    RETURNING event_id
  `, [
    String(event.id),
    event.orderId ? String(event.orderId) : null,
    event.merchantId ? String(event.merchantId) : null,
    event.code || null,
    event.fullCode || null,
    event.createdAt || null,
    JSON.stringify(event)
  ]);

  return {
    stored: result.rowCount === 1,
    duplicate: result.rowCount === 0
  };
}

async function ifoodOrderAlreadyStored(orderId) {
  if (!orderId) return false;
  const q = await pool.query("SELECT 1 FROM ifood_orders WHERE order_id=$1", [String(orderId)]);
  return q.rowCount > 0;
}

async function fetchIfoodOrderDetails(orderId) {
  const { body } = await ifoodApi(`${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(orderId)}`);
  return body;
}

async function acknowledgeIfoodEvents(eventIds) {
  const unique = [...new Set(eventIds.filter(Boolean).map(String))];
  if (!unique.length) return 0;

  const payload = unique.map(id => ({ id }));
  await ifoodApi(`${IFOOD_EVENTS_BASE}/events/acknowledgment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  await pool.query(`
    UPDATE ifood_events
    SET acknowledged_at=COALESCE(acknowledged_at,NOW())
    WHERE event_id=ANY($1::text[])
  `, [unique]);

  return unique.length;
}

async function setIfoodSyncSuccess(eventCount) {
  const count = Math.max(0, Number.parseInt(eventCount, 10) || 0);

  await pool.query(`
    UPDATE ifood_sync_state SET
      last_poll_at=NOW(),
      last_success_at=NOW(),
      last_error=NULL,
      last_error_at=NULL,
      last_event_count=$1::integer,
      total_events_received=total_events_received + ($1::integer)::bigint
    WHERE singleton=1
  `, [count]);
}

async function setIfoodSyncError(err) {
  await pool.query(`
    UPDATE ifood_sync_state SET
      last_poll_at=NOW(),
      last_error=$1,
      last_error_at=NOW()
    WHERE singleton=1
  `, [ifoodSafeError(err)]).catch(() => {});
}

async function syncIfoodOnce({ reason = "manual" } = {}) {
  if (ifoodSyncRunning) {
    return {
      ok: true,
      skipped: true,
      reason: "already_running",
      events: 0,
      ordersUpdated: 0,
      acknowledged: 0
    };
  }

  ifoodSyncRunning = true;

  try {
    const merchants = await fetchAndStoreIfoodMerchants();
    const merchantIds = merchants.map(x => x.id);

    if (!merchantIds.length) {
      throw new Error("Nenhuma loja iFood vinculada às credenciais.");
    }

    const url = new URL(`${IFOOD_EVENTS_BASE}/events:polling`);
    url.searchParams.set("categories", "FOOD");
    // Evita que esta integração de despacho altere presença/abertura da loja.
    url.searchParams.set("excludeHeartbeat", "true");

    const { response, body } = await ifoodApi(url.toString(), {
      headers: {
        "x-polling-merchants": merchantIds.join(",")
      }
    });

    const events = response.status === 204 ? [] : normalizeIfoodEvents(body);
    events.sort((a, b) => Date.parse(a?.createdAt || 0) - Date.parse(b?.createdAt || 0));

    const ackIds = [];
    let ordersUpdated = 0;
    let newEvents = 0;
    const detailsFetched = new Set();

    for (const event of events) {
      if (!event?.id) continue;

      const stored = await storeIfoodEvent(event);
      if (stored.stored) newEvents++;

      let safeToAck = true;

      if (event.orderId) {
        const orderId = String(event.orderId);
        const already = await ifoodOrderAlreadyStored(orderId);

        // Para evento novo, ou caso ainda não tenhamos detalhes do pedido,
        // recupera a estrutura completa antes do ACK.
        if ((!already || stored.stored) && !detailsFetched.has(orderId)) {
          try {
            const order = await fetchIfoodOrderDetails(orderId);
            await upsertIfoodOrderFromDetails(order, event);
            detailsFetched.add(orderId);
            ordersUpdated++;
          } catch (err) {
            // Mantém o evento sem ACK para tentar novamente em polling futuro.
            safeToAck = false;
            console.error(`iFood order details ${orderId}:`, ifoodSafeError(err));
          }
        } else if (already) {
          // Atualiza pelo menos o último evento mesmo sem buscar payload novamente.
          await pool.query(`
            UPDATE ifood_orders SET
              status=COALESCE($2,status),
              last_event_code=COALESCE($2,last_event_code),
              last_event_at=COALESCE($3,last_event_at),
              updated_at=NOW()
            WHERE order_id=$1
          `, [
            orderId,
            event.fullCode || event.code || null,
            event.createdAt || null
          ]);
        }
      }

      if (safeToAck) ackIds.push(String(event.id));
    }

    const acknowledged = await acknowledgeIfoodEvents(ackIds);
    await setIfoodSyncSuccess(events.length);

    return {
      ok: true,
      reason,
      merchants: merchants.length,
      events: events.length,
      newEvents,
      ordersUpdated,
      acknowledged
    };
  } catch (err) {
    await setIfoodSyncError(err);
    throw err;
  } finally {
    ifoodSyncRunning = false;
  }
}

async function auditBestEffort(userId, action, entity, entityId, details = {}) {
  try {
    await audit(userId, action, entity, entityId, details);
    return true;
  } catch (err) {
    // A operação principal já pode ter sido COMMITada. Não transformar uma
    // saída válida em HTTP 500 apenas porque o log de auditoria ficou sem conexão.
    console.error(`Audit best-effort failed [${action}]:`, err?.message || err);
    return false;
  }
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

function secretCipherKey() {
  return crypto.createHash("sha256")
    .update(process.env.SESSION_SECRET || "despachamoto-dev-secret")
    .digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSecret(value) {
  const [ivB64, tagB64, dataB64] = String(value || "").split(".");
  if (!ivB64 || !tagB64 || !dataB64) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretCipherKey(),
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function getVapidConfig() {
  const publicKey = await getSetting("vapid_public_key", "");
  const encryptedPrivate = await getSetting("vapid_private_key_enc", "");
  const subject = await getSetting("vapid_subject", "");
  if (!publicKey || !encryptedPrivate || !subject) return null;
  try {
    return { publicKey, privateKey: decryptSecret(encryptedPrivate), subject };
  } catch {
    return null;
  }
}

async function ensureVapidConfig(subject) {
  let config = await getVapidConfig();
  if (config) return config;

  const keys = webpush.generateVAPIDKeys();
  await setSetting("vapid_public_key", keys.publicKey);
  await setSetting("vapid_private_key_enc", encryptSecret(keys.privateKey));
  await setSetting("vapid_subject", subject);
  config = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
  return config;
}

async function sendPushToAdmins(notification) {
  const config = await getVapidConfig();
  if (!config) return;

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const subs = (await pool.query(`
    SELECT id,endpoint,p256dh,auth
    FROM push_subscriptions
    ORDER BY id
  `)).rows;

  if (!subs.length) return;

  const payload = JSON.stringify({
    id: notification.id,
    title: notification.title,
    message: notification.message,
    severity: notification.severity,
    type: notification.type
  });

  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, payload, { TTL: 120 });
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [sub.id]);
      } else {
        throw err;
      }
    }
  }));
}

function normalizeQueuedDepartureTime(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return null;
  const now = Date.now();
  if (parsed < now - (2 * 60 * 60 * 1000)) return null;
  if (parsed > now + (2 * 60 * 1000)) return null;
  return new Date(parsed).toISOString();
}

async function recordSystemError(req, statusCode, err) {
  try {
    await pool.query(`
      INSERT INTO system_errors(request_id,method,path,status_code,message,stack_preview)
      VALUES($1,$2,$3,$4,$5,$6)
    `, [
      req?.requestId || null,
      req?.method || null,
      String(req?.originalUrl || req?.url || "").slice(0, 500),
      statusCode || 500,
      String(err?.message || "Erro interno").slice(0, 1000),
      String(err?.stack || "").slice(0, 3000)
    ]);
  } catch {}
}



async function touchPresence(userId, source = "WEB") {
  if (!userId) return;
  await pool.query(`
    INSERT INTO user_presence(user_id,last_seen_at,source)
    VALUES($1,NOW(),$2)
    ON CONFLICT(user_id) DO UPDATE SET
      last_seen_at=NOW(),
      source=EXCLUDED.source
  `, [userId, source]);
}

async function logOperationalConflict({
  type,
  severity = "warning",
  actorUserId = null,
  courierId = null,
  orders = [],
  details = {}
}) {
  try {
    const q = await pool.query(`
      INSERT INTO operational_conflicts(
        conflict_type,severity,actor_user_id,courier_id,order_numbers,details
      )
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING id,conflict_type,severity,created_at
    `, [
      type,
      severity,
      actorUserId,
      courierId,
      JSON.stringify(orders),
      JSON.stringify(details)
    ]);
    io.emit("conflict:new", q.rows[0]);
    return q.rows[0];
  } catch {
    return null;
  }
}

async function inspectOrders(orders) {
  if (!orders.length) return { active: [], recent: [] };

  const active = (await pool.query(`
    SELECT l.order_number,l.dispatch_id,l.courier_id,
           u.name AS courier_name,d.departed_at
    FROM active_order_locks l
    JOIN users u ON u.id=l.courier_id
    JOIN dispatches d ON d.id=l.dispatch_id
    WHERE l.order_number = ANY($1::text[])
    ORDER BY l.order_number
  `, [orders])).rows;

  const recent = (await pool.query(`
    SELECT DISTINCT ON (o.order_number)
      o.order_number,d.id AS dispatch_id,d.courier_id,
      u.name AS courier_name,d.departed_at,d.status
    FROM dispatch_orders o
    JOIN dispatches d ON d.id=o.dispatch_id
    JOIN users u ON u.id=d.courier_id
    WHERE o.order_number = ANY($1::text[])
      AND d.departed_at >= NOW()-INTERVAL '12 hours'
    ORDER BY o.order_number,d.departed_at DESC,d.id DESC
  `, [orders])).rows.filter(r => !active.some(a => a.order_number === r.order_number));

  return { active, recent };
}

function recentWarningPayload(rows) {
  return rows.map(r => ({
    order_number: r.order_number,
    courier_name: r.courier_name,
    departed_at: r.departed_at,
    status: r.status
  }));
}
async function notificationEnabled(key, fallback = "true") {
  return (await getSetting(key, fallback)) === "true";
}

async function createNotification({
  type,
  severity = "info",
  title,
  message,
  courierId = null,
  dispatchId = null,
  uniqueKey = null
}) {
  if (type === "TIME_ATTENTION" && !(await notificationEnabled("notify_attention"))) return null;
  if (type === "TIME_DELAYED" && !(await notificationEnabled("notify_delayed"))) return null;
  if (type === "TIME_CRITICAL" && !(await notificationEnabled("notify_critical"))) return null;
  if (type === "REGISTRATION_PENDING" && !(await notificationEnabled("notify_registration"))) return null;

  const q = await pool.query(`
    INSERT INTO notifications(type,severity,title,message,courier_id,dispatch_id,unique_key)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(unique_key) DO NOTHING
    RETURNING id,type,severity,title,message,courier_id,dispatch_id,created_at,read_at
  `, [type,severity,title,message,courierId,dispatchId,uniqueKey]);

  const notification = q.rows[0] || null;
  if (notification) {
    io.emit("notification:new", notification);
    sendPushToAdmins(notification).catch(err => {
      console.error("Web Push error:", err?.message || err);
    });
  }
  return notification;
}

async function closeActiveDispatch(client, courierId, releasedBy, reason, closedAt = null) {
  const active = await client.query(`
    SELECT id,dispatch_code,departed_at,status
    FROM dispatches
    WHERE courier_id=$1 AND status='ON_ROAD'
    ORDER BY departed_at DESC,id DESC
    LIMIT 1
    FOR UPDATE
  `, [courierId]);

  if (!active.rowCount) return null;

  const requested = closedAt ? new Date(closedAt) : null;
  const previousStart = new Date(active.rows[0].departed_at);
  const effectiveClose = requested && requested >= previousStart
    ? requested.toISOString()
    : new Date().toISOString();

  const q = await client.query(`
    UPDATE dispatches
    SET status='RELEASED',
        released_at=$1::timestamptz,
        released_by=$2,
        closed_reason=$3
    WHERE id=$4 AND status='ON_ROAD'
    RETURNING *
  `, [effectiveClose, releasedBy, reason, active.rows[0].id]);

  if (q.rowCount) {
    await client.query("DELETE FROM active_order_locks WHERE dispatch_id=$1", [active.rows[0].id]);
  }

  return q.rows[0] || null;
}

async function createDispatchTransaction({
  actorUserId,
  courierId,
  orders,
  source,
  adminReason = null,
  clientToken = null,
  departedAt = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (clientToken) {
      const existing = await client.query(`
        SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,d.registration_source,
               ${orderArraySql("d")}
        FROM dispatches d
        WHERE d.client_token=$1
        LIMIT 1
      `, [clientToken]);
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return { dispatch: existing.rows[0], closedPrevious: null, duplicate: true };
      }
    }

    const effectiveDeparture = departedAt || new Date().toISOString();

    const closedPrevious = await closeActiveDispatch(
      client,
      courierId,
      actorUserId,
      source === "ADMIN" ? "NEW_DEPARTURE_BY_ADMIN" : "NEW_DEPARTURE_BY_COURIER",
      effectiveDeparture
    );

    const code = "DSP-" + Date.now().toString(36).toUpperCase() + "-" +
      Math.random().toString(36).slice(2, 6).toUpperCase();

    const result = await client.query(`
      INSERT INTO dispatches(
        dispatch_code,order_number,courier_id,
        registered_by,registration_source,admin_reason,client_token,departed_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
      RETURNING id,dispatch_code,order_number,departed_at,status,
                registered_by,registration_source,admin_reason
    `, [
      code,
      orders[0],
      courierId,
      actorUserId,
      source,
      adminReason || null,
      clientToken || null,
      effectiveDeparture
    ]);

    const dispatch = result.rows[0];

    for (const order of orders) {
      await client.query(
        "INSERT INTO dispatch_orders(dispatch_id,order_number) VALUES($1,$2)",
        [dispatch.id, order]
      );
      await client.query(
        "INSERT INTO active_order_locks(order_number,dispatch_id,courier_id) VALUES($1,$2,$3)",
        [order, dispatch.id, courierId]
      );
    }

    await client.query("COMMIT");
    dispatch.order_numbers = orders;

    return { dispatch, closedPrevious, duplicate: false };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}

    // Recuperação idempotente SOMENTE quando a colisão é do client_token.
    // Importante: usa o mesmo client já reservado. Em v1.7.1, usar pool.query()
    // aqui podia esgotar o pool quando muitas requisições colidiam ao mesmo tempo.
    if (
      e.code === "23505" &&
      clientToken &&
      String(e.constraint || "") === "dispatches_client_token_unique_idx"
    ) {
      const existing = await client.query(`
        SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,d.registration_source,
               ${orderArraySql("d")}
        FROM dispatches d
        WHERE d.client_token=$1
        LIMIT 1
      `, [clientToken]);
      if (existing.rowCount) {
        return { dispatch: existing.rows[0], closedPrevious: null, duplicate: true };
      }
    }

    // Colisões de active_order_locks seguem para a rota, que responde 409.
    throw e;
  } finally {
    client.release();
  }
}

async function checkTimeNotifications() {
  try {
    const alerts = await getAlertSettings();
    const rows = (await pool.query(`
      SELECT d.id,d.departed_at,u.id AS courier_id,u.name AS courier_name,
             EXTRACT(EPOCH FROM (NOW()-d.departed_at))/60 AS minutes,
             ${orderArraySql("d")}
      FROM dispatches d
      JOIN users u ON u.id=d.courier_id
      WHERE d.status='ON_ROAD'
    `)).rows;

    for (const row of rows) {
      const minutes = Number(row.minutes || 0);
      const orders = Array.isArray(row.order_numbers) ? row.order_numbers.join(", ") : row.order_number;

      if (minutes >= alerts.attention) {
        await createNotification({
          type: "TIME_ATTENTION",
          severity: "warning",
          title: "Motoboy em atenção",
          message: `${row.courier_name} está na rua há ${Math.floor(minutes)} min. ${orders}`,
          courierId: row.courier_id,
          dispatchId: row.id,
          uniqueKey: `time:${row.id}:attention`
        });
      }
      if (minutes >= alerts.delayed) {
        await createNotification({
          type: "TIME_DELAYED",
          severity: "delayed",
          title: "Saída demorada",
          message: `${row.courier_name} está na rua há ${Math.floor(minutes)} min. ${orders}`,
          courierId: row.courier_id,
          dispatchId: row.id,
          uniqueKey: `time:${row.id}:delayed`
        });
      }
      if (minutes >= alerts.critical) {
        await createNotification({
          type: "TIME_CRITICAL",
          severity: "critical",
          title: "Tempo crítico",
          message: `${row.courier_name} está na rua há ${Math.floor(minutes)} min. ${orders}`,
          courierId: row.courier_id,
          dispatchId: row.id,
          uniqueKey: `time:${row.id}:critical`
        });
      }
    }
  } catch (e) {
    console.error("Falha ao verificar alertas de tempo:", e.message);
  }
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
    await createNotification({
      type: "REGISTRATION_PENDING",
      severity: "info",
      title: "Novo cadastro aguardando aprovação",
      message: `${user.name} (@${user.username}) solicitou acesso ao DespachaMoto.`,
      courierId: user.id,
      uniqueKey: `registration:${user.id}`
    });
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


app.post("/api/presence", auth, asyncRoute(async (req, res) => {
  await touchPresence(
    req.session.user.id,
    req.session.user.role === "courier" ? "COURIER_WEB" : "ADMIN_WEB"
  );
  res.json({ ok: true, server_now: new Date().toISOString() });
}));

app.get("/api/courier/dashboard", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
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
  await touchPresence(req.session.user.id, "COURIER_WEB");

  const user = await currentUser(req.session.user.id);
  if (user?.must_change_password) {
    return res.status(403).json({ error: "Altere sua senha temporária antes de registrar uma saída." });
  }

  const orders = normalizeOrders(req.body);
  const clientToken = String(req.body.client_token || "").trim().slice(0, 100) || null;

  if (clientToken) {
    const replay = await pool.query(`
      SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,d.registration_source,
             ${orderArraySql("d")}
      FROM dispatches d
      WHERE d.client_token=$1
      LIMIT 1
    `, [clientToken]);

    if (replay.rowCount) {
      await logOperationalConflict({
        type: "IDEMPOTENT_REPLAY",
        severity: "info",
        actorUserId: req.session.user.id,
        courierId: req.session.user.id,
        orders,
        details: { client_token: clientToken }
      });
      return res.json({
        dispatch: replay.rows[0],
        duplicate: true,
        server_now: new Date().toISOString()
      });
    }
  }

  const inspection = await inspectOrders(orders);

  if (inspection.active.length) {
    await logOperationalConflict({
      type: "ACTIVE_ORDER_DUPLICATE",
      severity: "critical",
      actorUserId: req.session.user.id,
      courierId: req.session.user.id,
      orders: inspection.active.map(x => x.order_number),
      details: { conflicts: inspection.active }
    });

    return res.status(409).json({
      error: "Um ou mais pedidos já estão em uma saída ativa. Não é possível duplicar um pedido que está na rua.",
      code: "ORDER_ALREADY_ACTIVE",
      conflicts: inspection.active,
      server_now: new Date().toISOString()
    });
  }

  if (inspection.recent.length && req.body.confirm_recent_orders !== true) {
    await logOperationalConflict({
      type: "RECENT_ORDER_WARNING",
      severity: "warning",
      actorUserId: req.session.user.id,
      courierId: req.session.user.id,
      orders: inspection.recent.map(x => x.order_number),
      details: { recent: inspection.recent }
    });

    return res.status(409).json({
      error: "Um ou mais pedidos já foram usados nas últimas 12 horas. Confirme se deseja continuar.",
      code: "RECENT_ORDER_CONFIRMATION",
      recent: recentWarningPayload(inspection.recent),
      server_now: new Date().toISOString()
    });
  }

  const activeQ = await pool.query(`
    SELECT d.id,d.departed_at,d.order_number,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1 AND d.status='ON_ROAD'
    ORDER BY d.departed_at DESC,d.id DESC
    LIMIT 1
  `, [req.session.user.id]);

  if (activeQ.rowCount && req.body.confirm_new_departure !== true) {
    return res.status(409).json({
      error: "Você possui uma saída ativa. Confirme para encerrar a saída anterior e iniciar a nova.",
      code: "ACTIVE_DISPATCH_CONFIRMATION",
      active: activeQ.rows[0],
      server_now: new Date().toISOString()
    });
  }

  const queuedDeparture = req.body.offline_queued === true
    ? normalizeQueuedDepartureTime(req.body.estimated_departed_at)
    : null;

  if (req.body.offline_queued === true && queuedDeparture) {
    const delayMinutes = Math.max(
      0,
      Math.round((Date.now() - Date.parse(queuedDeparture)) / 60000)
    );
    if (delayMinutes >= 5) {
      await logOperationalConflict({
        type: "OFFLINE_SYNC_DELAY",
        severity: delayMinutes >= 15 ? "critical" : "warning",
        actorUserId: req.session.user.id,
        courierId: req.session.user.id,
        orders,
        details: {
          delay_minutes: delayMinutes,
          estimated_departed_at: queuedDeparture
        }
      });
    }
  }

  let result;
  try {
    result = await createDispatchTransaction({
      actorUserId: req.session.user.id,
      courierId: req.session.user.id,
      orders,
      source: "COURIER",
      clientToken,
      departedAt: queuedDeparture
    });
  } catch (e) {
    if (e.code === "23505" && String(e.constraint || "").includes("active_order_locks")) {
      const raceInspection = await inspectOrders(orders);
      await logOperationalConflict({
        type: "ACTIVE_ORDER_RACE_BLOCKED",
        severity: "critical",
        actorUserId: req.session.user.id,
        courierId: req.session.user.id,
        orders,
        details: { conflicts: raceInspection.active }
      });
      return res.status(409).json({
        error: "Outro registro utilizou este pedido ao mesmo tempo. Atualize e confira o pedido.",
        code: "ORDER_ALREADY_ACTIVE",
        conflicts: raceInspection.active
      });
    }
    throw e;
  }

  if (!result.duplicate) {
    await auditBestEffort(req.session.user.id, "DEPARTURE_REGISTERED", "dispatch", result.dispatch.id, {
      order_numbers: orders,
      order_count: orders.length,
      departed_at: result.dispatch.departed_at,
      source: "COURIER",
      previous_dispatch_closed: result.closedPrevious?.id || null
    });
  }

  io.emit("dispatch:changed");
  res.status(result.duplicate ? 200 : 201).json({
    dispatch: result.dispatch,
    closed_previous: result.closedPrevious,
    duplicate: result.duplicate,
    server_now: new Date().toISOString()
  });
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
           d.registration_source,d.admin_reason,d.registered_by,
           u.id AS courier_id,u.name AS courier_name,u.username,
           ru.name AS registered_by_name,
           ${orderArraySql("d")}
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    LEFT JOIN users ru ON ru.id=d.registered_by
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


app.post("/api/admin/dispatches/manual", auth, adminOnly, asyncRoute(async (req, res) => {
  const courierId = Number(req.body.courier_id);
  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Selecione um motoboy." });
  }

  const courierQ = await pool.query(`
    SELECT id,name,username,active,approval_status
    FROM users
    WHERE id=$1 AND role='courier'
  `, [courierId]);

  const courier = courierQ.rows[0];
  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });
  if (!courier.active || courier.approval_status !== "APPROVED") {
    return res.status(400).json({ error: "O motoboy selecionado não está ativo e aprovado." });
  }

  const orders = normalizeOrders(req.body);
  const reason = String(req.body.reason || "").trim().slice(0, 250);
  const clientToken = String(req.body.client_token || "").trim().slice(0, 100) || null;

  if (clientToken) {
    const replay = await pool.query("SELECT id FROM dispatches WHERE client_token=$1 LIMIT 1", [clientToken]);
    if (replay.rowCount) {
      return res.json({ duplicate: true, dispatch: { id: replay.rows[0].id } });
    }
  }

  const inspection = await inspectOrders(orders);

  if (inspection.active.length) {
    await logOperationalConflict({
      type: "ACTIVE_ORDER_DUPLICATE_ADMIN",
      severity: "critical",
      actorUserId: req.session.user.id,
      courierId,
      orders: inspection.active.map(x => x.order_number),
      details: { conflicts: inspection.active }
    });

    return res.status(409).json({
      error: "Pedido já está em uma saída ativa. Corrija a situação antes de registrar novamente.",
      code: "ORDER_ALREADY_ACTIVE",
      conflicts: inspection.active
    });
  }

  if (inspection.recent.length && req.body.confirm_recent_orders !== true) {
    await logOperationalConflict({
      type: "RECENT_ORDER_WARNING_ADMIN",
      severity: "warning",
      actorUserId: req.session.user.id,
      courierId,
      orders: inspection.recent.map(x => x.order_number),
      details: { recent: inspection.recent }
    });

    return res.status(409).json({
      error: "Pedido utilizado nas últimas 12 horas. Confirme para continuar.",
      code: "RECENT_ORDER_CONFIRMATION",
      recent: recentWarningPayload(inspection.recent)
    });
  }

  const result = await createDispatchTransaction({
    actorUserId: req.session.user.id,
    courierId,
    orders,
    source: "ADMIN",
    adminReason: reason || "Registro manual pelo administrador",
    clientToken
  });

  if (!result.duplicate) {
    await auditBestEffort(req.session.user.id, "MANUAL_DEPARTURE_REGISTERED", "dispatch", result.dispatch.id, {
      courier_id: courierId,
      courier_name: courier.name,
      order_numbers: orders,
      order_count: orders.length,
      reason: reason || "Não informado",
      previous_dispatch_closed: result.closedPrevious?.id || null
    });

    await createNotification({
      type: "MANUAL_DEPARTURE",
      severity: "info",
      title: "Saída manual registrada",
      message: `${courier.name}: ${orders.join(", ")}. Motivo: ${reason || "não informado"}`,
      courierId,
      dispatchId: result.dispatch.id,
      uniqueKey: `manual:${result.dispatch.id}`
    });
  }

  io.emit("dispatch:changed");
  res.status(result.duplicate ? 200 : 201).json({
    dispatch: result.dispatch,
    closed_previous: result.closedPrevious,
    duplicate: result.duplicate,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/notifications", auth, adminOnly, asyncRoute(async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 50, 150);
  const unreadOnly = String(req.query.unread_only || "") === "true";

  const params = [limit];
  const where = unreadOnly ? "WHERE n.read_at IS NULL" : "";

  const rows = (await pool.query(`
    SELECT n.id,n.type,n.severity,n.title,n.message,n.courier_id,n.dispatch_id,
           n.created_at,n.read_at,u.name AS courier_name
    FROM notifications n
    LEFT JOIN users u ON u.id=n.courier_id
    ${where}
    ORDER BY n.created_at DESC,n.id DESC
    LIMIT $1
  `, params)).rows;

  const countQ = await pool.query(
    "SELECT COUNT(*)::int AS unread FROM notifications WHERE read_at IS NULL"
  );

  res.json({
    rows,
    unread: countQ.rows[0].unread,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/notifications/:id/read", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE notifications
    SET read_at=COALESCE(read_at,NOW())
    WHERE id=$1
    RETURNING id,read_at
  `, [req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Notificação não encontrada." });

  io.emit("notification:changed");
  res.json({ notification: q.rows[0] });
}));

app.post("/api/admin/notifications/read-all", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE notifications
    SET read_at=NOW()
    WHERE read_at IS NULL
  `);

  await audit(req.session.user.id, "NOTIFICATIONS_MARKED_READ", "notification", null, {
    count: q.rowCount
  });

  io.emit("notification:changed");
  res.json({ ok: true, count: q.rowCount });
}));

app.get("/api/admin/settings/notifications", auth, adminOnly, asyncRoute(async (req, res) => {
  res.json({
    settings: {
      attention: await notificationEnabled("notify_attention"),
      delayed: await notificationEnabled("notify_delayed"),
      critical: await notificationEnabled("notify_critical"),
      registration: await notificationEnabled("notify_registration"),
      sound: await notificationEnabled("notification_sound")
    }
  });
}));

app.put("/api/admin/settings/notifications", auth, adminOnly, asyncRoute(async (req, res) => {
  const settings = {
    attention: !!req.body.attention,
    delayed: !!req.body.delayed,
    critical: !!req.body.critical,
    registration: !!req.body.registration,
    sound: !!req.body.sound
  };

  await setSetting("notify_attention", settings.attention ? "true" : "false");
  await setSetting("notify_delayed", settings.delayed ? "true" : "false");
  await setSetting("notify_critical", settings.critical ? "true" : "false");
  await setSetting("notify_registration", settings.registration ? "true" : "false");
  await setSetting("notification_sound", settings.sound ? "true" : "false");

  await audit(req.session.user.id, "NOTIFICATION_SETTINGS_UPDATED", "settings", null, settings);

  io.emit("notification:settings-changed");
  res.json({ settings });
}));


app.post("/api/admin/push/configure", auth, adminOnly, asyncRoute(async (req, res) => {
  const subject = `${req.protocol}://${req.get("host")}`;
  const config = await ensureVapidConfig(subject);
  res.json({ publicKey: config.publicKey, subject: config.subject });
}));

app.get("/api/admin/push/status", auth, adminOnly, asyncRoute(async (req, res) => {
  const config = await getVapidConfig();
  const countQ = await pool.query("SELECT COUNT(*)::int AS count FROM push_subscriptions");
  res.json({
    configured: !!config,
    publicKey: config?.publicKey || null,
    subscriptions: countQ.rows[0].count
  });
}));

app.post("/api/admin/push/subscribe", auth, adminOnly, asyncRoute(async (req, res) => {
  const sub = req.body.subscription || {};
  const endpoint = String(sub.endpoint || "");
  const p256dh = String(sub.keys?.p256dh || "");
  const authKey = String(sub.keys?.auth || "");

  if (!endpoint || !p256dh || !authKey) {
    return res.status(400).json({ error: "Assinatura push inválida." });
  }

  await pool.query(`
    INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent,last_seen_at)
    VALUES($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id=EXCLUDED.user_id,
      p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth,
      user_agent=EXCLUDED.user_agent,
      last_seen_at=NOW()
  `, [
    req.session.user.id,
    endpoint,
    p256dh,
    authKey,
    String(req.get("user-agent") || "").slice(0, 300)
  ]);

  await audit(req.session.user.id, "PUSH_SUBSCRIBED", "push", null, {});
  res.json({ ok: true });
}));

app.delete("/api/admin/push/subscribe", auth, adminOnly, asyncRoute(async (req, res) => {
  const endpoint = String(req.body.endpoint || "");
  if (endpoint) await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [endpoint]);
  res.json({ ok: true });
}));


app.get("/api/admin/peak", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    SELECT
      COUNT(o.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '15 minutes')::int AS orders_15,
      COUNT(o.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '30 minutes')::int AS orders_30,
      COUNT(o.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '60 minutes')::int AS orders_60,
      COUNT(DISTINCT d.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '15 minutes')::int AS dispatches_15,
      COUNT(DISTINCT d.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '30 minutes')::int AS dispatches_30,
      COUNT(DISTINCT d.id) FILTER (WHERE d.departed_at >= NOW()-INTERVAL '60 minutes')::int AS dispatches_60
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
  `);

  const team = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE operational='NA_RUA')::int AS on_road,
      COUNT(*) FILTER (WHERE operational='DISPONIVEL')::int AS available,
      COUNT(*) FILTER (WHERE operational='OFFLINE')::int AS offline,
      COUNT(*) FILTER (WHERE operational='INATIVO')::int AS inactive
    FROM (
      SELECT CASE
        WHEN u.active=false THEN 'INATIVO'
        WHEN EXISTS(SELECT 1 FROM dispatches d WHERE d.courier_id=u.id AND d.status='ON_ROAD') THEN 'NA_RUA'
        WHEN p.last_seen_at >= NOW()-INTERVAL '90 seconds' THEN 'DISPONIVEL'
        ELSE 'OFFLINE'
      END AS operational
      FROM users u
      LEFT JOIN user_presence p ON p.user_id=u.id
      WHERE u.role='courier' AND u.approval_status='APPROVED'
    ) x
  `);

  res.json({
    orders: {
      last15: q.rows[0].orders_15,
      last30: q.rows[0].orders_30,
      last60: q.rows[0].orders_60
    },
    dispatches: {
      last15: q.rows[0].dispatches_15,
      last30: q.rows[0].dispatches_30,
      last60: q.rows[0].dispatches_60
    },
    team: team.rows[0],
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/orders/search", auth, adminOnly, asyncRoute(async (req, res) => {
  let q = String(req.query.q || "").trim();
  if (!q) return res.json({ rows: [] });
  if (!q.startsWith("#")) q = "#" + q;

  const rows = (await pool.query(`
    SELECT o.order_number,d.id AS dispatch_id,d.dispatch_code,d.departed_at,
           d.released_at,d.status,d.registration_source,d.admin_reason,
           u.id AS courier_id,u.name AS courier_name,u.username
    FROM dispatch_orders o
    JOIN dispatches d ON d.id=o.dispatch_id
    JOIN users u ON u.id=d.courier_id
    WHERE o.order_number ILIKE $1
    ORDER BY d.departed_at DESC,d.id DESC
    LIMIT 20
  `, [`%${q}%`])).rows;

  res.json({ rows, server_now: new Date().toISOString() });
}));

app.get("/api/admin/conflicts", auth, adminOnly, asyncRoute(async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100, 300);
  const rows = (await pool.query(`
    SELECT c.id,c.conflict_type,c.severity,c.order_numbers,c.details,c.created_at,
           c.resolved_at,au.name AS actor_name,cu.name AS courier_name
    FROM operational_conflicts c
    LEFT JOIN users au ON au.id=c.actor_user_id
    LEFT JOIN users cu ON cu.id=c.courier_id
    ORDER BY c.created_at DESC,c.id DESC
    LIMIT $1
  `, [limit])).rows;

  const counts = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '24 hours')::int AS last24h,
      COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
      COUNT(*) FILTER (WHERE severity='critical' AND created_at >= NOW()-INTERVAL '24 hours')::int AS critical24h
    FROM operational_conflicts
  `)).rows[0];

  res.json({ rows, counts, server_now: new Date().toISOString() });
}));

app.post("/api/admin/conflicts/:id/resolve", auth, adminOnly, asyncRoute(async (req, res) => {
  const q = await pool.query(`
    UPDATE operational_conflicts
    SET resolved_at=COALESCE(resolved_at,NOW()),resolved_by=$1
    WHERE id=$2
    RETURNING id,resolved_at
  `, [req.session.user.id, req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Conflito não encontrado." });
  io.emit("conflict:changed");
  res.json({ conflict: q.rows[0] });
}));


app.get("/api/admin/ifood/status", auth, adminOnly, asyncRoute(async (req, res) => {
  const merchants = (await pool.query(`
    SELECT merchant_id AS id,name,corporate_name,last_seen_at
    FROM ifood_merchants
    ORDER BY name NULLS LAST,merchant_id
  `)).rows;

  const state = (await pool.query(`
    SELECT last_poll_at,last_success_at,last_error,last_error_at,last_event_count,total_events_received
    FROM ifood_sync_state
    WHERE singleton=1
  `)).rows[0] || {};

  const counts = (await pool.query(`
    SELECT
      COUNT(*)::int AS orders,
      COUNT(*) FILTER (WHERE delivered_by='MERCHANT')::int AS merchant_delivery,
      COUNT(*) FILTER (WHERE delivered_by='IFOOD')::int AS ifood_delivery,
      COUNT(*) FILTER (WHERE is_test=true)::int AS test_orders
    FROM ifood_orders
  `)).rows[0];

  const recentOrders = (await pool.query(`
    SELECT order_id,display_id,merchant_id,status,order_type,category,sales_channel,
           delivered_by,is_test,order_created_at,last_event_code,last_event_at,updated_at
    FROM ifood_orders
    ORDER BY COALESCE(last_event_at,updated_at) DESC
    LIMIT 30
  `)).rows;

  res.json({
    configured: ifoodConfigured(),
    autoEnabled: ifoodAutoEnabled(),
    phase: "FASE_1_SEM_DISPATCH",
    tokenCached: Boolean(
      ifoodTokenCache.accessToken &&
      ifoodTokenCache.expiresAt > Date.now() + 60_000
    ),
    syncing: ifoodSyncRunning,
    merchants,
    state,
    counts,
    recentOrders,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/ifood/test-connection", auth, adminOnly, asyncRoute(async (req, res) => {
  if (!ifoodConfigured()) {
    return res.status(503).json({
      error: "IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não estão configurados."
    });
  }

  const merchants = await fetchAndStoreIfoodMerchants();

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_CONNECTION_TESTED",
    "ifood",
    null,
    { merchants: merchants.length }
  );

  res.json({
    ok: true,
    connected: true,
    merchants,
    message: `${merchants.length} loja(s) acessível(is) com as credenciais configuradas.`
  });
}));

app.post("/api/admin/ifood/sync-now", auth, adminOnly, asyncRoute(async (req, res) => {
  if (!ifoodConfigured()) {
    return res.status(503).json({
      error: "Credenciais do iFood não configuradas."
    });
  }

  const result = await syncIfoodOnce({ reason: "admin_manual" });

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_MANUAL_SYNC",
    "ifood",
    null,
    result
  );

  io.emit("ifood:changed");
  res.json(result);
}));

app.get("/api/admin/monitoring", auth, adminOnly, asyncRoute(async (req, res) => {
  const dbStart = Date.now();
  await pool.query("SELECT 1");
  const dbLatencyMs = Date.now() - dbStart;

  const errorQ = await pool.query(`
    SELECT id,request_id,method,path,status_code,message,created_at
    FROM system_errors
    ORDER BY created_at DESC,id DESC
    LIMIT 50
  `);

  const countsQ = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '1 hour')::int AS errors_hour,
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '24 hours')::int AS errors_day
    FROM system_errors
  `);

  const dispatchQ = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '1 hour')::int AS dispatches_hour,
      COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '24 hours')::int AS dispatches_day
    FROM dispatches
  `);

  res.json({
    version: VERSION,
    dbLatencyMs,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: Number(process.env.DB_POOL_MAX || 20)
    },
    activity: dispatchQ.rows[0],
    errors: countsQ.rows[0],
    recentErrors: errorQ.rows,
    server_now: new Date().toISOString()
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
      EXISTS(SELECT 1 FROM dispatches d2 WHERE d2.courier_id=u.id AND d2.status='ON_ROAD') AS on_road,
      p.last_seen_at,
      (p.last_seen_at >= NOW()-INTERVAL '90 seconds') AS is_online,
      (SELECT MAX(d3.departed_at) FROM dispatches d3 WHERE d3.courier_id=u.id) AS last_departure,
      CASE
        WHEN u.active=false THEN 'INATIVO'
        WHEN EXISTS(SELECT 1 FROM dispatches d4 WHERE d4.courier_id=u.id AND d4.status='ON_ROAD') THEN 'NA_RUA'
        WHEN p.last_seen_at >= NOW()-INTERVAL '90 seconds' THEN 'DISPONIVEL'
        ELSE 'OFFLINE'
      END AS operational_status
    FROM users u
    LEFT JOIN user_presence p ON p.user_id=u.id
    WHERE u.role='courier'
    ORDER BY
      CASE u.approval_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 2 ELSE 1 END,
      CASE
        WHEN u.active=false THEN 4
        WHEN EXISTS(SELECT 1 FROM dispatches d4 WHERE d4.courier_id=u.id AND d4.status='ON_ROAD') THEN 1
        WHEN p.last_seen_at >= NOW()-INTERVAL '90 seconds' THEN 2
        ELSE 3
      END,
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

app.get("/api/live", (req, res) => {
  res.json({ ok: true, version: VERSION, time: new Date().toISOString() });
});

app.get("/api/health", async (req, res) => {
  try {
    const started = Date.now();
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      database: "connected",
      dbLatencyMs: Date.now() - started,
      time: new Date().toISOString(),
      version: VERSION
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      database: "unavailable",
      time: new Date().toISOString(),
      version: VERSION
    });
  }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", socket => {
  socket.emit("server:time", { now: new Date().toISOString() });
});

setInterval(() => io.emit("server:time", { now: new Date().toISOString() }), 1000);

setInterval(checkTimeNotifications, 30 * 1000);
setTimeout(checkTimeNotifications, 5000);

// iFood Fase 1: polling automático somente quando IFOOD_ENABLED=true.
// Com false, nenhuma chamada automática ao iFood é feita.
setInterval(() => {
  if (!ifoodAutoEnabled() || !ifoodConfigured()) return;

  syncIfoodOnce({ reason: "automatic_30s" })
    .then(result => {
      if (result.events > 0) io.emit("ifood:changed");
    })
    .catch(err => {
      console.error("iFood automatic sync:", ifoodSafeError(err));
    });
}, 30 * 1000);

setTimeout(() => {
  if (!ifoodAutoEnabled() || !ifoodConfigured()) return;

  syncIfoodOnce({ reason: "automatic_startup" })
    .then(result => {
      if (result.events > 0) io.emit("ifood:changed");
    })
    .catch(err => {
      console.error("iFood startup sync:", ifoodSafeError(err));
    });
}, 8000);

setTimeout(() => {
  createNotification({
    type: "SYSTEM_STARTED",
    severity: "info",
    title: "DespachaMoto online",
    message: `Servidor v${VERSION} iniciado e conectado.`,
    uniqueKey: `system-start:${Date.now()}`
  }).catch(() => {});
}, 2500);


app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`[${req.requestId || "-"}]`, err);
  recordSystemError(req, status, err).catch(() => {});
  res.status(status).json({
    error: err.message || "Erro interno do servidor.",
    request_id: req.requestId || null
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`DespachaMoto ${VERSION} rodando na porta ${port}`));

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: encerrando DespachaMoto com segurança...`);

  const force = setTimeout(() => {
    console.error("Shutdown forçado após timeout.");
    process.exit(1);
  }, 10000);
  force.unref();

  server.close(async () => {
    try {
      await pool.end();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

