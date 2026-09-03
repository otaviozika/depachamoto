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
const VERSION = "3.5.6";

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

const deliveryCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: req => `${req.session?.user?.id || "anon"}:${String(req.params?.orderId || "")}`,
  message: {
    error: "Muitas tentativas de confirmação para este pedido. Aguarde alguns minutos e tente novamente.",
    code: "DELIVERY_CODE_RATE_LIMIT"
  }
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

ALTER TABLE users
ADD COLUMN IF NOT EXISTS nickname TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_key TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_type TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_holder_name TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_status TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_verified_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS pix_updated_at TIMESTAMPTZ;

UPDATE users
SET pix_status='VERIFIED',
    pix_verified_at=COALESCE(pix_verified_at,NOW()),
    pix_updated_at=COALESCE(pix_updated_at,NOW())
WHERE role='courier'
  AND pix_key IS NOT NULL
  AND BTRIM(pix_key)<>''
  AND COALESCE(pix_status,'NONE')='NONE';

CREATE TABLE IF NOT EXISTS courier_pix_history (
  id BIGSERIAL PRIMARY KEY,
  courier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pix_key TEXT,
  pix_type TEXT,
  pix_holder_name TEXT,
  pix_status TEXT NOT NULL,
  source TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS courier_pix_history_courier_idx
ON courier_pix_history(courier_id,changed_at DESC);

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

-- v2.7: ciclo operacional da rota e snapshots de SLA.
-- Mantemos status ON_ROAD/RELEASED para compatibilidade com todas as versões anteriores.
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS operational_stage TEXT NOT NULL DEFAULT 'EN_ROUTE';
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS returning_at TIMESTAMPTZ;
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS returned_by INTEGER REFERENCES users(id);
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS return_source TEXT;
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS return_reason TEXT;

-- v2.8: check-in obrigatório de chegada. A origem e o motivo da chegada
-- ficam separados do início do retorno para auditoria operacional.
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS arrival_source TEXT;
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS arrival_reason TEXT;

ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS route_sla_minutes INTEGER;
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS return_sla_minutes INTEGER;

-- Histórico antigo continua válido: saídas já liberadas são consideradas concluídas.
UPDATE dispatches
SET operational_stage='COMPLETED',
    returned_at=COALESCE(returned_at,released_at),
    return_source=COALESCE(return_source,'LEGACY')
WHERE status='RELEASED' AND operational_stage<>'COMPLETED';

CREATE INDEX IF NOT EXISTS dispatches_active_stage_idx
ON dispatches(operational_stage,departed_at DESC) WHERE status='ON_ROAD';

-- v2.8: se a base estiver consistente, reforça no próprio PostgreSQL que um
-- motoboy só pode ter uma saída ativa. Se houver legado inconsistente, o deploy
-- não falha: o advisory lock continua protegendo novas saídas até a correção.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='dispatches_one_active_per_courier_idx'
  ) AND NOT EXISTS (
    SELECT courier_id
    FROM dispatches
    WHERE status='ON_ROAD'
    GROUP BY courier_id
    HAVING COUNT(*)>1
  ) THEN
    CREATE UNIQUE INDEX dispatches_one_active_per_courier_idx
    ON dispatches(courier_id) WHERE status='ON_ROAD';
  END IF;
END $$;

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

-- v3.0: presença diária. O registro é por motoboy e por data da operação
-- em São Paulo. Check-in via QR ou lançamento manual do Admin.
CREATE TABLE IF NOT EXISTS courier_attendance (
  id BIGSERIAL PRIMARY KEY,
  courier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checkin_method TEXT NOT NULL DEFAULT 'QR',
  checked_in_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_reason TEXT,
  checked_out_at TIMESTAMPTZ,
  checked_out_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checkout_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(courier_id,attendance_date)
);

ALTER TABLE courier_attendance
ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;
ALTER TABLE courier_attendance
ADD COLUMN IF NOT EXISTS checked_out_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE courier_attendance
ADD COLUMN IF NOT EXISTS checkout_reason TEXT;

CREATE INDEX IF NOT EXISTS courier_attendance_date_idx
ON courier_attendance(attendance_date,checked_in_at);

CREATE INDEX IF NOT EXISTS courier_attendance_courier_idx
ON courier_attendance(courier_id,attendance_date DESC);

-- Backfill de compatibilidade: para dias anteriores à v3.0, quem teve saída
-- registrada naquele dia é marcado como presença inferida. Isso preserva o
-- histórico nos relatórios sem inventar um horário anterior à primeira saída.
INSERT INTO courier_attendance(
  courier_id,attendance_date,checked_in_at,checkin_method
)
SELECT
  d.courier_id,
  (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date,
  MIN(d.departed_at),
  'LEGACY_INFERRED'
FROM dispatches d
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings s
  WHERE s.setting_key='attendance_legacy_backfill_v3'
)
GROUP BY d.courier_id,(d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
ON CONFLICT(courier_id,attendance_date) DO NOTHING;

INSERT INTO app_settings(setting_key,setting_value)
VALUES('attendance_legacy_backfill_v3','done')
ON CONFLICT(setting_key) DO NOTHING;

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


CREATE TABLE IF NOT EXISTS payment_rate_rules (
  id BIGSERIAL PRIMARY KEY,
  effective_from DATE NOT NULL UNIQUE,
  per_delivery NUMERIC(12,2) NOT NULL CHECK (per_delivery >= 0),
  base_mon_thu NUMERIC(12,2) NOT NULL CHECK (base_mon_thu >= 0),
  base_fri_sun NUMERIC(12,2) NOT NULL CHECK (base_fri_sun >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courier_payments (
  id BIGSERIAL PRIMARY KEY,
  payment_date DATE NOT NULL,
  courier_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tip_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  adjustment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED','PAID')),
  notes TEXT,
  delivery_count_snapshot INTEGER,
  per_delivery_snapshot NUMERIC(12,2),
  base_snapshot NUMERIC(12,2),
  total_snapshot NUMERIC(12,2),
  pix_key_snapshot TEXT,
  pix_type_snapshot TEXT,
  pix_holder_name_snapshot TEXT,
  pix_status_snapshot TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(payment_date,courier_id)
);

ALTER TABLE courier_payments
ADD COLUMN IF NOT EXISTS pix_holder_name_snapshot TEXT;

ALTER TABLE courier_payments
ADD COLUMN IF NOT EXISTS pix_status_snapshot TEXT;

CREATE INDEX IF NOT EXISTS courier_payments_date_idx
ON courier_payments(payment_date DESC);

CREATE INDEX IF NOT EXISTS courier_payments_courier_idx
ON courier_payments(courier_id,payment_date DESC);

CREATE INDEX IF NOT EXISTS courier_payments_status_idx
ON courier_payments(status,payment_date DESC);

INSERT INTO payment_rate_rules(
  effective_from,per_delivery,base_mon_thu,base_fri_sun
)
VALUES('2000-01-01',6.00,60.00,75.00)
ON CONFLICT(effective_from) DO NOTHING;

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
  order_timing TEXT,
  category TEXT,
  sales_channel TEXT,
  delivered_by TEXT,
  is_test BOOLEAN,
  order_created_at TIMESTAMPTZ,
  preparation_start_at TIMESTAMPTZ,
  last_event_code TEXT,
  last_event_at TIMESTAMPTZ,
  payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ifood_orders
ADD COLUMN IF NOT EXISTS order_timing TEXT;

ALTER TABLE ifood_orders
ADD COLUMN IF NOT EXISTS preparation_start_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ifood_preparation_times (
  merchant_id TEXT PRIMARY KEY REFERENCES ifood_merchants(merchant_id) ON DELETE CASCADE,
  preparation_time_minutes INTEGER,
  source TEXT NOT NULL DEFAULT 'IFOOD_MY_PREPARATION_TIME',
  synced_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ifood_preparation_times_updated_idx
ON ifood_preparation_times(updated_at DESC);

CREATE INDEX IF NOT EXISTS ifood_orders_display_idx
ON ifood_orders(display_id);

CREATE INDEX IF NOT EXISTS ifood_orders_updated_idx
ON ifood_orders(updated_at DESC);

CREATE TABLE IF NOT EXISTS ifood_dispatch_links (
  ifood_order_id TEXT PRIMARY KEY REFERENCES ifood_orders(order_id) ON DELETE RESTRICT,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  local_order_number TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ifood_dispatch_status TEXT NOT NULL DEFAULT 'NOT_SENT'
);

CREATE INDEX IF NOT EXISTS ifood_dispatch_links_dispatch_idx
ON ifood_dispatch_links(dispatch_id);

CREATE TABLE IF NOT EXISTS ifood_dispatch_jobs (
  ifood_order_id TEXT PRIMARY KEY
    REFERENCES ifood_dispatch_links(ifood_order_id) ON DELETE CASCADE,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  last_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ifood_dispatch_jobs_ready_idx
ON ifood_dispatch_jobs(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS ifood_delivery_confirmations (
  ifood_order_id TEXT PRIMARY KEY REFERENCES ifood_orders(order_id) ON DELETE CASCADE,
  dispatch_id BIGINT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  courier_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  processing_started_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT,
  last_response JSONB,
  verified_at TIMESTAMPTZ,
  concluded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ifood_delivery_confirmations_courier_idx
ON ifood_delivery_confirmations(courier_id,updated_at DESC);

CREATE INDEX IF NOT EXISTS ifood_delivery_confirmations_status_idx
ON ifood_delivery_confirmations(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS ifood_runtime_control (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton=1),
  dispatch_paused BOOLEAN NOT NULL DEFAULT FALSE,
  pause_reason TEXT,
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ifood_runtime_control(singleton,dispatch_paused)
VALUES(1,FALSE)
ON CONFLICT(singleton) DO NOTHING;

INSERT INTO ifood_dispatch_jobs(
  ifood_order_id,dispatch_id,status,next_attempt_at,accepted_at
)
SELECT
  l.ifood_order_id,
  l.dispatch_id,
  CASE
    WHEN UPPER(COALESCE(o.status,'')) IN ('DISPATCHED','CONCLUDED','DELIVERED')
      THEN 'SENT'
    ELSE 'PENDING'
  END,
  NOW(),
  CASE
    WHEN UPPER(COALESCE(o.status,'')) IN ('DISPATCHED','CONCLUDED','DELIVERED')
      THEN NOW()
    ELSE NULL
  END
FROM ifood_dispatch_links l
JOIN ifood_orders o ON o.order_id=l.ifood_order_id
WHERE UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
ON CONFLICT(ifood_order_id) DO NOTHING;

UPDATE ifood_dispatch_links l
SET ifood_dispatch_status = CASE
  WHEN UPPER(COALESCE(o.status,''))='DISPATCHED' THEN 'DISPATCHED'
  WHEN UPPER(COALESCE(o.status,'')) IN ('CONCLUDED','DELIVERED') THEN 'CONCLUDED'
  WHEN j.status='SENT' THEN 'API_ACCEPTED'
  WHEN j.status IN ('PENDING','RETRY','PROCESSING') THEN 'PENDING'
  WHEN j.status='FAILED' THEN 'FAILED'
  ELSE l.ifood_dispatch_status
END
FROM ifood_orders o
LEFT JOIN ifood_dispatch_jobs j ON j.ifood_order_id=o.order_id
WHERE l.ifood_order_id=o.order_id;

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

-- v2.1.2: corrige registros em que evento não pertencente ao ciclo
-- principal foi salvo indevidamente como status.
-- Usa subquery correlacionada no SET (compatível com PostgreSQL em UPDATE).
UPDATE ifood_orders o
SET status = (
      SELECT e.full_code
      FROM ifood_events e
      WHERE e.order_id=o.order_id
        AND UPPER(COALESCE(e.full_code,'')) IN (
          'PLACED','CONFIRMED','PREPARATION_STARTED',
          'SEPARATION_STARTED','SEPARATION_ENDED','READY_TO_PICKUP',
          'DISPATCHED','CONCLUDED','CANCELLED','DELIVERED'
        )
      ORDER BY e.event_created_at DESC NULLS LAST,e.received_at DESC
      LIMIT 1
    ),
    updated_at = NOW()
WHERE (
    o.status IS NULL
    OR UPPER(o.status) NOT IN (
      'PLACED','CONFIRMED','PREPARATION_STARTED',
      'SEPARATION_STARTED','SEPARATION_ENDED','READY_TO_PICKUP',
      'DISPATCHED','CONCLUDED','CANCELLED','DELIVERED'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM ifood_events e
    WHERE e.order_id=o.order_id
      AND UPPER(COALESCE(e.full_code,'')) IN (
        'PLACED','CONFIRMED','PREPARATION_STARTED',
        'SEPARATION_STARTED','SEPARATION_ENDED','READY_TO_PICKUP',
        'DISPATCHED','CONCLUDED','CANCELLED','DELIVERED'
      )
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
  ('route_sla_1_minutes','25'),
  ('route_sla_2_minutes','30'),
  ('route_sla_3_minutes','35'),
  ('route_sla_4_minutes','40'),
  ('route_sla_5_minutes','45'),
  ('return_sla_minutes','15'),
  ('sla_critical_over_minutes','15'),
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

async function auth(req, res, next) {
  const sessionUser = req.session.user;
  if (!sessionUser) {
    return res.status(401).json({ error: "Não autenticado.", code: "SESSION_EXPIRED" });
  }

  // Contas de motoboy excluídas ou desativadas perdem acesso imediatamente,
  // inclusive quando já havia uma sessão aberta em outro aparelho.
  if (sessionUser.role === "courier") {
    const account = (await pool.query(
      "SELECT active,approval_status FROM users WHERE id=$1 AND role='courier'",
      [sessionUser.id]
    )).rows[0];

    if (!account || !account.active || account.approval_status !== "APPROVED") {
      await new Promise(resolve => req.session.destroy(() => resolve()));
      return res.status(401).json({
        error: "Este acesso de motoboy não está mais ativo.",
        code: "SESSION_EXPIRED"
      });
    }
  }

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
    "SELECT id,name,username,role,active,approval_status,must_change_password,password_hash,nickname,pix_key,pix_type,pix_holder_name,pix_status,pix_verified_at,pix_verified_by,pix_updated_at FROM users WHERE id=$1",
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

function ifoodDispatchEnabled() {
  return String(process.env.IFOOD_DISPATCH_ENABLED || "false").toLowerCase() === "true";
}

function ifoodEnvironment() {
  const value = String(process.env.IFOOD_ENVIRONMENT || "test").trim().toLowerCase();
  return value === "production" ? "production" : "test";
}

function ifoodCustomerId() {
  return String(process.env.IFOOD_CUSTOMER_ID || "").trim();
}

function ifoodPrimaryMerchantId() {
  return String(process.env.IFOOD_MERCHANT_ID || "").trim();
}

function ifoodPreparationTimeConfigured() {
  return Boolean(ifoodConfigured() && ifoodCustomerId());
}

function ifoodAllowedMerchantIds() {
  const primary = ifoodPrimaryMerchantId();

  // Quando IFOOD_MERCHANT_ID está definido, ele é a trava principal da instância.
  // Isso evita que uma allowlist antiga de sandbox libere outra loja por acidente.
  if (primary) return [primary];

  return [...new Set(
    String(process.env.IFOOD_ALLOWED_MERCHANT_IDS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
  )];
}

function ifoodMerchantAllowed(merchantId) {
  const id = String(merchantId || "").trim();
  const allowed = ifoodAllowedMerchantIds();

  // No ambiente de teste, lista vazia mantém compatibilidade com a loja sandbox.
  if (ifoodEnvironment() === "test" && allowed.length === 0) return true;

  // Em produção a allowlist é obrigatória.
  if (!id || allowed.length === 0) return false;
  return allowed.includes(id);
}

function ifoodProductionSafetyReady() {
  if (ifoodEnvironment() !== "production") return true;
  return ifoodAllowedMerchantIds().length > 0;
}

async function getIfoodRuntimeControl() {
  const row = (await pool.query(`
    SELECT
      c.dispatch_paused,c.pause_reason,c.changed_at,c.changed_by,
      u.name AS changed_by_name
    FROM ifood_runtime_control c
    LEFT JOIN users u ON u.id=c.changed_by
    WHERE c.singleton=1
  `)).rows[0];

  return row || {
    dispatch_paused: false,
    pause_reason: null,
    changed_at: null,
    changed_by: null,
    changed_by_name: null
  };
}

async function ifoodAutomaticDispatchAllowed() {
  if (!ifoodConfigured()) return { allowed: false, reason: "credentials_missing" };
  if (!ifoodDispatchEnabled()) return { allowed: false, reason: "env_flag_disabled" };
  if (!ifoodProductionSafetyReady()) return { allowed: false, reason: "production_allowlist_missing" };

  const control = await getIfoodRuntimeControl();
  if (control.dispatch_paused) {
    return { allowed: false, reason: "runtime_paused", control };
  }

  return { allowed: true, reason: "ok", control };
}

function ifoodSafeError(err) {
  const raw = String(err?.message || err || "Erro desconhecido.");
  return raw
    .replace(String(process.env.IFOOD_CLIENT_SECRET || ""), "[SECRET]")
    .replace(String(process.env.IFOOD_CLIENT_ID || ""), "[CLIENT_ID]")
    .replace(String(process.env.IFOOD_CUSTOMER_ID || ""), "[CUSTOMER_ID]")
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


let ifoodDispatchWorkerRunning = false;

function ifoodDispatchBackoffSeconds(attempts) {
  const schedule = [5, 15, 30, 60, 120, 300, 600, 900];
  return schedule[Math.min(Math.max(Number(attempts || 1) - 1, 0), schedule.length - 1)];
}

function ifoodDispatchRetryableError(err) {
  const status = Number(err?.statusCode || 0);
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function ifoodDispatchErrorText(err) {
  let text = ifoodSafeError(err);
  if (err?.ifoodBody) {
    try {
      const body = typeof err.ifoodBody === "string"
        ? err.ifoodBody
        : JSON.stringify(err.ifoodBody);
      text += ` | ${body}`;
    } catch {}
  }
  return text.slice(0, 900);
}

async function ensureIfoodDispatchJob(orderId) {
  await pool.query(`
    INSERT INTO ifood_dispatch_jobs(ifood_order_id,dispatch_id,status,next_attempt_at)
    SELECT l.ifood_order_id,l.dispatch_id,'PENDING',NOW()
    FROM ifood_dispatch_links l
    JOIN ifood_orders o ON o.order_id=l.ifood_order_id
    WHERE l.ifood_order_id=$1
      AND UPPER(COALESCE(o.order_type,''))='DELIVERY'
      AND UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
    ON CONFLICT(ifood_order_id) DO NOTHING
  `, [String(orderId)]);
}

async function resetStaleIfoodDispatchJobs() {
  await pool.query(`
    UPDATE ifood_dispatch_jobs SET
      status='RETRY',
      locked_at=NULL,
      next_attempt_at=NOW(),
      last_error=COALESCE(last_error,'Processamento anterior interrompido; nova tentativa liberada.'),
      updated_at=NOW()
    WHERE status='PROCESSING'
      AND locked_at < NOW() - INTERVAL '3 minutes'
  `);
}

async function claimIfoodDispatchJob(orderId = null) {
  const params = [];
  let specific = "";

  if (orderId) {
    params.push(String(orderId));
    specific = `AND j.ifood_order_id=$${params.length}`;
  }

  const q = await pool.query(`
    WITH candidate AS (
      SELECT j.ifood_order_id
      FROM ifood_dispatch_jobs j
      JOIN ifood_orders o ON o.order_id=j.ifood_order_id
      WHERE j.status IN ('PENDING','RETRY')
        AND j.next_attempt_at<=NOW()
        AND UPPER(COALESCE(o.order_type,''))='DELIVERY'
        AND UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
        ${specific}
      ORDER BY j.next_attempt_at,j.created_at
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    UPDATE ifood_dispatch_jobs j SET
      status='PROCESSING',
      attempts=j.attempts+1,
      locked_at=NOW(),
      updated_at=NOW()
    FROM candidate c
    WHERE j.ifood_order_id=c.ifood_order_id
    RETURNING j.*
  `, params);

  return q.rows[0] || null;
}

async function markIfoodDispatchDone(orderId, lifecycleStatus = null) {
  const linkStatus = lifecycleStatus === "DISPATCHED"
    ? "DISPATCHED"
    : ["CONCLUDED","DELIVERED"].includes(lifecycleStatus)
      ? "CONCLUDED"
      : "API_ACCEPTED";

  await pool.query(`
    UPDATE ifood_dispatch_jobs SET
      status='SENT',
      accepted_at=COALESCE(accepted_at,NOW()),
      locked_at=NULL,
      last_error=NULL,
      updated_at=NOW()
    WHERE ifood_order_id=$1
  `, [String(orderId)]);

  await pool.query(`
    UPDATE ifood_dispatch_links
    SET ifood_dispatch_status=$2
    WHERE ifood_order_id=$1
  `, [String(orderId), linkStatus]);

  return { ok: true, alreadyDone: true, orderId: String(orderId), lifecycleStatus, linkStatus };
}

async function failIfoodDispatchJob(orderId, reason, httpStatus = null) {
  await pool.query(`
    UPDATE ifood_dispatch_jobs SET
      status='FAILED',
      locked_at=NULL,
      last_http_status=$2,
      last_error=$3,
      updated_at=NOW()
    WHERE ifood_order_id=$1
  `, [String(orderId), httpStatus, String(reason).slice(0, 900)]);

  await pool.query(`
    UPDATE ifood_dispatch_links
    SET ifood_dispatch_status='FAILED'
    WHERE ifood_order_id=$1
  `, [String(orderId)]);

  io.emit("ifood:changed");
  return { ok: false, failed: true, orderId: String(orderId), error: String(reason) };
}

async function processClaimedIfoodDispatchJob(job, { manualTest = false } = {}) {
  if (!job) return { ok: true, skipped: true, reason: "no_job" };

  const data = (await pool.query(`
    SELECT
      j.ifood_order_id,j.dispatch_id,j.status,j.attempts,
      o.display_id,o.merchant_id,o.status AS order_status,o.order_type,o.delivered_by,o.is_test,
      l.local_order_number,l.ifood_dispatch_status,
      d.departed_at,u.name AS courier_name
    FROM ifood_dispatch_jobs j
    JOIN ifood_orders o ON o.order_id=j.ifood_order_id
    JOIN ifood_dispatch_links l ON l.ifood_order_id=j.ifood_order_id
    JOIN dispatches d ON d.id=j.dispatch_id
    JOIN users u ON u.id=d.courier_id
    WHERE j.ifood_order_id=$1
    LIMIT 1
  `, [job.ifood_order_id])).rows[0];

  if (!data) {
    return failIfoodDispatchJob(job.ifood_order_id, "Vínculo iFood/local não encontrado.");
  }

  if (manualTest && data.is_test !== true) {
    await pool.query(`
      UPDATE ifood_dispatch_jobs SET status='PENDING',locked_at=NULL,updated_at=NOW()
      WHERE ifood_order_id=$1 AND status='PROCESSING'
    `, [job.ifood_order_id]);

    const err = new Error("Despacho controlado permitido somente para pedido de teste.");
    err.status = 403;
    throw err;
  }

  if (String(data.order_type || "").toUpperCase() !== "DELIVERY") {
    return failIfoodDispatchJob(job.ifood_order_id, "Pedido iFood não é DELIVERY.", 422);
  }

  if (String(data.delivered_by || "").toUpperCase() !== "MERCHANT") {
    return failIfoodDispatchJob(job.ifood_order_id, "Pedido não é de entrega própria (MERCHANT).", 422);
  }

  if (!ifoodMerchantAllowed(data.merchant_id)) {
    return failIfoodDispatchJob(
      job.ifood_order_id,
      "Loja iFood bloqueada pela proteção IFOOD_ALLOWED_MERCHANT_IDS.",
      403
    );
  }

  const lifecycle = canonicalIfoodOrderStatus(data.order_status);

  if (["DISPATCHED","CONCLUDED","DELIVERED"].includes(lifecycle)) {
    return markIfoodDispatchDone(job.ifood_order_id, lifecycle);
  }

  if (lifecycle === "CANCELLED") {
    return failIfoodDispatchJob(job.ifood_order_id, "Pedido cancelado no iFood antes do despacho.", 409);
  }

  if (![
    "CONFIRMED","READY_TO_PICKUP","PREPARATION_STARTED",
    "SEPARATION_STARTED","SEPARATION_ENDED"
  ].includes(lifecycle)) {
    return failIfoodDispatchJob(
      job.ifood_order_id,
      `Status ${lifecycle} não permite despacho de entrega própria neste momento.`,
      409
    );
  }

  try {
    const { response, body } = await ifoodApi(
      `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(job.ifood_order_id)}/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveredBy: "MERCHANT" })
      }
    );

    await pool.query(`
      UPDATE ifood_dispatch_jobs SET
        status='SENT',
        locked_at=NULL,
        accepted_at=NOW(),
        last_http_status=$2,
        last_error=NULL,
        last_response=$3,
        updated_at=NOW()
      WHERE ifood_order_id=$1
    `, [
      job.ifood_order_id,
      response.status,
      JSON.stringify(body || { status: "ACCEPTED" })
    ]);

    await pool.query(`
      UPDATE ifood_dispatch_links
      SET ifood_dispatch_status='API_ACCEPTED'
      WHERE ifood_order_id=$1
    `, [job.ifood_order_id]);

    await createNotification({
      type: "IFOOD_DISPATCH_ACCEPTED",
      severity: "info",
      title: "iFood recebeu o despacho",
      message: `#${data.display_id || data.local_order_number} • ${data.courier_name}`,
      dispatchId: data.dispatch_id,
      uniqueKey: `ifood-dispatch-accepted:${job.ifood_order_id}`
    }).catch(() => {});

    io.emit("ifood:changed");

    return {
      ok: true,
      accepted: true,
      orderId: job.ifood_order_id,
      displayId: data.display_id,
      httpStatus: response.status
    };
  } catch (err) {
    const attempts = Number(job.attempts || 1);

    if (Number(err?.statusCode || 0) === 409) {
      try {
        const current = await fetchIfoodOrderDetails(job.ifood_order_id);
        const currentStatus = normalizeIfoodLifecycleStatus(current?.status);
        if (["DISPATCHED","CONCLUDED","DELIVERED"].includes(currentStatus)) {
          return markIfoodDispatchDone(job.ifood_order_id, currentStatus);
        }
      } catch {}
    }

    if (ifoodDispatchRetryableError(err) && attempts < 8) {
      const backoff = ifoodDispatchBackoffSeconds(attempts);
      const errorText = ifoodDispatchErrorText(err);

      await pool.query(`
        UPDATE ifood_dispatch_jobs SET
          status='RETRY',
          locked_at=NULL,
          next_attempt_at=NOW()+($2::int * INTERVAL '1 second'),
          last_http_status=$3,
          last_error=$4,
          updated_at=NOW()
        WHERE ifood_order_id=$1
      `, [job.ifood_order_id, backoff, err?.statusCode || null, errorText]);

      await pool.query(`
        UPDATE ifood_dispatch_links
        SET ifood_dispatch_status='RETRY'
        WHERE ifood_order_id=$1
      `, [job.ifood_order_id]);

      io.emit("ifood:changed");

      return {
        ok: false,
        retry: true,
        orderId: job.ifood_order_id,
        attempts,
        retryInSeconds: backoff,
        error: errorText
      };
    }

    return failIfoodDispatchJob(
      job.ifood_order_id,
      ifoodDispatchErrorText(err),
      err?.statusCode || null
    );
  }
}

async function processIfoodDispatchByOrder(orderId, options = {}) {
  const id = String(orderId);
  await ensureIfoodDispatchJob(id);

  const existing = (await pool.query(`
    SELECT j.status,j.accepted_at,o.status AS order_status
    FROM ifood_dispatch_jobs j
    JOIN ifood_orders o ON o.order_id=j.ifood_order_id
    WHERE j.ifood_order_id=$1
  `, [id])).rows[0];

  if (!existing) {
    const err = new Error("Pedido não possui vínculo de saída local.");
    err.status = 409;
    throw err;
  }

  const lifecycle = canonicalIfoodOrderStatus(existing.order_status);
  if (existing.status === "SENT" || ["DISPATCHED","CONCLUDED","DELIVERED"].includes(lifecycle)) {
    return markIfoodDispatchDone(id, lifecycle);
  }

  if (existing.status === "PROCESSING") {
    return { ok: true, skipped: true, reason: "already_processing" };
  }

  if (existing.status === "FAILED") {
    await pool.query(`
      UPDATE ifood_dispatch_jobs SET
        status='RETRY',locked_at=NULL,next_attempt_at=NOW(),updated_at=NOW()
      WHERE ifood_order_id=$1
    `, [id]);
  }

  const job = await claimIfoodDispatchJob(id);
  if (!job) return { ok: true, skipped: true, reason: "job_not_available" };

  return processClaimedIfoodDispatchJob(job, options);
}

async function runIfoodDispatchWorkerOnce() {
  if (ifoodDispatchWorkerRunning) return;

  const gate = await ifoodAutomaticDispatchAllowed();
  if (!gate.allowed) return;

  ifoodDispatchWorkerRunning = true;
  try {
    await resetStaleIfoodDispatchJobs();

    for (let i = 0; i < 5; i++) {
      const job = await claimIfoodDispatchJob();
      if (!job) break;

      await processClaimedIfoodDispatchJob(job).catch(err => {
        console.error("iFood dispatch worker:", ifoodDispatchErrorText(err));
      });
    }
  } finally {
    ifoodDispatchWorkerRunning = false;
  }
}


async function fetchIfoodMerchantOperationalData(merchantId) {
  const id = String(merchantId || "").trim();
  if (!id) return null;

  const [detailsResult, statusResult] = await Promise.allSettled([
    ifoodApi(`${IFOOD_MERCHANT_BASE}/merchants/${encodeURIComponent(id)}`),
    ifoodApi(`${IFOOD_MERCHANT_BASE}/merchants/${encodeURIComponent(id)}/status`)
  ]);

  return {
    merchantId: id,
    allowed: ifoodMerchantAllowed(id),
    details:
      detailsResult.status === "fulfilled"
        ? detailsResult.value.body
        : null,
    status:
      statusResult.status === "fulfilled"
        ? statusResult.value.body
        : null,
    detailsError:
      detailsResult.status === "rejected"
        ? ifoodSafeError(detailsResult.reason)
        : null,
    statusError:
      statusResult.status === "rejected"
        ? ifoodSafeError(statusResult.reason)
        : null
  };
}

async function upsertConfiguredIfoodMerchant(merchantId, {
  name = null,
  corporateName = null,
  payload = null
} = {}) {
  const id = String(merchantId || "").trim();
  if (!id) return null;

  await pool.query(`
    INSERT INTO ifood_merchants(merchant_id,name,corporate_name,payload,last_seen_at)
    VALUES($1,$2,$3,$4,NOW())
    ON CONFLICT(merchant_id) DO UPDATE SET
      name=COALESCE(EXCLUDED.name,ifood_merchants.name),
      corporate_name=COALESCE(EXCLUDED.corporate_name,ifood_merchants.corporate_name),
      payload=COALESCE(EXCLUDED.payload,ifood_merchants.payload),
      last_seen_at=NOW()
  `, [
    id,
    name,
    corporateName,
    payload ? JSON.stringify(payload) : null
  ]);

  return (await pool.query(`
    SELECT merchant_id AS id,name,corporate_name AS "corporateName",last_seen_at
    FROM ifood_merchants
    WHERE merchant_id=$1
  `, [id])).rows[0] || {
    id,
    name: null,
    corporateName: null
  };
}

async function fetchAndStoreIfoodMerchants() {
  const { body } = await ifoodApi(`${IFOOD_MERCHANT_BASE}/merchants?page=1&size=100`);
  const merchants = Array.isArray(body) ? body : (body?.merchants || body?.content || []);

  for (const merchant of merchants) {
    if (!merchant?.id) continue;

    await upsertConfiguredIfoodMerchant(merchant.id, {
      name: merchant.name || null,
      corporateName: merchant.corporateName || null,
      payload: merchant
    });
  }

  return merchants
    .filter(x => x?.id)
    .map(x => ({
      id: String(x.id),
      name: x.name || "Loja iFood",
      corporateName: x.corporateName || null,
      source: "merchant_api"
    }));
}

async function resolveIfoodMerchantsForSync() {
  const configuredMerchantId = ifoodPrimaryMerchantId();

  // Produção por merchant_id: Order + Events não dependem do módulo Merchant.
  // Quando este ID está definido, o polling fica travado explicitamente nessa loja.
  if (configuredMerchantId) {
    const known = await upsertConfiguredIfoodMerchant(configuredMerchantId);

    return [{
      id: configuredMerchantId,
      name: known?.name || "Merchant configurado",
      corporateName: known?.corporateName || null,
      source: "environment"
    }];
  }

  // Compatibilidade com sandbox/contas que possuem acesso ao módulo Merchant.
  return fetchAndStoreIfoodMerchants();
}

function normalizeIfoodPreparationMinutes(body) {
  const raw =
    body?.preparationTime ??
    body?.preparation_time ??
    body?.minutes ??
    (typeof body === "number" ? body : null);

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
    throw new Error("iFood retornou um tempo de preparo inválido.");
  }
  return Math.round(minutes);
}

async function syncIfoodPreparationTimes(merchantIds = []) {
  const unique = [...new Set(merchantIds.map(String).filter(Boolean))];

  if (!unique.length) {
    return { configured: ifoodPreparationTimeConfigured(), checked: 0, changed: 0, failed: 0 };
  }

  if (!ifoodPreparationTimeConfigured()) {
    return {
      configured: false,
      checked: 0,
      changed: 0,
      failed: 0,
      skipped: true,
      reason: "IFOOD_CUSTOMER_ID_MISSING"
    };
  }

  const customerId = ifoodCustomerId();
  let checked = 0;
  let changed = 0;
  let failed = 0;

  for (const merchantId of unique) {
    const previous = (await pool.query(`
      SELECT preparation_time_minutes
      FROM ifood_preparation_times
      WHERE merchant_id=$1
    `, [merchantId])).rows[0];

    try {
      const { body } = await ifoodApi(
        `${IFOOD_MERCHANT_BASE}/merchants/${encodeURIComponent(merchantId)}/myPreparationTime`,
        {
          headers: {
            "X-iFood-Customer-ID": customerId,
            "Content-Type": "application/json"
          }
        }
      );

      const minutes = normalizeIfoodPreparationMinutes(body);
      checked++;

      if (Number(previous?.preparation_time_minutes || 0) !== minutes) {
        changed++;
      }

      await pool.query(`
        INSERT INTO ifood_preparation_times(
          merchant_id,preparation_time_minutes,source,synced_at,last_error,last_error_at,updated_at
        )
        VALUES($1,$2,'IFOOD_MY_PREPARATION_TIME',NOW(),NULL,NULL,NOW())
        ON CONFLICT(merchant_id) DO UPDATE SET
          preparation_time_minutes=EXCLUDED.preparation_time_minutes,
          source='IFOOD_MY_PREPARATION_TIME',
          synced_at=NOW(),
          last_error=NULL,
          last_error_at=NULL,
          updated_at=NOW()
      `, [merchantId, minutes]);
    } catch (err) {
      failed++;
      await pool.query(`
        INSERT INTO ifood_preparation_times(
          merchant_id,preparation_time_minutes,source,synced_at,last_error,last_error_at,updated_at
        )
        VALUES($1,NULL,'IFOOD_MY_PREPARATION_TIME',NULL,$2,NOW(),NOW())
        ON CONFLICT(merchant_id) DO UPDATE SET
          last_error=$2,
          last_error_at=NOW(),
          updated_at=NOW()
      `, [merchantId, ifoodSafeError(err)]).catch(() => {});

      console.error(`iFood preparation time ${merchantId}:`, ifoodSafeError(err));
    }
  }

  return {
    configured: true,
    checked,
    changed,
    failed
  };
}

function normalizeIfoodEvents(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.events)) return body.events;
  return [];
}


const IFOOD_ORDER_STATUS_VALUES = new Set([
  "PLACED",
  "CONFIRMED",
  "PREPARATION_STARTED",
  "SEPARATION_STARTED",
  "SEPARATION_ENDED",
  "READY_TO_PICKUP",
  "DISPATCHED",
  "CONCLUDED",
  "CANCELLED",
  "DELIVERED"
]);

const IFOOD_ORDER_STATUS_SHORT_CODES = {
  PLC: "PLACED",
  CFM: "CONFIRMED",
  SPS: "SEPARATION_STARTED",
  SPE: "SEPARATION_ENDED",
  RTP: "READY_TO_PICKUP",
  DSP: "DISPATCHED",
  CON: "CONCLUDED",
  CAN: "CANCELLED"
};

function normalizeIfoodLifecycleStatus(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!s) return null;
  if (IFOOD_ORDER_STATUS_VALUES.has(s)) return s;
  if (IFOOD_ORDER_STATUS_SHORT_CODES[s]) return IFOOD_ORDER_STATUS_SHORT_CODES[s];
  return null;
}

function ifoodLifecycleStatusFromEvent(event) {
  return (
    normalizeIfoodLifecycleStatus(event?.fullCode) ||
    normalizeIfoodLifecycleStatus(event?.code)
  );
}

async function upsertIfoodOrderFromDetails(order, fallback = {}) {
  if (!order?.id && !fallback.orderId) return false;

  const orderId = String(order?.id || fallback.orderId);
  const merchantId = order?.merchant?.id || fallback.merchantId || null;
  const lastEventCode = fallback.fullCode || fallback.code || null;
  const lastEventAt = fallback.createdAt || null;
  const lifecycleStatus =
    normalizeIfoodLifecycleStatus(order?.status) ||
    ifoodLifecycleStatusFromEvent(fallback);

  if (merchantId) {
    await upsertConfiguredIfoodMerchant(merchantId, {
      name: order?.merchant?.name || null,
      corporateName: order?.merchant?.corporateName || null,
      payload: order?.merchant || null
    }).catch(() => {});
  }

  await pool.query(`
    INSERT INTO ifood_orders(
      order_id,display_id,merchant_id,status,order_type,order_timing,category,sales_channel,
      delivered_by,is_test,order_created_at,preparation_start_at,last_event_code,last_event_at,payload,updated_at
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    ON CONFLICT(order_id) DO UPDATE SET
      display_id=COALESCE(EXCLUDED.display_id,ifood_orders.display_id),
      merchant_id=COALESCE(EXCLUDED.merchant_id,ifood_orders.merchant_id),
      status=COALESCE(EXCLUDED.status,ifood_orders.status),
      order_type=COALESCE(EXCLUDED.order_type,ifood_orders.order_type),
      order_timing=COALESCE(EXCLUDED.order_timing,ifood_orders.order_timing),
      category=COALESCE(EXCLUDED.category,ifood_orders.category),
      sales_channel=COALESCE(EXCLUDED.sales_channel,ifood_orders.sales_channel),
      delivered_by=COALESCE(EXCLUDED.delivered_by,ifood_orders.delivered_by),
      is_test=COALESCE(EXCLUDED.is_test,ifood_orders.is_test),
      order_created_at=COALESCE(EXCLUDED.order_created_at,ifood_orders.order_created_at),
      preparation_start_at=COALESCE(EXCLUDED.preparation_start_at,ifood_orders.preparation_start_at),
      last_event_code=COALESCE(EXCLUDED.last_event_code,ifood_orders.last_event_code),
      last_event_at=COALESCE(EXCLUDED.last_event_at,ifood_orders.last_event_at),
      payload=COALESCE(EXCLUDED.payload,ifood_orders.payload),
      updated_at=NOW()
  `, [
    orderId,
    order?.displayId || null,
    merchantId ? String(merchantId) : null,
    lifecycleStatus,
    order?.orderType || null,
    order?.orderTiming || null,
    order?.category || null,
    order?.salesChannel || null,
    order?.delivery?.deliveredBy || null,
    typeof order?.isTest === "boolean" ? order.isTest : null,
    order?.createdAt || null,
    order?.preparationStartDateTime || null,
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


function canonicalIfoodOrderStatus(value) {
  return normalizeIfoodLifecycleStatus(value) || "UNKNOWN";
}

function ifoodOrderIsTerminal(status) {
  return ["CANCELLED", "CONCLUDED", "DISPATCHED", "DELIVERED"]
    .includes(canonicalIfoodOrderStatus(status));
}

function ifoodOrderCanBeSelected(status) {
  return [
    "CONFIRMED",
    "READY_TO_PICKUP",
    "PREPARATION_STARTED",
    "SEPARATION_STARTED",
    "SEPARATION_ENDED"
  ].includes(canonicalIfoodOrderStatus(status));
}

function plainLocalOrderNumber(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

async function inspectIfoodOrdersForDeparture(orders) {
  const requested = [...new Set(
    orders.map(plainLocalOrderNumber).filter(Boolean)
  )];

  if (!requested.length) return { accepted: [], blocked: [], matched: [] };

  const rows = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.merchant_id,o.status,o.order_type,o.category,
      o.sales_channel,o.delivered_by,o.is_test,o.order_created_at,
      o.last_event_code,o.last_event_at,
      l.dispatch_id AS linked_dispatch_id,
      d.status AS linked_dispatch_status,
      u.name AS linked_courier_name
    FROM ifood_orders o
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN users u ON u.id=d.courier_id
    WHERE LOWER(COALESCE(o.display_id,'')) = ANY($1::text[])
    ORDER BY COALESCE(o.last_event_at,o.updated_at) DESC
  `, [requested])).rows;

  const grouped = new Map();
  for (const row of rows) {
    const key = plainLocalOrderNumber(row.display_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const accepted = [];
  const blocked = [];
  const matched = [];

  for (const localOrder of orders) {
    const key = plainLocalOrderNumber(localOrder);
    const candidates = grouped.get(key) || [];

    // Não encontrado no iFood = pedido manual. Mantém compatibilidade com outros canais.
    if (!candidates.length) continue;

    const current = candidates.filter(x => !ifoodOrderIsTerminal(x.status || x.last_event_code));

    if (current.length > 1) {
      blocked.push({
        order_number: localOrder,
        code: "IFOOD_ORDER_AMBIGUOUS",
        message: "Há mais de um pedido iFood ativo com esse número. Procure o administrador."
      });
      continue;
    }

    const row = current[0] || candidates[0];
    const status = canonicalIfoodOrderStatus(row.status);

    matched.push({
      order_number: localOrder,
      order_id: row.order_id,
      display_id: row.display_id,
      delivered_by: row.delivered_by,
      status,
      is_test: row.is_test
    });

    if (String(row.order_type || "").toUpperCase() !== "DELIVERY") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_NOT_DELIVERY",
        message: "Esse pedido iFood não é uma entrega."
      });
      continue;
    }

    if (String(row.delivered_by || "").toUpperCase() === "IFOOD") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_PARTNER_DELIVERY",
        message: "Esse pedido usa entrega parceira iFood e não pode sair com motoboy da loja."
      });
      continue;
    }

    if (String(row.delivered_by || "").toUpperCase() !== "MERCHANT") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_DELIVERY_MODE_UNKNOWN",
        message: "O tipo de entrega desse pedido iFood ainda não está identificado."
      });
      continue;
    }

    if (ifoodOrderIsTerminal(status)) {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_ORDER_CLOSED",
        message: `Esse pedido iFood já está ${status.toLowerCase()}.`
      });
      continue;
    }

    if (!ifoodOrderCanBeSelected(status)) {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_ORDER_NOT_READY",
        message: status === "PLACED"
          ? "Esse pedido iFood ainda não foi confirmado."
          : "Esse pedido iFood ainda não está disponível para despacho."
      });
      continue;
    }

    if (row.linked_dispatch_id) {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_ORDER_ALREADY_LINKED",
        message: row.linked_courier_name
          ? `Esse pedido iFood já foi vinculado a uma saída de ${row.linked_courier_name}.`
          : "Esse pedido iFood já foi vinculado a uma saída."
      });
      continue;
    }

    accepted.push({
      order_number: localOrder,
      order_id: row.order_id,
      display_id: row.display_id,
      status,
      delivered_by: row.delivered_by
    });
  }

  return { accepted, blocked, matched };
}

async function getAvailableIfoodOrders(search = "", limit = 30) {
  const q = String(search || "").trim().replace(/^#/, "").slice(0, 50);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);

  const rows = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.merchant_id,o.status,o.order_type,o.category,
      o.sales_channel,o.delivered_by,o.is_test,o.order_created_at,
      o.last_event_code,o.last_event_at,o.updated_at
    FROM ifood_orders o
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN active_order_locks a
      ON LOWER(a.order_number)=LOWER('#' || COALESCE(o.display_id,''))
    WHERE UPPER(COALESCE(o.order_type,''))='DELIVERY'
      AND UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
      AND l.ifood_order_id IS NULL
      AND a.order_number IS NULL
      AND (
        UPPER(COALESCE(o.status,''))='CONFIRMED'
        OR UPPER(COALESCE(o.status,''))='READY_TO_PICKUP'
        OR UPPER(COALESCE(o.status,''))='PREPARATION_STARTED'
        OR UPPER(COALESCE(o.status,'')) IN ('SEPARATION_STARTED','SEPARATION_ENDED')
      )
      AND ($1='' OR COALESCE(o.display_id,'') ILIKE '%' || $1 || '%')
    ORDER BY
      CASE
        WHEN UPPER(COALESCE(o.status,''))='READY_TO_PICKUP' THEN 0
        ELSE 1
      END,
      COALESCE(o.order_created_at,o.last_event_at,o.updated_at) ASC
    LIMIT $2
  `, [q, safeLimit])).rows;

  return rows.map(row => ({
    orderId: row.order_id,
    displayId: row.display_id,
    status: canonicalIfoodOrderStatus(row.status),
    deliveredBy: row.delivered_by,
    isTest: row.is_test,
    orderCreatedAt: row.order_created_at,
    lastEventAt: row.last_event_at,
    salesChannel: row.sales_channel || "IFOOD"
  }));
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

function normalizeDeliveryCode(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function validDeliveryCode(value) {
  return /^\d{4,8}$/.test(normalizeDeliveryCode(value));
}

function deliveryConfirmationLabel(status, orderStatus) {
  const orderLifecycle = canonicalIfoodOrderStatus(orderStatus);
  if (["CONCLUDED","DELIVERED"].includes(orderLifecycle)) return "CONCLUDED";

  const value = String(status || "").trim().toUpperCase();
  if (["VERIFIED","PROCESSING","FAILED","PENDING","CONCLUDED"].includes(value)) return value;
  return "PENDING";
}

function courierDeliveryUiState(row) {
  const orderStatus = canonicalIfoodOrderStatus(row.order_status);
  const confirmationStatus = deliveryConfirmationLabel(row.confirmation_status, row.order_status);
  const dispatchStatus = String(row.ifood_dispatch_status || "").trim().toUpperCase();

  if (["CONCLUDED","DELIVERED"].includes(orderStatus) || confirmationStatus === "CONCLUDED") {
    return {
      state: "CONCLUDED",
      label: "Entrega concluída",
      can_confirm: false,
      message: "Entrega concluída no iFood."
    };
  }

  if (orderStatus === "CANCELLED") {
    return {
      state: "CANCELLED",
      label: "Cancelado",
      can_confirm: false,
      message: "Pedido cancelado no iFood."
    };
  }

  if (confirmationStatus === "VERIFIED") {
    return {
      state: "VERIFIED",
      label: "Código validado",
      can_confirm: false,
      message: "Código aceito pelo iFood. Aguardando o evento final de conclusão."
    };
  }

  if (confirmationStatus === "PROCESSING") {
    return {
      state: "PROCESSING",
      label: "Confirmando",
      can_confirm: false,
      message: "Confirmação sendo enviada ao iFood."
    };
  }

  if (dispatchStatus === "FAILED") {
    return {
      state: "DISPATCH_FAILED",
      label: "Despacho com erro",
      can_confirm: false,
      message: "O despacho desse pedido ainda está com erro no iFood."
    };
  }

  if (
    ["API_ACCEPTED","DISPATCHED"].includes(dispatchStatus) ||
    orderStatus === "DISPATCHED"
  ) {
    return {
      state: confirmationStatus === "FAILED" ? "FAILED" : "WAITING_CODE",
      label: confirmationStatus === "FAILED" ? "Código não validado" : "Aguardando código",
      can_confirm: true,
      message: confirmationStatus === "FAILED"
        ? "Confira o código com o cliente e tente novamente."
        : "Ao chegar ao cliente, peça o código/localizador para confirmar a entrega."
    };
  }

  return {
    state: "WAITING_DISPATCH",
    label: "Aguardando iFood",
    can_confirm: false,
    message: "Aguarde o iFood receber o despacho antes de confirmar a entrega."
  };
}

async function getCourierIfoodDeliveries(courierId) {
  const rows = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.status AS order_status,o.order_type,o.delivered_by,
      o.merchant_id,o.last_event_code,o.last_event_at,
      l.dispatch_id,l.local_order_number,l.ifood_dispatch_status,
      d.departed_at,d.status AS dispatch_status,
      c.status AS confirmation_status,c.attempts AS confirmation_attempts,
      c.last_error AS confirmation_last_error,c.verified_at,c.concluded_at,c.updated_at AS confirmation_updated_at
    FROM ifood_dispatch_links l
    JOIN ifood_orders o ON o.order_id=l.ifood_order_id
    JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN ifood_delivery_confirmations c ON c.ifood_order_id=o.order_id
    WHERE d.courier_id=$1
      AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
          (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      AND UPPER(COALESCE(o.order_type,''))='DELIVERY'
      AND UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
    ORDER BY
      CASE WHEN d.status='ON_ROAD' THEN 0 ELSE 1 END,
      d.departed_at DESC,
      o.display_id
  `, [courierId])).rows;

  const current = [];
  const pending = [];
  const completed = [];

  for (const row of rows) {
    const ui = courierDeliveryUiState(row);
    const item = {
      order_id: row.order_id,
      display_id: row.display_id || String(row.local_order_number || "").replace(/^#/, ""),
      local_order_number: row.local_order_number,
      order_status: canonicalIfoodOrderStatus(row.order_status),
      dispatch_status: row.dispatch_status,
      ifood_dispatch_status: row.ifood_dispatch_status,
      departed_at: row.departed_at,
      confirmation_status: deliveryConfirmationLabel(row.confirmation_status, row.order_status),
      verified_at: row.verified_at,
      concluded_at: row.concluded_at,
      last_error: row.confirmation_last_error,
      ...ui
    };

    if (row.dispatch_status === "ON_ROAD") {
      current.push(item);
      continue;
    }

    if (
      !["CONCLUDED","CANCELLED"].includes(item.state) &&
      item.confirmation_status !== "VERIFIED"
    ) {
      pending.push(item);
    } else {
      completed.push(item);
    }
  }

  return { current, pending, completed };
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
    const merchants = await resolveIfoodMerchantsForSync();
    const merchantIds = merchants
      .map(x => String(x.id || "").trim())
      .filter(Boolean);

    if (!merchantIds.length) {
      throw new Error(
        "Nenhuma loja iFood definida. Configure IFOOD_MERCHANT_ID em produção ou habilite acesso ao módulo Merchant."
      );
    }

    // v3.5: acompanha o "Meu Tempo de Preparo" configurado no próprio iFood.
    // A falha deste endpoint não bloqueia a sincronização de pedidos/eventos.
    const preparationTimes = await syncIfoodPreparationTimes(merchantIds);

    const url = new URL(`${IFOOD_EVENTS_BASE}/events:polling`);
    url.searchParams.set("categories", "FOOD");
    // PDV/Food: NÃO usar excludeHeartbeat. O heartbeat do polling é usado pelo iFood
    // para validar a presença/conectividade do aplicativo na homologação e operação.
    // excludeHeartbeat=true é reservado a integrações da categoria Logística.

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
          // O último evento é sempre registrado, mas somente eventos ORDER_STATUS
          // podem alterar o status principal do pedido.
          const lifecycleStatus = ifoodLifecycleStatusFromEvent(event);
          const eventCode = event.fullCode || event.code || null;

          await pool.query(`
            UPDATE ifood_orders SET
              status=COALESCE($2,status),
              last_event_code=COALESCE($3,last_event_code),
              last_event_at=COALESCE($4,last_event_at),
              updated_at=NOW()
            WHERE order_id=$1
          `, [
            orderId,
            lifecycleStatus,
            eventCode,
            event.createdAt || null
          ]);
        }
      }

      const dispatchLifecycle = ifoodLifecycleStatusFromEvent(event);

      if (event.orderId && dispatchLifecycle === "DISPATCHED") {
        await pool.query(`
          UPDATE ifood_dispatch_links
          SET ifood_dispatch_status='DISPATCHED'
          WHERE ifood_order_id=$1
        `, [String(event.orderId)]);

        await pool.query(`
          UPDATE ifood_dispatch_jobs
          SET status='SENT',
              accepted_at=COALESCE(accepted_at,NOW()),
              locked_at=NULL,
              last_error=NULL,
              updated_at=NOW()
          WHERE ifood_order_id=$1
        `, [String(event.orderId)]);
      }

      if (event.orderId && ["CONCLUDED","DELIVERED"].includes(dispatchLifecycle)) {
        await pool.query(`
          UPDATE ifood_dispatch_links
          SET ifood_dispatch_status='CONCLUDED'
          WHERE ifood_order_id=$1
        `, [String(event.orderId)]);

        await pool.query(`
          UPDATE ifood_delivery_confirmations
          SET status='CONCLUDED',
              concluded_at=COALESCE(concluded_at,NOW()),
              processing_started_at=NULL,
              last_error=NULL,
              updated_at=NOW()
          WHERE ifood_order_id=$1
        `, [String(event.orderId)]);

        const linkedDispatch = (await pool.query(
          "SELECT dispatch_id FROM ifood_dispatch_links WHERE ifood_order_id=$1",
          [String(event.orderId)]
        )).rows[0];
        if (linkedDispatch?.dispatch_id) {
          await maybeAutoMarkDispatchReturning(linkedDispatch.dispatch_id, { source: "AUTO_IFOOD_CONCLUDED" });
        }
      }

      if (event.orderId && dispatchLifecycle === "CANCELLED") {
        await pool.query(`
          UPDATE ifood_dispatch_jobs
          SET status='FAILED',
              locked_at=NULL,
              last_error=COALESCE(last_error,'Pedido cancelado no iFood.'),
              updated_at=NOW()
          WHERE ifood_order_id=$1
            AND status IN ('PENDING','RETRY','PROCESSING')
        `, [String(event.orderId)]);

        await pool.query(`
          UPDATE ifood_dispatch_links
          SET ifood_dispatch_status='FAILED'
          WHERE ifood_order_id=$1
            AND ifood_dispatch_status IN ('NOT_SENT','PENDING','RETRY')
        `, [String(event.orderId)]);

        await pool.query(`
          UPDATE ifood_delivery_confirmations
          SET status='FAILED',
              processing_started_at=NULL,
              last_error='Pedido cancelado no iFood.',
              updated_at=NOW()
          WHERE ifood_order_id=$1
            AND status NOT IN ('VERIFIED','CONCLUDED')
        `, [String(event.orderId)]);
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
      acknowledged,
      preparationTimes
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



const PRESENCE_WRITE_INTERVAL_MS = Math.max(15000, Number(process.env.PRESENCE_WRITE_INTERVAL_MS || 45000));
const recentPresenceWrites = new Map();
async function touchPresence(userId, source = "WEB") {
  if (!userId) return;
  const key = String(userId);
  const now = Date.now();
  const recent = recentPresenceWrites.get(key);
  if (recent && recent.source === source && now - recent.at < PRESENCE_WRITE_INTERVAL_MS) return;
  const marker = { source, at: now };
  recentPresenceWrites.set(key, marker);
  try {
    await pool.query(`
      INSERT INTO user_presence(user_id,last_seen_at,source)
      VALUES($1,NOW(),$2)
      ON CONFLICT(user_id) DO UPDATE SET
        last_seen_at=NOW(),
        source=EXCLUDED.source
    `, [userId, source]);
  } catch (err) {
    if (recentPresenceWrites.get(key) === marker) recentPresenceWrites.delete(key);
    throw err;
  }
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

async function createDispatchTransaction({
  actorUserId,
  courierId,
  orders,
  source,
  adminReason = null,
  clientToken = null,
  departedAt = null,
  ifoodLinks = []
}) {
  const operationalSla = await getOperationalSlaSettings();
  const routeSlaMinutes = operationalRouteSlaMinutes(orders.length, operationalSla);
  const returnSlaMinutes = operationalSla.returnMinutes;
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

    // v2.8: uma nova saída NUNCA encerra a anterior automaticamente.
    // O advisory lock serializa saídas do mesmo motoboy inclusive entre
    // múltiplas instâncias do Render, evitando duas saídas simultâneas.
    await client.query("SELECT pg_advisory_xact_lock($1::int)", [courierId]);

    const activeDispatch = await client.query(`
      SELECT id,dispatch_code,departed_at,operational_stage,returning_at
      FROM dispatches
      WHERE courier_id=$1 AND status='ON_ROAD'
      ORDER BY departed_at DESC,id DESC
      LIMIT 1
      FOR UPDATE
    `, [courierId]);

    if (activeDispatch.rowCount) {
      const err = new Error(
        operationalStage(activeDispatch.rows[0].operational_stage) === "RETURNING"
          ? "Você ainda está retornando. Confirme sua chegada à loja antes de registrar outra saída."
          : "Você ainda possui uma saída em andamento. Finalize as entregas, inicie o retorno e confirme sua chegada à loja antes de registrar outra saída."
      );
      err.code = "RETURN_CHECKIN_REQUIRED";
      err.status = 409;
      err.active = activeDispatch.rows[0];
      throw err;
    }

    const effectiveDeparture = departedAt || new Date().toISOString();
    const closedPrevious = null;

    const code = "DSP-" + Date.now().toString(36).toUpperCase() + "-" +
      Math.random().toString(36).slice(2, 6).toUpperCase();

    const result = await client.query(`
      INSERT INTO dispatches(
        dispatch_code,order_number,courier_id,
        registered_by,registration_source,admin_reason,client_token,departed_at,
        operational_stage,route_sla_minutes,return_sla_minutes
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,'EN_ROUTE',$9,$10)
      RETURNING id,dispatch_code,order_number,departed_at,status,operational_stage,
                route_sla_minutes,return_sla_minutes,
                registered_by,registration_source,admin_reason
    `, [
      code,
      orders[0],
      courierId,
      actorUserId,
      source,
      adminReason || null,
      clientToken || null,
      effectiveDeparture,
      routeSlaMinutes,
      returnSlaMinutes
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

    for (const link of ifoodLinks) {
      const linked = await client.query(`
        INSERT INTO ifood_dispatch_links(
          ifood_order_id,dispatch_id,local_order_number,ifood_dispatch_status
        )
        VALUES($1,$2,$3,'NOT_SENT')
        ON CONFLICT(ifood_order_id) DO NOTHING
        RETURNING ifood_order_id
      `, [link.order_id, dispatch.id, link.order_number]);

      if (!linked.rowCount) {
        const err = new Error(`Pedido iFood ${link.order_number} já foi vinculado a outra saída.`);
        err.code = "IFOOD_ORDER_ALREADY_LINKED";
        err.status = 409;
        throw err;
      }

      await client.query(`
        INSERT INTO ifood_dispatch_jobs(
          ifood_order_id,dispatch_id,status,next_attempt_at
        )
        VALUES($1,$2,'PENDING',NOW())
        ON CONFLICT(ifood_order_id) DO NOTHING
      `, [link.order_id, dispatch.id]);
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
    const sla = await getOperationalSlaSettings();
    const rows = (await pool.query(`
      SELECT d.id,d.departed_at,d.returning_at,d.operational_stage,
             d.route_sla_minutes,d.return_sla_minutes,
             u.id AS courier_id,u.name AS courier_name,
             ${orderArraySql("d")}
      FROM dispatches d
      JOIN users u ON u.id=d.courier_id
      WHERE d.status='ON_ROAD'
    `)).rows;

    const progressMap = await getDispatchProgressMap(rows.map(r => r.id));
    const enriched = decorateOperationalDispatches(rows, progressMap, sla);

    for (const row of enriched) {
      if (row.sla_state === "NORMAL") continue;

      const config = {
        ATTENTION: { type: "TIME_ATTENTION", severity: "warning", label: "Atenção operacional" },
        DELAYED: { type: "TIME_DELAYED", severity: "delayed", label: "Meta de tempo excedida" },
        CRITICAL: { type: "TIME_CRITICAL", severity: "critical", label: "Tempo crítico" }
      }[row.sla_state];
      if (!config) continue;

      const stageLabel = row.operational_stage === "RETURNING" ? "retornando" : "em rota";
      const orders = Array.isArray(row.order_numbers) ? row.order_numbers.join(", ") : row.order_number;
      await createNotification({
        type: config.type,
        severity: config.severity,
        title: `${config.label} • ${row.courier_name}`,
        message: `${row.courier_name} está ${stageLabel} há ${row.stage_elapsed_minutes} min (meta ${row.sla_minutes} min). ${orders}`,
        courierId: row.courier_id,
        dispatchId: row.id,
        uniqueKey: `time:${row.id}:${row.operational_stage}:${row.sla_state.toLowerCase()}`
      });
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

async function getOperationalSlaSettings() {
  const keys = [
    'route_sla_1_minutes','route_sla_2_minutes','route_sla_3_minutes',
    'route_sla_4_minutes','route_sla_5_minutes','return_sla_minutes','sla_critical_over_minutes'
  ];
  const q = await pool.query(
    `SELECT setting_key,setting_value FROM app_settings WHERE setting_key = ANY($1::text[])`,
    [keys]
  );
  const obj = Object.fromEntries(q.rows.map(r => [r.setting_key, Number(r.setting_value)]));
  return {
    route: {
      1: obj.route_sla_1_minutes || 25,
      2: obj.route_sla_2_minutes || 30,
      3: obj.route_sla_3_minutes || 35,
      4: obj.route_sla_4_minutes || 40,
      5: obj.route_sla_5_minutes || 45
    },
    returnMinutes: obj.return_sla_minutes || 15,
    criticalOverMinutes: obj.sla_critical_over_minutes || 15
  };
}

function operationalRouteSlaMinutes(orderCount, sla) {
  const count = Math.max(1, Math.min(5, Number(orderCount) || 1));
  return Number(sla?.route?.[count] || sla?.route?.[String(count)] || 25);
}

function operationalStage(value, status = "ON_ROAD") {
  if (String(status || "").toUpperCase() === "RELEASED") return "COMPLETED";
  return String(value || "EN_ROUTE").toUpperCase() === "RETURNING" ? "RETURNING" : "EN_ROUTE";
}

function operationalTiming(row, progress, sla, nowMs = Date.now()) {
  const stage = operationalStage(row.operational_stage, row.status);
  const totalOrders = Math.max(1, Number(progress?.total_orders || 0) || (Array.isArray(row.order_numbers) ? row.order_numbers.length : 1));
  const routeTarget = Number(row.route_sla_minutes) || operationalRouteSlaMinutes(totalOrders, sla);
  const returnTarget = Number(row.return_sla_minutes) || Number(sla.returnMinutes || 15);
  const baseIso = stage === "RETURNING" ? (row.returning_at || row.departed_at) : row.departed_at;
  const baseMs = Date.parse(baseIso || new Date(nowMs).toISOString());
  const departedMs = Date.parse(row.departed_at || new Date(nowMs).toISOString());
  const stageElapsed = Math.max(0, Math.floor((nowMs - baseMs) / 60000));
  const totalElapsed = Math.max(0, Math.floor((nowMs - departedMs) / 60000));
  const target = stage === "RETURNING" ? returnTarget : routeTarget;
  const attentionAt = Math.max(1, Math.ceil(target * 0.8));
  const criticalAt = target + Number(sla.criticalOverMinutes || 15);
  let state = "NORMAL";
  if (stageElapsed >= criticalAt) state = "CRITICAL";
  else if (stageElapsed > target) state = "DELAYED";
  else if (stageElapsed >= attentionAt) state = "ATTENTION";
  return {
    operational_stage: stage,
    stage_elapsed_minutes: stageElapsed,
    total_elapsed_minutes: totalElapsed,
    sla_minutes: target,
    sla_attention_at: attentionAt,
    sla_critical_at: criticalAt,
    sla_state: state
  };
}

async function getDispatchProgressMap(dispatchIds) {
  const ids = [...new Set((dispatchIds || []).map(Number).filter(Number.isFinite))];
  const map = new Map();
  if (!ids.length) return map;

  const rows = (await pool.query(`
    SELECT d.id AS dispatch_id,
      COUNT(DISTINCT o.id)::int AS total_orders,
      COUNT(DISTINCT o.id) FILTER (
        WHERE l.ifood_order_id IS NOT NULL
          AND UPPER(COALESCE(io.order_type,''))='DELIVERY'
          AND UPPER(COALESCE(io.delivered_by,''))='MERCHANT'
      )::int AS trackable_orders,
      COUNT(DISTINCT o.id) FILTER (
        WHERE l.ifood_order_id IS NOT NULL
          AND UPPER(COALESCE(io.order_type,''))='DELIVERY'
          AND UPPER(COALESCE(io.delivered_by,''))='MERCHANT'
          AND UPPER(COALESCE(io.status,''))<>'CANCELLED'
          AND (
            UPPER(COALESCE(io.status,'')) IN ('CONCLUDED','DELIVERED')
            OR UPPER(COALESCE(dc.status,'')) IN ('VERIFIED','CONCLUDED')
          )
      )::int AS delivered_orders,
      COUNT(DISTINCT o.id) FILTER (
        WHERE l.ifood_order_id IS NOT NULL
          AND UPPER(COALESCE(io.order_type,''))='DELIVERY'
          AND UPPER(COALESCE(io.delivered_by,''))='MERCHANT'
          AND (
            UPPER(COALESCE(io.status,'')) IN ('CONCLUDED','DELIVERED','CANCELLED')
            OR UPPER(COALESCE(dc.status,'')) IN ('VERIFIED','CONCLUDED')
          )
      )::int AS resolved_orders
    FROM dispatches d
    LEFT JOIN dispatch_orders o ON o.dispatch_id=d.id
    LEFT JOIN ifood_dispatch_links l ON l.dispatch_id=d.id AND l.local_order_number=o.order_number
    LEFT JOIN ifood_orders io ON io.order_id=l.ifood_order_id
    LEFT JOIN ifood_delivery_confirmations dc ON dc.ifood_order_id=l.ifood_order_id
    WHERE d.id = ANY($1::bigint[])
    GROUP BY d.id
  `, [ids])).rows;

  for (const r of rows) {
    const progress = {
      total_orders: Number(r.total_orders || 0),
      trackable_orders: Number(r.trackable_orders || 0),
      delivered_orders: Number(r.delivered_orders || 0),
      resolved_orders: Number(r.resolved_orders || 0)
    };
    progress.all_orders_trackable = progress.total_orders > 0 && progress.trackable_orders === progress.total_orders;
    progress.all_orders_resolved = progress.all_orders_trackable && progress.resolved_orders >= progress.total_orders;
    map.set(Number(r.dispatch_id), progress);
  }
  return map;
}

function decorateOperationalDispatches(rows, progressMap, sla, nowMs = Date.now()) {
  return (rows || []).map(row => {
    const progress = progressMap.get(Number(row.id)) || {
      total_orders: Array.isArray(row.order_numbers) ? row.order_numbers.length : 1,
      trackable_orders: 0,
      delivered_orders: 0,
      resolved_orders: 0,
      all_orders_trackable: false,
      all_orders_resolved: false
    };
    return { ...row, ...progress, ...operationalTiming(row, progress, sla, nowMs) };
  });
}

async function markDispatchReturning(dispatchId, { actorUserId = null, source = "MANUAL", reason = null } = {}) {
  const q = await pool.query(`
    UPDATE dispatches
    SET operational_stage='RETURNING',
        returning_at=COALESCE(returning_at,NOW()),
        return_source=COALESCE(return_source,$2),
        return_reason=COALESCE(return_reason,$3)
    WHERE id=$1 AND status='ON_ROAD' AND COALESCE(operational_stage,'EN_ROUTE')<>'RETURNING'
    RETURNING *
  `, [dispatchId, source, reason]);

  if (!q.rowCount) return null;
  if (actorUserId) {
    await auditBestEffort(actorUserId, "DISPATCH_RETURN_STARTED", "dispatch", dispatchId, { source, reason });
  }
  io.emit("dispatch:changed", { courier_id: q.rows[0].courier_id, dispatch_id: q.rows[0].id, change: "RETURNING" });
  return q.rows[0];
}

async function maybeAutoMarkDispatchReturning(dispatchId, { actorUserId = null, source = "AUTO_IFOOD" } = {}) {
  const progressMap = await getDispatchProgressMap([dispatchId]);
  const progress = progressMap.get(Number(dispatchId));
  if (!progress?.all_orders_resolved) return null;
  return markDispatchReturning(dispatchId, {
    actorUserId,
    source,
    reason: "ALL_TRACKABLE_ORDERS_RESOLVED"
  });
}

async function completeDispatchReturn({ dispatchId, courierId = null, actorUserId, source = "COURIER_ARRIVAL", reason = "ARRIVED_AT_STORE" }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params = [dispatchId];
    let courierClause = "";
    if (courierId) {
      params.push(courierId);
      courierClause = ` AND courier_id=$${params.length}`;
    }
    const active = await client.query(`
      SELECT * FROM dispatches
      WHERE id=$1 AND status='ON_ROAD'${courierClause}
      FOR UPDATE
    `, params);
    if (!active.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }

    const q = await client.query(`
      UPDATE dispatches
      SET status='RELEASED',
          operational_stage='COMPLETED',
          returning_at=CASE WHEN operational_stage='RETURNING' THEN returning_at ELSE returning_at END,
          returned_at=NOW(),
          returned_by=$2,
          released_at=NOW(),
          released_by=$2,
          return_source=COALESCE(return_source,$3),
          return_reason=COALESCE(return_reason,$4),
          arrival_source=$3,
          arrival_reason=$4,
          closed_reason=COALESCE(closed_reason,$4)
      WHERE id=$1 AND status='ON_ROAD'
      RETURNING *
    `, [dispatchId, actorUserId, source, reason]);

    await client.query("DELETE FROM active_order_locks WHERE dispatch_id=$1", [dispatchId]);
    await client.query("COMMIT");
    await auditBestEffort(actorUserId, "DISPATCH_RETURN_COMPLETED", "dispatch", dispatchId, { source, reason });
    io.emit("dispatch:changed", { courier_id: q.rows[0]?.courier_id, dispatch_id: q.rows[0]?.id, change: "COMPLETED" });
    return q.rows[0] || null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getSPDate() {
  const q = await pool.query("SELECT to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS d");
  return q.rows[0].d;
}

const ATTENDANCE_QR_TTL_MS = Math.max(
  45000,
  Math.min(5 * 60 * 1000, Number(process.env.ATTENDANCE_QR_TTL_MS || 90000))
);

function attendanceQrSecret() {
  return process.env.ATTENDANCE_QR_SECRET
    || process.env.SESSION_SECRET
    || crypto.createHash("sha256").update(process.env.DATABASE_URL || "despachefull").digest("hex");
}

function createAttendanceQrToken(attendanceDate) {
  const now = Date.now();
  const payload = {
    v: 1,
    p: "courier_attendance",
    d: attendanceDate,
    iat: now,
    exp: now + ATTENDANCE_QR_TTL_MS,
    n: crypto.randomUUID()
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", attendanceQrSecret())
    .update(body)
    .digest("base64url");
  return { token: `${body}.${signature}`, payload };
}

async function verifyAttendanceQrToken(token) {
  const value = String(token || "").trim();
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  const expected = crypto
    .createHmac("sha256", attendanceQrSecret())
    .update(body)
    .digest("base64url");

  const givenBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (givenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(givenBuf, expectedBuf)) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  if (payload?.v !== 1 || payload?.p !== "courier_attendance" || !validDate(payload?.d)) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  if (!Number.isFinite(Number(payload.exp)) || Date.now() > Number(payload.exp)) {
    const err = new Error("Este QR de presença expirou. Escaneie o QR atual exibido na loja.");
    err.status = 410;
    err.code = "ATTENDANCE_QR_EXPIRED";
    throw err;
  }

  const today = await getSPDate();
  if (payload.d !== today) {
    const err = new Error("Este QR pertence a outro dia de operação.");
    err.status = 409;
    err.code = "ATTENDANCE_QR_WRONG_DAY";
    throw err;
  }

  return payload;
}

async function getCourierAttendance(courierId, attendanceDate = null) {
  const date = attendanceDate || await getSPDate();
  return (await pool.query(`
    SELECT a.id,a.courier_id,a.attendance_date,a.checked_in_at,a.checkin_method,
           a.checked_in_by,a.admin_reason,a.checked_out_at,a.checked_out_by,a.checkout_reason
    FROM courier_attendance a
    WHERE a.courier_id=$1 AND a.attendance_date=$2::date
    LIMIT 1
  `, [courierId, date])).rows[0] || null;
}

async function requireCourierAttendance(courierId) {
  const date = await getSPDate();
  const attendance = await getCourierAttendance(courierId, date);
  if (!attendance) {
    const err = new Error("Confirme sua presença pelo QR da loja antes de registrar uma saída.");
    err.status = 403;
    err.code = "ATTENDANCE_REQUIRED";
    err.attendance_date = date;
    throw err;
  }
  if (attendance.checked_out_at) {
    const err = new Error("Seu expediente de hoje foi encerrado pelo Admin. Novas saídas estão bloqueadas.");
    err.status = 403;
    err.code = "SHIFT_ENDED";
    err.attendance_date = date;
    err.checked_out_at = attendance.checked_out_at;
    throw err;
  }
  return attendance;
}
function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}
function csvCell(v) {
  const s = String(v ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

function parseMoneyValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return Number(fallback);
  const normalized = String(value).trim().replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return Number(fallback);
  return Math.round(n * 100) / 100;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function paymentStatusLabel(status) {
  return status === "PAID" ? "PAGO" : status === "REVIEWED" ? "CONFERIDO" : "EM ABERTO";
}

const PIX_TYPES = new Set(["CPF","Celular","E-mail","Chave aleatória"]);

function normalizePixInput(body = {}) {
  const key = String(body.pix_key || "").trim().slice(0, 220);
  const type = String(body.pix_type || "").trim().slice(0, 40);
  const holder = String(body.pix_holder_name || "").trim().slice(0, 160);

  const hasAny = !!(key || type || holder);
  if (!hasAny) return { pix_key: null, pix_type: null, pix_holder_name: null, empty: true };

  if (!key || !type || !holder) {
    throw Object.assign(new Error("Informe titular, tipo de chave e chave PIX."), { status: 400 });
  }
  if (!PIX_TYPES.has(type)) {
    throw Object.assign(new Error("Tipo de chave PIX inválido."), { status: 400 });
  }
  if (holder.length < 3) {
    throw Object.assign(new Error("Informe o nome do titular do PIX."), { status: 400 });
  }
  if (key.length < 3) {
    throw Object.assign(new Error("Informe uma chave PIX válida."), { status: 400 });
  }

  return { pix_key: key, pix_type: type, pix_holder_name: holder, empty: false };
}

function normalizedPixStatus(value, hasKey = false) {
  const status = String(value || "").trim().toUpperCase();
  if (["NONE","PENDING","VERIFIED"].includes(status)) return status;
  return hasKey ? "VERIFIED" : "NONE";
}

function pixStatusLabel(status) {
  return status === "VERIFIED" ? "VERIFICADO" : status === "PENDING" ? "AGUARDANDO CONFIRMAÇÃO" : "NÃO CADASTRADO";
}

async function savePixHistory({
  courierId,
  pixKey = null,
  pixType = null,
  holderName = null,
  status = "NONE",
  source,
  changedBy = null,
  verifiedAt = null,
  verifiedBy = null
}) {
  await pool.query(`
    INSERT INTO courier_pix_history(
      courier_id,pix_key,pix_type,pix_holder_name,pix_status,source,
      changed_by,verified_at,verified_by
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [courierId,pixKey,pixType,holderName,status,source,changedBy,verifiedAt,verifiedBy]);
}

function isFriSun(date) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 5 || d === 6 || d === 0;
}

async function getPaymentRateRule(date) {
  const q = await pool.query(`
    SELECT id,effective_from,per_delivery,base_mon_thu,base_fri_sun,created_at
    FROM payment_rate_rules
    WHERE effective_from <= $1::date
    ORDER BY effective_from DESC,id DESC
    LIMIT 1
  `, [date]);

  const r = q.rows[0] || {
    id: null,
    effective_from: "2000-01-01",
    per_delivery: 6,
    base_mon_thu: 60,
    base_fri_sun: 75
  };

  return {
    id: r.id,
    effective_from: r.effective_from,
    per_delivery: Number(r.per_delivery),
    base_mon_thu: Number(r.base_mon_thu),
    base_fri_sun: Number(r.base_fri_sun),
    created_at: r.created_at || null
  };
}

function calculatePaymentAmounts({ date, deliveryCount, rule, tip = 0, discount = 0, adjustment = 0 }) {
  const count = Math.max(0, Number(deliveryCount) || 0);
  const perDelivery = roundMoney(rule?.per_delivery || 0);
  const base = count > 0
    ? roundMoney(isFriSun(date) ? rule?.base_fri_sun || 0 : rule?.base_mon_thu || 0)
    : 0;
  const tipAmount = roundMoney(tip);
  const discountAmount = Math.max(0, roundMoney(discount));
  const adjustmentAmount = roundMoney(adjustment);
  const total = roundMoney(count * perDelivery + base + tipAmount - discountAmount + adjustmentAmount);

  return {
    delivery_count: count,
    per_delivery: perDelivery,
    base_amount: base,
    tip_amount: tipAmount,
    discount_amount: discountAmount,
    adjustment_amount: adjustmentAmount,
    total_amount: total
  };
}

async function getCourierDeliveryCount(courierId, date, client = pool) {
  const q = await client.query(`
    SELECT COUNT(o.id)::int AS c
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE d.courier_id=$1
      AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$2::date
  `, [courierId, date]);
  return Number(q.rows[0]?.c || 0);
}

async function buildPaymentRow(courier, payment, date, rule, liveCount = null) {
  const status = payment?.status || "OPEN";
  const locked = status === "REVIEWED" || status === "PAID";
  const pixLocked = status === "PAID";
  const count = locked && payment?.delivery_count_snapshot !== null && payment?.delivery_count_snapshot !== undefined
    ? Number(payment.delivery_count_snapshot)
    : Number(liveCount ?? await getCourierDeliveryCount(courier.id, date));

  const calc = locked && payment?.total_snapshot !== null && payment?.total_snapshot !== undefined
    ? {
        delivery_count: count,
        per_delivery: Number(payment.per_delivery_snapshot),
        base_amount: Number(payment.base_snapshot),
        tip_amount: Number(payment.tip_amount || 0),
        discount_amount: Number(payment.discount_amount || 0),
        adjustment_amount: Number(payment.adjustment_amount || 0),
        total_amount: Number(payment.total_snapshot)
      }
    : calculatePaymentAmounts({
        date,
        deliveryCount: count,
        rule,
        tip: payment?.tip_amount || 0,
        discount: payment?.discount_amount || 0,
        adjustment: payment?.adjustment_amount || 0
      });

  const currentPixStatus = normalizedPixStatus(courier.pix_status, !!courier.pix_key);
  const lockedPixStatus = normalizedPixStatus(
    payment?.pix_status_snapshot,
    !!payment?.pix_key_snapshot
  );

  return {
    id: payment?.id || null,
    payment_date: date,
    courier_id: courier.id,
    courier_name: courier.name,
    nickname: courier.nickname || null,
    username: courier.username,
    pix_key: pixLocked ? (payment?.pix_key_snapshot ?? courier.pix_key ?? null) : (courier.pix_key || null),
    pix_type: pixLocked ? (payment?.pix_type_snapshot ?? courier.pix_type ?? null) : (courier.pix_type || null),
    pix_holder_name: pixLocked
      ? (payment?.pix_holder_name_snapshot ?? courier.pix_holder_name ?? null)
      : (courier.pix_holder_name || null),
    pix_status: pixLocked ? lockedPixStatus : currentPixStatus,
    pix_status_label: pixStatusLabel(pixLocked ? lockedPixStatus : currentPixStatus),
    ...calc,
    payment_method: payment?.payment_method || "",
    status,
    status_label: paymentStatusLabel(status),
    notes: payment?.notes || "",
    reviewed_at: payment?.reviewed_at || null,
    paid_at: payment?.paid_at || null,
    locked,
    rate_effective_from: rule?.effective_from || null
  };
}

async function getCourierPaymentPeriodDays(courier, startDate, endDate) {
  const rows = (await pool.query(`
    WITH deliveries AS (
      SELECT
        (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date AS payment_date,
        COUNT(o.id)::int AS delivery_count
      FROM dispatches d
      JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE d.courier_id=$1
        AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      GROUP BY 1
    ), days AS (
      SELECT payment_date FROM deliveries
      UNION
      SELECT payment_date
      FROM courier_payments
      WHERE courier_id=$1 AND payment_date BETWEEN $2::date AND $3::date
    )
    SELECT
      to_char(days.payment_date,'YYYY-MM-DD') AS summary_date,
      COALESCE(deliveries.delivery_count,0)::int AS live_delivery_count,
      p.*
    FROM days
    LEFT JOIN deliveries ON deliveries.payment_date=days.payment_date
    LEFT JOIN courier_payments p
      ON p.courier_id=$1 AND p.payment_date=days.payment_date
    ORDER BY days.payment_date
  `, [courier.id,startDate,endDate])).rows;

  if (!rows.length) return [];

  const rules = (await pool.query(`
    SELECT
      id,to_char(effective_from,'YYYY-MM-DD') AS effective_from,
      per_delivery,base_mon_thu,base_fri_sun,created_at
    FROM payment_rate_rules
    WHERE effective_from <= $1::date
    ORDER BY effective_from DESC,id DESC
  `, [endDate])).rows.map(r => ({
    id: r.id,
    effective_from: r.effective_from,
    per_delivery: Number(r.per_delivery),
    base_mon_thu: Number(r.base_mon_thu),
    base_fri_sun: Number(r.base_fri_sun),
    created_at: r.created_at || null
  }));

  const fallbackRule = {
    id: null,
    effective_from: "2000-01-01",
    per_delivery: 6,
    base_mon_thu: 60,
    base_fri_sun: 75,
    created_at: null
  };

  const out = [];
  for (const row of rows) {
    const rule = rules.find(r => r.effective_from <= row.summary_date) || fallbackRule;
    out.push(await buildPaymentRow(
      courier,
      row.id ? row : null,
      row.summary_date,
      rule,
      Number(row.live_delivery_count || 0)
    ));
  }
  return out;
}

function summarizeCourierPaymentDays(days) {
  return {
    total_amount: roundMoney(days.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
    delivery_count: days.reduce((sum, row) => sum + Number(row.delivery_count || 0), 0),
    worked_days: days.filter(row => Number(row.delivery_count || 0) > 0).length,
    paid_days: days.filter(row => row.status === "PAID").length
  };
}

async function getPaymentRows(date) {
  const rule = await getPaymentRateRule(date);
  const rows = (await pool.query(`
    WITH deliveries AS (
      SELECT d.courier_id,COUNT(o.id)::int AS delivery_count
      FROM dispatches d
      JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
      GROUP BY d.courier_id
    )
    SELECT
      u.id,u.name,u.username,u.nickname,u.pix_key,u.pix_type,u.pix_holder_name,u.pix_status,
      COALESCE(del.delivery_count,0)::int AS live_delivery_count,
      p.id AS payment_id,p.tip_amount,p.discount_amount,p.adjustment_amount,
      p.payment_method,p.status,p.notes,
      p.delivery_count_snapshot,p.per_delivery_snapshot,p.base_snapshot,p.total_snapshot,
      p.pix_key_snapshot,p.pix_type_snapshot,p.pix_holder_name_snapshot,p.pix_status_snapshot,p.reviewed_at,p.paid_at
    FROM users u
    LEFT JOIN deliveries del ON del.courier_id=u.id
    LEFT JOIN courier_payments p ON p.courier_id=u.id AND p.payment_date=$1::date
    WHERE u.role='courier'
      AND (COALESCE(del.delivery_count,0)>0 OR p.id IS NOT NULL)
    ORDER BY u.name
  `, [date])).rows;

  const out = [];
  for (const r of rows) {
    out.push(await buildPaymentRow(
      {
        id: r.id,
        name: r.name,
        username: r.username,
        nickname: r.nickname,
        pix_key: r.pix_key,
        pix_type: r.pix_type,
        pix_holder_name: r.pix_holder_name,
        pix_status: r.pix_status
      },
      r.payment_id ? {
        id: r.payment_id,
        tip_amount: r.tip_amount,
        discount_amount: r.discount_amount,
        adjustment_amount: r.adjustment_amount,
        payment_method: r.payment_method,
        status: r.status,
        notes: r.notes,
        delivery_count_snapshot: r.delivery_count_snapshot,
        per_delivery_snapshot: r.per_delivery_snapshot,
        base_snapshot: r.base_snapshot,
        total_snapshot: r.total_snapshot,
        pix_key_snapshot: r.pix_key_snapshot,
        pix_type_snapshot: r.pix_type_snapshot,
        pix_holder_name_snapshot: r.pix_holder_name_snapshot,
        pix_status_snapshot: r.pix_status_snapshot,
        reviewed_at: r.reviewed_at,
        paid_at: r.paid_at
      } : null,
      date,
      rule,
      Number(r.live_delivery_count || 0)
    ));
  }
  return { rule, rows: out };
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
      message: `${user.name} (@${user.username}) solicitou acesso ao DespacheFull.`,
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

app.get("/api/admin/attendance/qr", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = await getSPDate();
  const { token, payload } = createAttendanceQrToken(date);
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const checkinUrl = new URL("/", baseUrl);
  checkinUrl.searchParams.set("attendance_token", token);

  res.json({
    date,
    url: checkinUrl.toString(),
    expires_at: new Date(payload.exp).toISOString(),
    refresh_after_ms: 30000,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/attendance", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();

  const rows = (await pool.query(`
    SELECT
      u.id AS courier_id,u.name,u.username,u.nickname,u.active,u.approval_status,
      a.id AS attendance_id,a.attendance_date,a.checked_in_at,a.checkin_method,
      a.admin_reason,admin_u.name AS checked_in_by_name,
      a.checked_out_at,a.checkout_reason,checkout_admin.name AS checked_out_by_name,
      p.last_seen_at,
      (p.last_seen_at >= NOW()-INTERVAL '150 seconds') AS is_online,
      active_dispatch.id AS active_dispatch_id,
      active_dispatch.operational_stage,
      active_dispatch.departed_at,
      active_dispatch.returning_at
    FROM users u
    LEFT JOIN courier_attendance a
      ON a.courier_id=u.id AND a.attendance_date=$1::date
    LEFT JOIN users admin_u ON admin_u.id=a.checked_in_by
    LEFT JOIN users checkout_admin ON checkout_admin.id=a.checked_out_by
    LEFT JOIN user_presence p ON p.user_id=u.id
    LEFT JOIN LATERAL (
      SELECT d.id,d.operational_stage,d.departed_at,d.returning_at
      FROM dispatches d
      WHERE d.courier_id=u.id AND d.status='ON_ROAD'
      ORDER BY d.departed_at DESC,d.id DESC
      LIMIT 1
    ) active_dispatch ON TRUE
    WHERE u.role='courier'
      AND u.active=true
      AND u.approval_status='APPROVED'
    ORDER BY
      CASE WHEN a.id IS NOT NULL THEN 0 ELSE 1 END,
      a.checked_in_at NULLS LAST,
      u.name
  `, [date])).rows.map(r => ({
    ...r,
    attended: !!r.attendance_id,
    ended: !!r.checked_out_at,
    present: !!r.attendance_id && !r.checked_out_at,
    outside: !!r.attendance_id && !r.checked_out_at && !!r.active_dispatch_id,
    available: !!r.attendance_id && !r.checked_out_at && !r.active_dispatch_id
  }));

  const attended = rows.filter(r => r.attended).length;
  const present = rows.filter(r => r.present).length;
  const outside = rows.filter(r => r.outside).length;
  const ended = rows.filter(r => r.ended).length;

  res.json({
    date,
    summary: {
      eligible: rows.length,
      attended,
      present,
      outside,
      available: Math.max(0, present - outside),
      ended,
      absent: Math.max(0, rows.length - attended)
    },
    rows,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/attendance/checkin", auth, adminOnly, asyncRoute(async (req, res) => {
  const courierId = Number(req.body.courier_id);
  const reason = String(req.body.reason || "").trim().slice(0, 250);
  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Selecione um motoboy." });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: "Informe o motivo da presença manual." });
  }

  const courier = (await pool.query(`
    SELECT id,name,active,approval_status
    FROM users
    WHERE id=$1 AND role='courier'
    LIMIT 1
  `, [courierId])).rows[0];

  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });
  if (!courier.active || courier.approval_status !== "APPROVED") {
    return res.status(409).json({ error: "O motoboy precisa estar ativo e aprovado." });
  }

  const date = await getSPDate();
  const inserted = await pool.query(`
    INSERT INTO courier_attendance(
      courier_id,attendance_date,checked_in_at,checkin_method,checked_in_by,admin_reason
    )
    VALUES($1,$2::date,NOW(),'ADMIN_MANUAL',$3,$4)
    ON CONFLICT(courier_id,attendance_date) DO NOTHING
    RETURNING *
  `, [courierId, date, req.session.user.id, reason]);

  const attendance = inserted.rows[0] || await getCourierAttendance(courierId, date);
  if (!inserted.rowCount && attendance?.checked_out_at) {
    return res.status(409).json({
      error: `${courier.name} teve o expediente encerrado hoje. A presença manual não reabre expediente encerrado.`,
      code: "SHIFT_ENDED",
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }

  if (inserted.rowCount) {
    await auditBestEffort(req.session.user.id, "ATTENDANCE_MANUAL_CHECKIN", "courier_attendance", attendance.id, {
      courier_id: courierId,
      courier_name: courier.name,
      attendance_date: date,
      reason
    });
    io.emit("attendance:changed", { courier_id: courierId, attendance_date: date });
  }

  res.status(inserted.rowCount ? 201 : 200).json({
    attendance,
    duplicate: !inserted.rowCount,
    message: inserted.rowCount
      ? `Presença de ${courier.name} confirmada pelo Admin.`
      : `${courier.name} já possui presença registrada hoje.`,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/attendance/:courierId/checkout", auth, adminOnly, asyncRoute(async (req, res) => {
  const courierId = Number(req.params.courierId);
  const reason = String(req.body.reason || "").trim().slice(0, 250);
  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Motoboy inválido." });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: "Informe o motivo do encerramento do expediente." });
  }

  const courier = (await pool.query(`
    SELECT id,name,active,approval_status
    FROM users
    WHERE id=$1 AND role='courier'
    LIMIT 1
  `, [courierId])).rows[0];
  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });

  const date = await getSPDate();
  const attendance = await getCourierAttendance(courierId, date);
  if (!attendance) {
    return res.status(409).json({
      error: `${courier.name} não possui presença registrada hoje.`,
      code: "ATTENDANCE_NOT_FOUND"
    });
  }
  if (attendance.checked_out_at) {
    return res.status(409).json({
      error: `O expediente de ${courier.name} já foi encerrado hoje.`,
      code: "SHIFT_ALREADY_ENDED",
      checked_out_at: attendance.checked_out_at
    });
  }

  const activeDispatch = (await pool.query(`
    SELECT id,dispatch_code,operational_stage,departed_at
    FROM dispatches
    WHERE courier_id=$1 AND status='ON_ROAD'
    ORDER BY departed_at DESC,id DESC
    LIMIT 1
  `, [courierId])).rows[0];

  if (activeDispatch) {
    return res.status(409).json({
      error: `${courier.name} ainda está ${activeDispatch.operational_stage === 'RETURNING' ? 'retornando para a loja' : 'em rota'}. Finalize a saída antes de encerrar o expediente.`,
      code: "SHIFT_HAS_ACTIVE_DISPATCH",
      dispatch_id: activeDispatch.id,
      operational_stage: activeDispatch.operational_stage
    });
  }

  const updated = (await pool.query(`
    UPDATE courier_attendance
    SET checked_out_at=NOW(),checked_out_by=$1,checkout_reason=$2
    WHERE id=$3 AND checked_out_at IS NULL
    RETURNING *
  `, [req.session.user.id, reason, attendance.id])).rows[0];

  if (!updated) {
    return res.status(409).json({ error: "O expediente já foi encerrado.", code: "SHIFT_ALREADY_ENDED" });
  }

  await auditBestEffort(req.session.user.id, "ATTENDANCE_ADMIN_CHECKOUT", "courier_attendance", updated.id, {
    courier_id: courierId,
    courier_name: courier.name,
    attendance_date: date,
    checked_in_at: attendance.checked_in_at,
    checked_out_at: updated.checked_out_at,
    reason
  });

  io.emit("attendance:changed", { courier_id: courierId, attendance_date: date, shift_ended: true });
  io.emit("dashboard:changed");

  res.json({
    attendance: updated,
    message: `Expediente de ${courier.name} encerrado pelo Admin.`,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/courier/attendance/checkin", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  const user = await currentUser(req.session.user.id);
  if (!user || !user.active || user.approval_status !== "APPROVED") {
    return res.status(403).json({ error: "Seu acesso não está ativo e aprovado." });
  }

  let payload;
  try {
    payload = await verifyAttendanceQrToken(req.body.token);
  } catch (err) {
    return res.status(err.status || 400).json({
      error: err.message || "QR de presença inválido.",
      code: err.code || "ATTENDANCE_QR_INVALID",
      server_now: new Date().toISOString()
    });
  }

  const inserted = await pool.query(`
    INSERT INTO courier_attendance(
      courier_id,attendance_date,checked_in_at,checkin_method
    )
    VALUES($1,$2::date,NOW(),'QR')
    ON CONFLICT(courier_id,attendance_date) DO NOTHING
    RETURNING *
  `, [req.session.user.id, payload.d]);

  const attendance = inserted.rows[0] || await getCourierAttendance(req.session.user.id, payload.d);
  if (!inserted.rowCount && attendance?.checked_out_at) {
    return res.status(409).json({
      error: "Seu expediente de hoje foi encerrado pelo Admin. O QR não pode reativar seu turno.",
      code: "SHIFT_ENDED",
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }

  if (inserted.rowCount) {
    await auditBestEffort(req.session.user.id, "ATTENDANCE_QR_CHECKIN", "courier_attendance", attendance.id, {
      attendance_date: payload.d,
      checkin_method: "QR"
    });
    io.emit("attendance:changed", {
      courier_id: req.session.user.id,
      attendance_date: payload.d
    });
  }

  res.status(inserted.rowCount ? 201 : 200).json({
    attendance,
    duplicate: !inserted.rowCount,
    message: inserted.rowCount
      ? "Presença confirmada. Você está ativo na operação de hoje."
      : "Sua presença de hoje já estava confirmada.",
    server_now: new Date().toISOString()
  });
}));

app.get("/api/courier/dashboard", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const user = await currentUser(req.session.user.id);
  const attendanceDate = await getSPDate();
  const attendanceRow = await getCourierAttendance(req.session.user.id, attendanceDate);

  let active = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,
           d.operational_stage,d.returning_at,d.returned_at,
           d.route_sla_minutes,d.return_sla_minutes,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1 AND d.status='ON_ROAD'
    ORDER BY d.id DESC LIMIT 1
  `, [req.session.user.id])).rows[0] || null;

  const operationalSla = await getOperationalSlaSettings();
  if (active) {
    const progressMap = await getDispatchProgressMap([active.id]);
    active = decorateOperationalDispatches([active], progressMap, operationalSla)[0];
  }

  const stats = (await pool.query(`
    SELECT
      COUNT(o.id) FILTER (
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today,
      COUNT(o.id) FILTER (
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo') >=
              date_trunc('week', NOW() AT TIME ZONE 'America/Sao_Paulo')
      )::int AS week,
      COUNT(o.id) FILTER (
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo') >=
              date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
      )::int AS month
    FROM dispatches d
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE d.courier_id=$1
  `, [req.session.user.id])).rows[0];

  const recent = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,d.operational_stage,d.returning_at,d.returned_at,d.released_at,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1
    ORDER BY d.id DESC LIMIT 30
  `, [req.session.user.id])).rows;

  res.json({
    active,
    stats,
    recent,
    attendance: {
      date: attendanceDate,
      present: !!attendanceRow && !attendanceRow.checked_out_at,
      attended: !!attendanceRow,
      shift_ended: !!attendanceRow?.checked_out_at,
      checked_in_at: attendanceRow?.checked_in_at || null,
      checked_out_at: attendanceRow?.checked_out_at || null,
      checkout_reason: attendanceRow?.checkout_reason || null,
      checkin_method: attendanceRow?.checkin_method || null
    },
    operational_sla: operationalSla,
    mustChangePassword: !!user?.must_change_password,
    server_now: new Date().toISOString()
  });
}));



app.post("/api/courier/dispatches/:id/start-return", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const owned = (await pool.query(`
    SELECT id,operational_stage FROM dispatches
    WHERE id=$1 AND courier_id=$2 AND status='ON_ROAD'
  `, [req.params.id, req.session.user.id])).rows[0];
  if (!owned) return res.status(404).json({ error: "Saída ativa não encontrada." });

  if (operationalStage(owned.operational_stage) === "RETURNING") {
    return res.json({ ok: true, already_returning: true, server_now: new Date().toISOString() });
  }

  const dispatch = await markDispatchReturning(req.params.id, {
    actorUserId: req.session.user.id,
    source: "COURIER_MANUAL",
    reason: "COURIER_CONFIRMED_ALL_DELIVERED"
  });
  res.json({ ok: true, dispatch, server_now: new Date().toISOString() });
}));

app.post("/api/courier/dispatches/:id/arrive", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const owned = (await pool.query(`
    SELECT id,operational_stage FROM dispatches
    WHERE id=$1 AND courier_id=$2 AND status='ON_ROAD'
  `, [req.params.id, req.session.user.id])).rows[0];
  if (!owned) return res.status(404).json({ error: "Saída ativa não encontrada." });
  if (operationalStage(owned.operational_stage) !== "RETURNING") {
    return res.status(409).json({
      error: "Primeiro confirme que terminou as entregas e iniciou o retorno.",
      code: "RETURN_NOT_STARTED"
    });
  }

  const dispatch = await completeDispatchReturn({
    dispatchId: req.params.id,
    courierId: req.session.user.id,
    actorUserId: req.session.user.id,
    source: "COURIER_ARRIVAL",
    reason: "COURIER_CONFIRMED_ARRIVAL"
  });
  res.json({ ok: true, dispatch, server_now: new Date().toISOString() });
}));

app.get("/api/courier/payment/today", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const date = await getSPDate();
  const rule = await getPaymentRateRule(date);

  const courier = (await pool.query(`
    SELECT id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status
    FROM users
    WHERE id=$1 AND role='courier'
  `, [req.session.user.id])).rows[0];

  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });

  const payment = (await pool.query(`
    SELECT *
    FROM courier_payments
    WHERE courier_id=$1 AND payment_date=$2::date
    LIMIT 1
  `, [req.session.user.id, date])).rows[0] || null;

  const liveCount = await getCourierDeliveryCount(req.session.user.id, date);
  const row = await buildPaymentRow(courier, payment, date, rule, liveCount);
  const boundaries = (await pool.query(`
    SELECT
      to_char(date_trunc('week',$1::date)::date,'YYYY-MM-DD') AS week_start,
      to_char(date_trunc('month',$1::date)::date,'YYYY-MM-DD') AS month_start
  `, [date])).rows[0];
  const periodStart = boundaries.week_start < boundaries.month_start
    ? boundaries.week_start
    : boundaries.month_start;
  const periodDays = await getCourierPaymentPeriodDays(courier, periodStart, date);
  const weekDays = periodDays.filter(x => x.payment_date >= boundaries.week_start);
  const monthDays = periodDays.filter(x => x.payment_date >= boundaries.month_start);

  res.json({
    payment: row,
    summary: {
      today: {
        total_amount: Number(row.total_amount || 0),
        delivery_count: Number(row.delivery_count || 0),
        worked_days: Number(row.delivery_count || 0) > 0 ? 1 : 0,
        paid_days: row.status === "PAID" ? 1 : 0
      },
      week: summarizeCourierPaymentDays(weekDays),
      month: summarizeCourierPaymentDays(monthDays),
      week_start: boundaries.week_start,
      month_start: boundaries.month_start,
      through: date
    },
    formula: "entregas × valor por entrega + encosta + gorjeta - desconto + ajuste",
    server_now: new Date().toISOString()
  });
}));


app.get("/api/courier/pix", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const date = await getSPDate();

  const courier = (await pool.query(`
    SELECT id,name,username,pix_key,pix_type,pix_holder_name,pix_status,
           pix_verified_at,pix_updated_at
    FROM users
    WHERE id=$1 AND role='courier'
  `, [req.session.user.id])).rows[0];

  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });

  const paidToday = (await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM courier_payments
      WHERE courier_id=$1 AND payment_date=$2::date AND status='PAID'
    ) AS paid
  `, [req.session.user.id, date])).rows[0]?.paid === true;

  const status = normalizedPixStatus(courier.pix_status, !!courier.pix_key);

  res.json({
    pix: {
      pix_key: courier.pix_key || "",
      pix_type: courier.pix_type || "",
      pix_holder_name: courier.pix_holder_name || "",
      status,
      status_label: pixStatusLabel(status),
      verified_at: courier.pix_verified_at || null,
      updated_at: courier.pix_updated_at || null,
      can_edit: !paidToday,
      locked_reason: paidToday
        ? "O pagamento de hoje já foi marcado como PAGO. O PIX poderá ser alterado a partir do próximo dia."
        : null
    },
    server_now: new Date().toISOString()
  });
}));

app.put("/api/courier/pix", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const date = await getSPDate();

  const paidToday = (await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM courier_payments
      WHERE courier_id=$1 AND payment_date=$2::date AND status='PAID'
    ) AS paid
  `, [req.session.user.id, date])).rows[0]?.paid === true;

  if (paidToday) {
    return res.status(409).json({
      error: "O pagamento de hoje já foi marcado como PAGO. Você poderá alterar o PIX a partir do próximo dia.",
      code: "PIX_LOCKED_TODAY"
    });
  }

  const pix = normalizePixInput(req.body);
  const current = (await pool.query(`
    SELECT id,name,username,pix_key,pix_type,pix_holder_name,pix_status
    FROM users
    WHERE id=$1 AND role='courier'
  `, [req.session.user.id])).rows[0];

  if (!current) return res.status(404).json({ error: "Motoboy não encontrado." });

  const unchanged =
    String(current.pix_key || "") === String(pix.pix_key || "") &&
    String(current.pix_type || "") === String(pix.pix_type || "") &&
    String(current.pix_holder_name || "") === String(pix.pix_holder_name || "");

  if (unchanged) {
    const currentStatus = normalizedPixStatus(current.pix_status, !!current.pix_key);
    return res.json({
      pix: {
        pix_key: current.pix_key || "",
        pix_type: current.pix_type || "",
        pix_holder_name: current.pix_holder_name || "",
        status: currentStatus,
        status_label: pixStatusLabel(currentStatus),
        can_edit: true
      },
      message: currentStatus === "VERIFIED"
        ? "Seu PIX já está confirmado."
        : currentStatus === "PENDING"
          ? "Seu PIX já está aguardando confirmação do administrador."
          : "Nenhum PIX cadastrado.",
      server_now: new Date().toISOString()
    });
  }

  const newStatus = pix.empty ? "NONE" : "PENDING";
  const q = await pool.query(`
    UPDATE users
    SET pix_key=$1,
        pix_type=$2,
        pix_holder_name=$3,
        pix_status=$4,
        pix_verified_at=NULL,
        pix_verified_by=NULL,
        pix_updated_at=NOW()
    WHERE id=$5 AND role='courier'
    RETURNING id,name,username,pix_key,pix_type,pix_holder_name,pix_status,
              pix_verified_at,pix_updated_at
  `, [pix.pix_key,pix.pix_type,pix.pix_holder_name,newStatus,req.session.user.id]);

  await savePixHistory({
    courierId: current.id,
    pixKey: pix.pix_key,
    pixType: pix.pix_type,
    holderName: pix.pix_holder_name,
    status: newStatus,
    source: "COURIER",
    changedBy: current.id
  });

  await audit(current.id, pix.empty ? "COURIER_PIX_REMOVED" : "COURIER_PIX_SUBMITTED", "user", current.id, {
    pix_type: pix.pix_type,
    pix_status: newStatus
  });

  if (!pix.empty) {
    await createNotification({
      type: "PIX_PENDING",
      severity: "info",
      title: "PIX aguardando confirmação",
      message: `${current.name} cadastrou ou alterou a chave PIX. Confira os dados antes do pagamento.`,
      courierId: current.id,
      uniqueKey: `pix-pending:${current.id}:${Date.now()}`
    });
  }

  io.emit("courier:changed");
  io.emit("payment:changed", { courier_id: current.id });
  io.emit("pix:changed", { courier_id: current.id });

  res.json({
    pix: {
      pix_key: q.rows[0].pix_key || "",
      pix_type: q.rows[0].pix_type || "",
      pix_holder_name: q.rows[0].pix_holder_name || "",
      status: newStatus,
      status_label: pixStatusLabel(newStatus),
      verified_at: null,
      updated_at: q.rows[0].pix_updated_at,
      can_edit: true
    },
    message: pix.empty
      ? "PIX removido."
      : "PIX enviado. Aguarde a confirmação do administrador antes de ele ser usado para pagamento.",
    server_now: new Date().toISOString()
  });
}));

app.get("/api/courier/ifood/deliveries", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");
  const deliveries = await getCourierIfoodDeliveries(req.session.user.id);

  res.json({
    ...deliveries,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/courier/ifood/orders/:orderId/verify-delivery", auth, courierOnly, deliveryCodeLimiter, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  if (!ifoodConfigured()) {
    return res.status(503).json({
      error: "A integração com o iFood não está configurada.",
      code: "IFOOD_NOT_CONFIGURED"
    });
  }

  const orderId = String(req.params.orderId || "").trim();
  const deliveryCode = normalizeDeliveryCode(req.body?.code);

  if (!validDeliveryCode(deliveryCode)) {
    return res.status(400).json({
      error: "Digite o código do cliente usando somente 4 a 8 números.",
      code: "DELIVERY_CODE_FORMAT"
    });
  }

  const row = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.merchant_id,o.status AS order_status,o.order_type,o.delivered_by,
      l.dispatch_id,l.local_order_number,l.ifood_dispatch_status,
      d.courier_id,d.departed_at,d.status AS dispatch_status,
      c.status AS confirmation_status,c.attempts,c.verified_at,c.concluded_at,
      c.processing_started_at
    FROM ifood_dispatch_links l
    JOIN ifood_orders o ON o.order_id=l.ifood_order_id
    JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN ifood_delivery_confirmations c ON c.ifood_order_id=o.order_id
    WHERE l.ifood_order_id=$1
      AND d.courier_id=$2
      AND d.departed_at >= NOW()-INTERVAL '24 hours'
    LIMIT 1
  `, [orderId, req.session.user.id])).rows[0];

  if (!row) {
    return res.status(404).json({
      error: "Essa entrega não está vinculada a você.",
      code: "DELIVERY_NOT_ASSIGNED"
    });
  }

  if (String(row.order_type || "").toUpperCase() !== "DELIVERY" ||
      String(row.delivered_by || "").toUpperCase() !== "MERCHANT") {
    return res.status(409).json({
      error: "Esse pedido não é uma entrega própria da loja.",
      code: "DELIVERY_NOT_MERCHANT"
    });
  }

  if (!ifoodMerchantAllowed(row.merchant_id)) {
    return res.status(403).json({
      error: "Essa loja não está autorizada para operações iFood neste ambiente.",
      code: "IFOOD_MERCHANT_BLOCKED"
    });
  }

  const orderStatus = canonicalIfoodOrderStatus(row.order_status);
  const confirmationStatus = deliveryConfirmationLabel(row.confirmation_status, row.order_status);

  if (["CONCLUDED","DELIVERED"].includes(orderStatus) || confirmationStatus === "CONCLUDED") {
    return res.json({
      ok: true,
      verified: true,
      concluded: true,
      already_confirmed: true,
      message: "Essa entrega já está concluída no iFood.",
      order: { order_id: row.order_id, display_id: row.display_id }
    });
  }

  if (confirmationStatus === "VERIFIED") {
    return res.json({
      ok: true,
      verified: true,
      concluded: false,
      already_confirmed: true,
      message: "O código dessa entrega já foi validado pelo iFood.",
      order: { order_id: row.order_id, display_id: row.display_id }
    });
  }

  if (orderStatus === "CANCELLED") {
    return res.status(409).json({
      error: "Esse pedido foi cancelado no iFood.",
      code: "DELIVERY_CANCELLED"
    });
  }

  const dispatchStatus = String(row.ifood_dispatch_status || "").trim().toUpperCase();
  if (
    !["API_ACCEPTED","DISPATCHED"].includes(dispatchStatus) &&
    orderStatus !== "DISPATCHED"
  ) {
    return res.status(409).json({
      error: dispatchStatus === "FAILED"
        ? "O despacho desse pedido está com erro no iFood. Avise o administrador."
        : "Aguarde o iFood receber o despacho antes de confirmar a entrega.",
      code: dispatchStatus === "FAILED" ? "IFOOD_DISPATCH_FAILED" : "IFOOD_DISPATCH_NOT_READY"
    });
  }

  await pool.query(`
    INSERT INTO ifood_delivery_confirmations(
      ifood_order_id,dispatch_id,courier_id,status
    )
    VALUES($1,$2,$3,'PENDING')
    ON CONFLICT(ifood_order_id) DO NOTHING
  `, [row.order_id,row.dispatch_id,req.session.user.id]);

  const claim = await pool.query(`
    UPDATE ifood_delivery_confirmations
    SET status='PROCESSING',
        attempts=attempts+1,
        processing_started_at=NOW(),
        last_attempt_at=NOW(),
        last_http_status=NULL,
        last_error=NULL,
        updated_at=NOW()
    WHERE ifood_order_id=$1
      AND courier_id=$2
      AND (
        status IN ('PENDING','FAILED')
        OR (status='PROCESSING' AND processing_started_at < NOW()-INTERVAL '2 minutes')
      )
    RETURNING *
  `, [row.order_id,req.session.user.id]);

  if (!claim.rowCount) {
    const current = (await pool.query(`
      SELECT status,verified_at,concluded_at,processing_started_at
      FROM ifood_delivery_confirmations
      WHERE ifood_order_id=$1
    `, [row.order_id])).rows[0];

    if (["VERIFIED","CONCLUDED"].includes(String(current?.status || "").toUpperCase())) {
      return res.json({
        ok: true,
        verified: true,
        concluded: String(current.status).toUpperCase() === "CONCLUDED",
        already_confirmed: true,
        message: "Essa entrega já foi confirmada.",
        order: { order_id: row.order_id, display_id: row.display_id }
      });
    }

    return res.status(409).json({
      error: "Essa confirmação já está sendo processada. Aguarde alguns segundos.",
      code: "DELIVERY_CONFIRMATION_PROCESSING"
    });
  }

  try {
    const { response, body } = await ifoodApi(
      `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(row.order_id)}/verifyDeliveryCode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: deliveryCode })
      }
    );

    const explicitValid =
      typeof body?.valid === "boolean" ? body.valid :
      typeof body?.success === "boolean" ? body.success :
      null;

    if (explicitValid === false) {
      await pool.query(`
        UPDATE ifood_delivery_confirmations
        SET status='FAILED',
            processing_started_at=NULL,
            last_http_status=$2,
            last_error='Código não validado pelo iFood.',
            last_response=$3,
            updated_at=NOW()
        WHERE ifood_order_id=$1
      `, [row.order_id,response.status,JSON.stringify(body || {})]);

      return res.status(422).json({
        error: "Código incorreto. Confira com o cliente e tente novamente.",
        code: "DELIVERY_CODE_INVALID"
      });
    }

    await pool.query(`
      UPDATE ifood_delivery_confirmations
      SET status='VERIFIED',
          processing_started_at=NULL,
          last_http_status=$2,
          last_error=NULL,
          last_response=$3,
          verified_at=COALESCE(verified_at,NOW()),
          updated_at=NOW()
      WHERE ifood_order_id=$1
    `, [row.order_id,response.status,JSON.stringify(body || { valid: true })]);

    await auditBestEffort(
      req.session.user.id,
      "IFOOD_DELIVERY_CODE_VERIFIED",
      "ifood_order",
      row.order_id,
      {
        display_id: row.display_id || null,
        dispatch_id: row.dispatch_id,
        http_status: response.status
      }
    );

    io.emit("ifood:changed");
    io.emit("delivery:changed", {
      courier_id: req.session.user.id,
      order_id: row.order_id
    });

    await maybeAutoMarkDispatchReturning(row.dispatch_id, {
      actorUserId: req.session.user.id,
      source: "AUTO_IFOOD_VERIFIED"
    });

    setImmediate(() => {
      syncIfoodOnce({ reason: "delivery_confirmation" }).catch(err => {
        console.error("iFood sync after delivery verification:", ifoodSafeError(err));
      });
    });

    return res.json({
      ok: true,
      verified: true,
      concluded: false,
      message: "Código aceito pelo iFood. Entrega confirmada.",
      order: {
        order_id: row.order_id,
        display_id: row.display_id
      },
      server_now: new Date().toISOString()
    });
  } catch (err) {
    const status = Number(err?.statusCode || 0);
    const userCodeError = status === 400 || status === 422;

    await pool.query(`
      UPDATE ifood_delivery_confirmations
      SET status='FAILED',
          processing_started_at=NULL,
          last_http_status=$2,
          last_error=$3,
          updated_at=NOW()
      WHERE ifood_order_id=$1
    `, [
      row.order_id,
      status || null,
      userCodeError
        ? "Código não validado pelo iFood."
        : ifoodSafeError(err)
    ]);

    io.emit("delivery:changed", {
      courier_id: req.session.user.id,
      order_id: row.order_id
    });

    if (userCodeError) {
      return res.status(422).json({
        error: "Código incorreto. Confira com o cliente e tente novamente.",
        code: "DELIVERY_CODE_INVALID"
      });
    }

    if (status === 404 || status === 409 || status === 412) {
      return res.status(409).json({
        error: "O iFood ainda não liberou a confirmação desse pedido. Atualize e tente novamente.",
        code: "DELIVERY_NOT_ELIGIBLE"
      });
    }

    if (status === 429 || status >= 500 || status === 0) {
      return res.status(503).json({
        error: "Não foi possível confirmar agora porque o iFood está indisponível. Tente novamente em instantes.",
        code: "IFOOD_TEMPORARY_ERROR"
      });
    }

    throw err;
  }
}));

app.get("/api/courier/ifood/available", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  const orders = await getAvailableIfoodOrders(req.query.q || "", req.query.limit || 30);

  const partnerCount = Number((await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM ifood_orders o
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    WHERE UPPER(COALESCE(o.order_type,''))='DELIVERY'
      AND UPPER(COALESCE(o.delivered_by,''))='IFOOD'
      AND l.ifood_order_id IS NULL
      AND UPPER(COALESCE(o.status,''))<>'CANCELLED'
      AND UPPER(COALESCE(o.status,''))<>'CONCLUDED'
      AND UPPER(COALESCE(o.status,''))<>'DISPATCHED'
  `)).rows[0]?.c || 0);

  res.json({
    orders,
    partnerDeliveryCount: partnerCount,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/courier/ifood/lookup", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  let order = String(req.query.order || "").trim();
  if (!order) return res.status(400).json({ error: "Informe o pedido." });
  if (!order.startsWith("#")) order = "#" + order;

  const inspection = await inspectIfoodOrdersForDeparture([order]);

  if (inspection.blocked.length) {
    return res.json({
      found: true,
      valid: false,
      ...inspection.blocked[0]
    });
  }

  if (inspection.accepted.length) {
    return res.json({
      found: true,
      valid: true,
      ...inspection.accepted[0]
    });
  }

  res.json({
    found: false,
    valid: false,
    manual: false,
    code: "IFOOD_ORDER_REQUIRED",
    order_number: order,
    message: "Pedido não encontrado no iFood. O motoboy só pode sair com pedidos iFood vinculados e disponíveis."
  });
}));

app.post("/api/courier/depart", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  const user = await currentUser(req.session.user.id);
  if (user?.must_change_password) {
    return res.status(403).json({ error: "Altere sua senha temporária antes de registrar uma saída." });
  }

  const attendanceDate = await getSPDate();
  const attendance = await getCourierAttendance(req.session.user.id, attendanceDate);
  if (!attendance) {
    return res.status(403).json({
      error: "Confirme sua presença pelo QR da loja antes de registrar uma saída.",
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate,
      server_now: new Date().toISOString()
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: "Seu expediente foi encerrado pelo Admin. Você não pode registrar novas saídas hoje.",
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }

  const orders = normalizeOrders(req.body);
  const clientToken = String(req.body.client_token || "").trim().slice(0, 100) || null;

  // v2.9: o motoboy precisa estar online para validar o pedido no iFood no
  // momento da saída. A saída manual/offline fica exclusiva do administrador.
  if (req.body.offline_queued === true) {
    await logOperationalConflict({
      type: "COURIER_OFFLINE_DEPARTURE_BLOCKED",
      severity: "warning",
      actorUserId: req.session.user.id,
      courierId: req.session.user.id,
      orders,
      details: { reason: "IFOOD_ONLINE_VALIDATION_REQUIRED" }
    });
    return res.status(409).json({
      error: "Saída offline não é permitida para motoboy. Conecte-se à internet para validar os pedidos no iFood, ou peça ao administrador para registrar uma saída manual.",
      code: "IFOOD_ONLINE_VALIDATION_REQUIRED",
      server_now: new Date().toISOString()
    });
  }

  const ifoodInspection = await inspectIfoodOrdersForDeparture(orders);
  if (ifoodInspection.blocked.length) {
    return res.status(409).json({
      error: ifoodInspection.blocked[0].message,
      code: ifoodInspection.blocked[0].code,
      ifood: ifoodInspection.blocked[0],
      server_now: new Date().toISOString()
    });
  }

  // Todo pedido informado pelo motoboy precisa existir no iFood e passar pela
  // validação de entrega própria. Pedidos não encontrados são considerados
  // manuais e só podem ser registrados pelo endpoint administrativo.
  const matchedIfoodOrders = new Set(
    ifoodInspection.matched.map(x => plainLocalOrderNumber(x.order_number))
  );
  const missingIfoodOrders = orders.filter(
    x => !matchedIfoodOrders.has(plainLocalOrderNumber(x))
  );

  if (missingIfoodOrders.length) {
    await logOperationalConflict({
      type: "COURIER_NON_IFOOD_ORDER_BLOCKED",
      severity: "warning",
      actorUserId: req.session.user.id,
      courierId: req.session.user.id,
      orders: missingIfoodOrders,
      details: { requested_orders: orders }
    });
    return res.status(409).json({
      error: `Pedido(s) ${missingIfoodOrders.join(", ")} não encontrado(s) no iFood. Somente o administrador pode registrar saída manual.`,
      code: "IFOOD_ORDER_REQUIRED",
      missing_orders: missingIfoodOrders,
      server_now: new Date().toISOString()
    });
  }

  if (ifoodInspection.accepted.length !== orders.length) {
    return res.status(409).json({
      error: "Todos os pedidos da saída precisam estar vinculados ao iFood e disponíveis para entrega própria.",
      code: "IFOOD_ORDER_REQUIRED",
      server_now: new Date().toISOString()
    });
  }

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
    SELECT d.id,d.departed_at,d.order_number,d.operational_stage,d.returning_at,${orderArraySql("d")}
    FROM dispatches d
    WHERE d.courier_id=$1 AND d.status='ON_ROAD'
    ORDER BY d.departed_at DESC,d.id DESC
    LIMIT 1
  `, [req.session.user.id]);

  if (activeQ.rowCount) {
    const active = activeQ.rows[0];
    const returning = operationalStage(active.operational_stage) === "RETURNING";
    return res.status(409).json({
      error: returning
        ? "Você ainda está retornando. Toque em ‘Cheguei na loja’ antes de registrar outra saída."
        : "Você ainda possui uma saída em andamento. Finalize as entregas, inicie o retorno e confirme ‘Cheguei na loja’ antes de registrar outra saída.",
      code: "RETURN_CHECKIN_REQUIRED",
      active,
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
      departedAt: queuedDeparture,
      ifoodLinks: ifoodInspection.accepted
    });
  } catch (e) {
    if (e.code === "RETURN_CHECKIN_REQUIRED") {
      return res.status(409).json({
        error: e.message,
        code: e.code,
        active: e.active || null,
        server_now: new Date().toISOString()
      });
    }
    if (e.code === "IFOOD_ORDER_ALREADY_LINKED") {
      return res.status(409).json({
        error: e.message,
        code: "IFOOD_ORDER_ALREADY_LINKED"
      });
    }

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
      checkin_gate_enforced: true
    });
  }

  io.emit("dispatch:changed", { courier_id: req.session.user.id, dispatch_id: result.dispatch.id, change: "CREATED" });

  const ifoodDispatchQueued = ifoodInspection.accepted.length;

  res.status(result.duplicate ? 200 : 201).json({
    dispatch: result.dispatch,
    closed_previous: result.closedPrevious,
    duplicate: result.duplicate,
    ifood_dispatch: {
      linked_orders: ifoodDispatchQueued,
      queued: ifoodDispatchQueued > 0,
      automatic_enabled: ifoodDispatchEnabled(),
      mode: ifoodDispatchQueued
        ? (ifoodDispatchEnabled() ? "ASYNC_AUTOMATIC" : "WAITING_ENABLE")
        : "NONE"
    },
    server_now: new Date().toISOString()
  });

  if (ifoodDispatchQueued > 0) {
    setImmediate(() => {
      runIfoodDispatchWorkerOnce().catch(err => {
        console.error("iFood dispatch after departure:", ifoodDispatchErrorText(err));
      });
    });
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
           d.operational_stage,d.returning_at,d.returned_at,d.route_sla_minutes,d.return_sla_minutes,
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
      CASE
        WHEN d.status='RELEASED' THEN 'CONCLUÍDO'
        WHEN d.operational_stage='RETURNING' THEN 'RETORNANDO'
        ELSE 'EM ROTA'
      END AS status,
      CASE WHEN d.returning_at IS NULL THEN '' ELSE
        to_char(d.returning_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS returning_br,
      CASE WHEN COALESCE(d.returned_at,d.released_at) IS NULL THEN '' ELSE
        to_char(COALESCE(d.returned_at,d.released_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS returned_br,
      COALESCE(d.route_sla_minutes,0)::int AS route_sla_minutes,
      COALESCE(d.return_sla_minutes,0)::int AS return_sla_minutes
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date
          BETWEEN $1::date AND $2::date
    ORDER BY d.departed_at,o.id
  `, [from, to])).rows;

  const header = [
    "Data","Horário da saída","Motoboy","Usuário","Pedido",
    "Código da saída","Status","Retorno iniciado","Chegada na loja","SLA rota (min)","SLA retorno (min)"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      r.date_br,r.time_br,r.courier_name,r.username,r.order_number,
      r.dispatch_code,r.status,r.returning_br,r.returned_br,r.route_sla_minutes,r.return_sla_minutes
    ].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="despachefull-${from}-a-${to}.csv"`
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

  const attendanceDate = await getSPDate();
  const attendance = await getCourierAttendance(courierId, attendanceDate);
  if (!attendance) {
    return res.status(409).json({
      error: "Este motoboy ainda não confirmou presença hoje. Confirme pelo QR ou registre a presença manualmente antes da saída.",
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: "O expediente deste motoboy já foi encerrado pelo Admin. Nova saída bloqueada.",
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      checked_out_at: attendance.checked_out_at
    });
  }

  const orders = normalizeOrders(req.body);
  const reason = String(req.body.reason || "").trim().slice(0, 250);

  const ifoodInspection = await inspectIfoodOrdersForDeparture(orders);
  if (ifoodInspection.blocked.length) {
    return res.status(409).json({
      error: ifoodInspection.blocked[0].message,
      code: ifoodInspection.blocked[0].code,
      ifood: ifoodInspection.blocked[0]
    });
  }
  const clientToken = String(req.body.client_token || "").trim().slice(0, 100) || null;

  if (clientToken) {
    const replay = await pool.query("SELECT id FROM dispatches WHERE client_token=$1 LIMIT 1", [clientToken]);
    if (replay.rowCount) {
      return res.json({ duplicate: true, dispatch: { id: replay.rows[0].id } });
    }
  }

  const activeCourierDispatch = (await pool.query(`
    SELECT id,dispatch_code,departed_at,operational_stage,returning_at
    FROM dispatches
    WHERE courier_id=$1 AND status='ON_ROAD'
    ORDER BY departed_at DESC,id DESC
    LIMIT 1
  `, [courierId])).rows[0];

  if (activeCourierDispatch) {
    return res.status(409).json({
      error: "Este motoboy ainda não confirmou a chegada à loja. Confirme a chegada antes de registrar uma nova saída, inclusive pelo Admin.",
      code: "RETURN_CHECKIN_REQUIRED",
      active: activeCourierDispatch
    });
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

  let result;
  try {
    result = await createDispatchTransaction({
      actorUserId: req.session.user.id,
      courierId,
      orders,
      source: "ADMIN",
      adminReason: reason || "Registro manual pelo administrador",
      clientToken,
      ifoodLinks: ifoodInspection.accepted
    });
  } catch (e) {
    if (e.code === "RETURN_CHECKIN_REQUIRED") {
      return res.status(409).json({
        error: e.message,
        code: e.code,
        active: e.active || null
      });
    }
    throw e;
  }

  if (!result.duplicate) {
    await auditBestEffort(req.session.user.id, "MANUAL_DEPARTURE_REGISTERED", "dispatch", result.dispatch.id, {
      courier_id: courierId,
      courier_name: courier.name,
      order_numbers: orders,
      order_count: orders.length,
      reason: reason || "Não informado",
      checkin_gate_enforced: true
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

  io.emit("dispatch:changed", { courier_id: courierId, dispatch_id: result.dispatch.id, change: "CREATED" });
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
      COUNT(*) FILTER (WHERE operational IN ('NA_RUA','RETORNANDO'))::int AS on_road,
      COUNT(*) FILTER (WHERE operational='NA_RUA')::int AS en_route,
      COUNT(*) FILTER (WHERE operational='RETORNANDO')::int AS returning,
      COUNT(*) FILTER (WHERE operational='DISPONIVEL')::int AS available,
      COUNT(*) FILTER (WHERE operational='AUSENTE')::int AS absent,
      COUNT(*) FILTER (WHERE operational='AUSENTE')::int AS offline,
      COUNT(*) FILTER (WHERE operational='INATIVO')::int AS inactive
    FROM (
      SELECT CASE
        WHEN u.active=false THEN 'INATIVO'
        WHEN a.id IS NULL THEN 'AUSENTE'
        WHEN EXISTS(SELECT 1 FROM dispatches d WHERE d.courier_id=u.id AND d.status='ON_ROAD' AND d.operational_stage='RETURNING') THEN 'RETORNANDO'
        WHEN EXISTS(SELECT 1 FROM dispatches d WHERE d.courier_id=u.id AND d.status='ON_ROAD') THEN 'NA_RUA'
        ELSE 'DISPONIVEL'
      END AS operational
      FROM users u
      LEFT JOIN courier_attendance a
        ON a.courier_id=u.id
       AND a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
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


function ifoodWallboardPreparationState(row, nowMs = Date.now()) {
  const minutes = Number(row?.preparation_time_minutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return {
      preparation_status: "UNAVAILABLE",
      preparation_base_at: null,
      preparation_deadline_at: null
    };
  }

  const scheduled = String(row?.order_timing || "").toUpperCase() === "SCHEDULED";
  const baseValue = scheduled && row?.preparation_start_at
    ? row.preparation_start_at
    : (row?.confirmed_at || row?.order_created_at || row?.preparation_start_at);

  const baseMs = Date.parse(baseValue || "");
  if (!Number.isFinite(baseMs)) {
    return {
      preparation_status: "UNAVAILABLE",
      preparation_base_at: null,
      preparation_deadline_at: null
    };
  }

  const totalMs = minutes * 60_000;
  const elapsedMs = nowMs - baseMs;
  const ratio = elapsedMs / totalMs;

  return {
    preparation_status: ratio >= 1 ? "LATE" : ratio >= 0.5 ? "ALERT" : "NORMAL",
    preparation_base_at: new Date(baseMs).toISOString(),
    preparation_deadline_at: new Date(baseMs + totalMs).toISOString()
  };
}

app.get("/api/admin/wallboard", auth, adminOnly, asyncRoute(async (req, res) => {
  const orders = (await pool.query(`
    WITH bounds AS (
      SELECT
        (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS start_at,
        ((date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo') AS end_at
    )
    SELECT
      o.order_id,
      o.display_id,
      o.status,
      o.delivered_by,
      o.order_timing,
      o.order_created_at,
      o.preparation_start_at,
      o.last_event_at,
      o.updated_at,
      ce.confirmed_at,
      m.name AS merchant_name,
      pt.preparation_time_minutes,
      pt.synced_at AS preparation_time_synced_at,
      pt.last_error AS preparation_time_error,
      l.ifood_dispatch_status,
      d.status AS local_dispatch_status,
      d.departed_at,
      u.name AS courier_name,
      dc.status AS delivery_confirmation_status,
      dc.verified_at,
      dc.concluded_at,
      CASE
        WHEN UPPER(COALESCE(o.status,'')) IN ('CANCELLED','ORDER_CANCELLED') THEN 'CANCELLED'
        WHEN UPPER(COALESCE(dc.status,'')) IN ('VERIFIED','CONCLUDED')
          OR UPPER(COALESCE(o.status,'')) IN ('CONCLUDED','DELIVERED')
          OR UPPER(COALESCE(l.ifood_dispatch_status,''))='CONCLUDED' THEN 'CONFIRMED'
        WHEN UPPER(COALESCE(o.status,''))='DISPATCHED'
          OR UPPER(COALESCE(l.ifood_dispatch_status,'')) IN ('API_ACCEPTED','DISPATCHED')
          OR UPPER(COALESCE(d.status,''))='ON_ROAD' THEN 'ON_ROAD'
        ELSE 'PREPARING'
      END AS operational_status
    FROM ifood_orders o
    CROSS JOIN bounds b
    LEFT JOIN ifood_merchants m ON m.merchant_id=o.merchant_id
    LEFT JOIN ifood_preparation_times pt ON pt.merchant_id=o.merchant_id
    LEFT JOIN LATERAL (
      SELECT e.event_created_at AS confirmed_at
      FROM ifood_events e
      WHERE e.order_id=o.order_id
        AND UPPER(COALESCE(e.full_code,e.code,'')) IN ('CONFIRMED','CFM')
      ORDER BY e.event_created_at ASC NULLS LAST,e.received_at ASC
      LIMIT 1
    ) ce ON TRUE
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN ifood_delivery_confirmations dc ON dc.ifood_order_id=o.order_id
    LEFT JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN users u ON u.id=d.courier_id
    WHERE UPPER(COALESCE(o.order_type,''))='DELIVERY'
      AND (
        (o.order_created_at >= b.start_at AND o.order_created_at < b.end_at)
        OR (o.order_created_at IS NULL AND o.updated_at >= b.start_at AND o.updated_at < b.end_at)
      )
    ORDER BY COALESCE(o.order_created_at,o.last_event_at,o.updated_at) ASC,o.order_id ASC
  `)).rows;

  // KDS: somente DELIVERY entra no quadro de despacho.
  // TAKEOUT/DINE_IN continuam preservados no histórico/iFood, mas não ocupam o Telão.
  // Cancelados deixam o quadro operacional, mas continuam preservados no histórico/iFood.
  // O tempo de preparo vem do iFood (Meu Tempo de Preparo), nunca de um prazo fixo local.
  const nowMs = Date.now();
  const visibleOrders = orders
    .filter(x => x.operational_status !== 'CANCELLED')
    .map(x => x.operational_status === 'PREPARING'
      ? { ...x, ...ifoodWallboardPreparationState(x, nowMs) }
      : x);
  const preparing = visibleOrders.filter(x => x.operational_status === 'PREPARING').length;
  const onRoad = visibleOrders.filter(x => x.operational_status === 'ON_ROAD').length;
  const confirmed = visibleOrders.filter(x => x.operational_status === 'CONFIRMED').length;

  res.json({
    metrics: {
      preparing,
      onRoad,
      confirmedToday: confirmed,
      totalToday: visibleOrders.length
    },
    orders: visibleOrders,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/ifood/status", auth, adminOnly, asyncRoute(async (req, res) => {
  const configuredMerchantId = ifoodPrimaryMerchantId();

  const merchants = (await pool.query(`
    SELECT merchant_id AS id,name,corporate_name,last_seen_at
    FROM ifood_merchants
    ORDER BY name NULLS LAST,merchant_id
  `)).rows;

  const preparationTimes = (await pool.query(`
    SELECT
      p.merchant_id,p.preparation_time_minutes,p.source,p.synced_at,
      p.last_error,p.last_error_at,p.updated_at,m.name AS merchant_name
    FROM ifood_preparation_times p
    LEFT JOIN ifood_merchants m ON m.merchant_id=p.merchant_id
    ORDER BY m.name NULLS LAST,p.merchant_id
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
      COUNT(*) FILTER (WHERE is_test=true)::int AS test_orders,
      COUNT(*) FILTER (
        WHERE UPPER(COALESCE(order_type,''))='DELIVERY'
          AND UPPER(COALESCE(delivered_by,''))='MERCHANT'
          AND (
            UPPER(COALESCE(status,''))='CONFIRMED'
            OR UPPER(COALESCE(status,''))='READY_TO_PICKUP'
            OR UPPER(COALESCE(status,''))='PREPARATION_STARTED'
            OR UPPER(COALESCE(status,'')) IN ('SEPARATION_STARTED','SEPARATION_ENDED')
          )
          AND NOT EXISTS (
            SELECT 1 FROM ifood_dispatch_links l WHERE l.ifood_order_id=ifood_orders.order_id
          )
      )::int AS available_merchant_delivery
    FROM ifood_orders
    WHERE ($1::text IS NULL OR merchant_id=$1)
  `, [configuredMerchantId || null])).rows[0];

  const dispatchCounts = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE j.status IN ('PENDING','RETRY','PROCESSING'))::int AS pending,
      COUNT(*) FILTER (WHERE j.status='FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE j.status='SENT')::int AS sent
    FROM ifood_dispatch_jobs j
    LEFT JOIN ifood_orders o ON o.order_id=j.ifood_order_id
    WHERE ($1::text IS NULL OR o.merchant_id=$1)
  `, [configuredMerchantId || null])).rows[0] || { pending: 0, failed: 0, sent: 0 };

  counts.dispatch_pending = dispatchCounts.pending || 0;
  counts.dispatch_failed = dispatchCounts.failed || 0;
  counts.dispatch_sent = dispatchCounts.sent || 0;

  const deliveryConfirmationCounts = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE dc.status='VERIFIED')::int AS verified,
      COUNT(*) FILTER (WHERE dc.status='PROCESSING')::int AS processing,
      COUNT(*) FILTER (WHERE dc.status='FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE dc.status='CONCLUDED')::int AS concluded
    FROM ifood_delivery_confirmations dc
    LEFT JOIN ifood_orders o ON o.order_id=dc.ifood_order_id
    WHERE dc.updated_at >= NOW()-INTERVAL '24 hours'
      AND ($1::text IS NULL OR o.merchant_id=$1)
  `, [configuredMerchantId || null])).rows[0] || {};

  counts.delivery_verified = deliveryConfirmationCounts.verified || 0;
  counts.delivery_processing = deliveryConfirmationCounts.processing || 0;
  counts.delivery_confirmation_failed = deliveryConfirmationCounts.failed || 0;
  counts.delivery_concluded = deliveryConfirmationCounts.concluded || 0;

  const recentOrders = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.merchant_id,o.status,o.order_type,o.category,o.sales_channel,
      o.delivered_by,o.is_test,o.order_created_at,o.last_event_code,o.last_event_at,o.updated_at,
      l.dispatch_id,u.name AS local_courier_name,d.status AS local_dispatch_status,
      l.ifood_dispatch_status,
      j.status AS dispatch_job_status,j.attempts AS dispatch_attempts,
      j.last_error AS dispatch_last_error,j.last_http_status AS dispatch_last_http_status,
      j.accepted_at AS dispatch_accepted_at,j.next_attempt_at AS dispatch_next_attempt_at,
      dc.status AS delivery_confirmation_status,dc.verified_at AS delivery_verified_at,
      dc.concluded_at AS delivery_concluded_at,dc.last_error AS delivery_confirmation_error
    FROM ifood_orders o
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN ifood_dispatch_jobs j ON j.ifood_order_id=o.order_id
    LEFT JOIN ifood_delivery_confirmations dc ON dc.ifood_order_id=o.order_id
    LEFT JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN users u ON u.id=d.courier_id
    WHERE ($1::text IS NULL OR o.merchant_id=$1)
    ORDER BY COALESCE(o.last_event_at,o.updated_at) DESC
    LIMIT 30
  `, [configuredMerchantId || null])).rows;

  const runtimeControl = await getIfoodRuntimeControl();
  const allowedMerchantIds = ifoodAllowedMerchantIds();
  const environment = ifoodEnvironment();
  const automaticGate = await ifoodAutomaticDispatchAllowed();

  const configuredMerchantRow = configuredMerchantId
    ? merchants.find(m => String(m.id) === configuredMerchantId)
    : null;

  const targetMerchants = configuredMerchantId
    ? [{
        id: configuredMerchantId,
        name: configuredMerchantRow?.name || "Merchant configurado",
        corporate_name: configuredMerchantRow?.corporate_name || null,
        source: "IFOOD_MERCHANT_ID"
      }]
    : merchants.filter(m => ifoodMerchantAllowed(m.id));

  const lastSuccessMs = state?.last_success_at ? Date.parse(state.last_success_at) : NaN;
  const syncAgeSeconds = Number.isFinite(lastSuccessMs)
    ? Math.max(0, Math.round((Date.now() - lastSuccessMs) / 1000))
    : null;

  const merchantSafety = merchants.map(m => ({
    id: m.id,
    name: m.name,
    allowed: ifoodMerchantAllowed(m.id)
  }));

  res.json({
    configured: ifoodConfigured(),
    autoEnabled: ifoodAutoEnabled(),
    preparationTimeConfigured: ifoodPreparationTimeConfigured(),
    preparationTimes,
    dispatchEnabled: ifoodDispatchEnabled(),
    dispatchWorkerRunning: ifoodDispatchWorkerRunning,
    environment,
    configuredMerchantId: configuredMerchantId || null,
    merchantResolutionMode: configuredMerchantId ? "merchant_id" : "merchant_api",
    targetMerchants,
    productionSafetyReady: ifoodProductionSafetyReady(),
    allowedMerchantCount: allowedMerchantIds.length,
    merchantSafety,
    runtimeControl,
    automaticDispatchAllowed: automaticGate.allowed,
    automaticDispatchBlockReason: automaticGate.reason,
    syncAgeSeconds,
    phase: "FASE_7_PRODUCAO_MERCHANT_ID",
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


app.post("/api/admin/ifood/dispatch-control/pause", auth, adminOnly, asyncRoute(async (req, res) => {
  const reason = String(req.body?.reason || "Pausa de emergência pelo administrador")
    .trim()
    .slice(0, 300);

  await pool.query(`
    UPDATE ifood_runtime_control SET
      dispatch_paused=TRUE,
      pause_reason=$1,
      changed_by=$2,
      changed_at=NOW()
    WHERE singleton=1
  `, [reason, req.session.user.id]);

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_DISPATCH_PAUSED",
    "ifood",
    null,
    { reason }
  );

  await createNotification({
    type: "IFOOD_DISPATCH_PAUSED",
    severity: "warning",
    title: "Despachos iFood pausados",
    message: reason,
    uniqueKey: `ifood-pause:${Date.now()}`
  }).catch(() => {});

  io.emit("ifood:changed");

  res.json({
    ok: true,
    paused: true,
    message: "Novos despachos automáticos do iFood foram pausados."
  });
}));

app.post("/api/admin/ifood/dispatch-control/resume", auth, adminOnly, asyncRoute(async (req, res) => {
  if (!ifoodProductionSafetyReady()) {
    return res.status(409).json({
      error: "Não é possível retomar em PRODUÇÃO sem IFOOD_ALLOWED_MERCHANT_IDS."
    });
  }

  await pool.query(`
    UPDATE ifood_runtime_control SET
      dispatch_paused=FALSE,
      pause_reason=NULL,
      changed_by=$1,
      changed_at=NOW()
    WHERE singleton=1
  `, [req.session.user.id]);

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_DISPATCH_RESUMED",
    "ifood",
    null,
    {
      environment: ifoodEnvironment(),
      allowedMerchantCount: ifoodAllowedMerchantIds().length
    }
  );

  io.emit("ifood:changed");

  setImmediate(() => {
    runIfoodDispatchWorkerOnce().catch(err => {
      console.error("iFood dispatch after resume:", ifoodDispatchErrorText(err));
    });
  });

  res.json({
    ok: true,
    paused: false,
    message: "Despachos automáticos do iFood foram retomados."
  });
}));

app.get("/api/admin/ifood/merchant-operational/:id", auth, adminOnly, asyncRoute(async (req, res) => {
  const merchantId = String(req.params.id || "").trim();

  const known = (await pool.query(`
    SELECT merchant_id,name
    FROM ifood_merchants
    WHERE merchant_id=$1
    LIMIT 1
  `, [merchantId])).rows[0];

  if (!known) {
    return res.status(404).json({ error: "Loja iFood não conhecida pelo DespacheFull." });
  }

  const result = await fetchIfoodMerchantOperationalData(merchantId);

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_MERCHANT_OPERATIONAL_CHECK",
    "ifood_merchant",
    null,
    {
      merchant_id: merchantId,
      allowed: result.allowed,
      state: result.status?.state || null
    }
  );

  res.json({
    ...result,
    knownName: known.name,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/ifood/test-connection", auth, adminOnly, asyncRoute(async (req, res) => {
  if (!ifoodConfigured()) {
    return res.status(503).json({
      error: "IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não estão configurados."
    });
  }

  const configuredMerchantId = ifoodPrimaryMerchantId();

  if (configuredMerchantId) {
    // Força token novo após a autorização do merchant no Portal do Parceiro.
    await getIfoodAccessToken(true);

    const known = await upsertConfiguredIfoodMerchant(configuredMerchantId);

    const merchants = [{
      id: configuredMerchantId,
      name: known?.name || "Merchant configurado",
      corporateName: known?.corporateName || null,
      source: "environment"
    }];

    await auditBestEffort(
      req.session.user.id,
      "IFOOD_CONNECTION_TESTED",
      "ifood",
      null,
      {
        merchants: 1,
        merchant_id: configuredMerchantId,
        mode: "IFOOD_MERCHANT_ID"
      }
    );

    return res.json({
      ok: true,
      connected: true,
      merchantResolutionMode: "merchant_id",
      merchants,
      message:
        "Credenciais autenticadas. Merchant de produção configurado por IFOOD_MERCHANT_ID. Use “Sincronizar agora” para validar ORDER + EVENTS."
    });
  }

  const merchants = await fetchAndStoreIfoodMerchants();

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_CONNECTION_TESTED",
    "ifood",
    null,
    { merchants: merchants.length, mode: "MERCHANT_API" }
  );

  res.json({
    ok: true,
    connected: true,
    merchantResolutionMode: "merchant_api",
    merchants,
    message: `${merchants.length} loja(s) acessível(is) via módulo Merchant.`
  });
}));


app.post("/api/admin/ifood/orders/:id/confirm-test", auth, adminOnly, asyncRoute(async (req, res) => {
  const orderId = String(req.params.id || "").trim();

  const order = (await pool.query(`
    SELECT order_id,display_id,status,last_event_code,is_test,category,order_type
    FROM ifood_orders
    WHERE order_id=$1
    LIMIT 1
  `, [orderId])).rows[0];

  if (!order) return res.status(404).json({ error: "Pedido iFood não encontrado." });
  if (order.is_test !== true) {
    return res.status(403).json({
      error: "Este botão é permitido somente para pedidos de teste."
    });
  }

  const status = canonicalIfoodOrderStatus(order.status);

  if (status !== "PLACED") {
    return res.status(409).json({
      error: `O pedido de teste está em ${status}; somente PLACED pode ser confirmado por este botão.`
    });
  }

  const { body } = await ifoodApi(
    `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(orderId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }
  );

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_TEST_ORDER_CONFIRM_REQUESTED",
    "ifood_order",
    null,
    {
      order_id: orderId,
      display_id: order.display_id
    }
  );

  res.status(202).json({
    ok: true,
    accepted: true,
    response: body || null,
    message: "Confirmação enviada ao iFood. Sincronize novamente em alguns segundos."
  });
}));


function normalizeIfoodCancellationReasons(body) {
  const raw = Array.isArray(body?.reasons)
    ? body.reasons
    : Array.isArray(body)
      ? body
      : [];

  const normalized = raw.map((item, index) => {
    if (item === null || item === undefined) return null;

    if (typeof item === "string" || typeof item === "number") {
      const code = String(item).trim();
      return code ? { code, description: code, source_field: "scalar" } : null;
    }

    if (typeof item !== "object") return null;

    const candidates = [
      ["code", item.code],
      ["cancelCodeId", item.cancelCodeId],
      ["cancellationCode", item.cancellationCode],
      ["reasonCode", item.reasonCode],
      ["id", item.id],
      ["value", item.value]
    ];

    const selected = candidates.find(([, value]) =>
      value !== null && value !== undefined && String(value).trim() !== ""
    );

    const code = selected ? String(selected[1]).trim() : "";
    if (!code) return null;

    const description = String(
      item.description ?? item.reasonDescription ?? item.name ?? item.label ?? `Motivo ${index + 1}`
    ).trim();

    return {
      code,
      description: description || `Motivo ${index + 1}`,
      source_field: selected[0]
    };
  }).filter(Boolean);

  return { raw, normalized };
}

app.get("/api/admin/ifood/orders/:id/cancellation-reasons-test", auth, adminOnly, asyncRoute(async (req, res) => {
  const orderId = String(req.params.id || "").trim();

  const order = (await pool.query(`
    SELECT order_id,display_id,status,is_test
    FROM ifood_orders
    WHERE order_id=$1
    LIMIT 1
  `, [orderId])).rows[0];

  if (!order) return res.status(404).json({ error: "Pedido iFood não encontrado." });
  if (order.is_test !== true) {
    return res.status(403).json({ error: "Consulta de cancelamento permitida somente para pedido de teste." });
  }

  const status = canonicalIfoodOrderStatus(order.status);
  if (["CANCELLED","CONCLUDED","DISPATCHED"].includes(status)) {
    return res.status(409).json({ error: `O pedido está em ${status} e não pode ser cancelado por este fluxo.` });
  }

  const { body } = await ifoodApi(
    `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(orderId)}/cancellationReasons`
  );

  const { raw: rawReasons, normalized: reasons } = normalizeIfoodCancellationReasons(body);

  if (!reasons.length && rawReasons.length) {
    const keys = [...new Set(rawReasons.flatMap(item =>
      item && typeof item === "object" ? Object.keys(item) : []
    ))].slice(0, 12);
    return res.status(502).json({
      error: "O iFood retornou motivos de cancelamento sem um campo de código reconhecível.",
      received_fields: keys
    });
  }

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_TEST_CANCELLATION_REASONS_READ",
    "ifood_order",
    null,
    { order_id: orderId, display_id: order.display_id, reasons_count: reasons.length }
  );

  res.json({ ok: true, order_id: orderId, display_id: order.display_id, reasons });
}));

app.post("/api/admin/ifood/orders/:id/cancel-test", auth, adminOnly, asyncRoute(async (req, res) => {
  const orderId = String(req.params.id || "").trim();
  const requestedReason = String(req.body?.reason || "").trim();

  const order = (await pool.query(`
    SELECT order_id,display_id,status,is_test
    FROM ifood_orders
    WHERE order_id=$1
    LIMIT 1
  `, [orderId])).rows[0];

  if (!order) return res.status(404).json({ error: "Pedido iFood não encontrado." });
  if (order.is_test !== true) {
    return res.status(403).json({ error: "Cancelamento controlado permitido somente para pedido de teste." });
  }

  const status = canonicalIfoodOrderStatus(order.status);
  if (["CANCELLED","CONCLUDED","DISPATCHED"].includes(status)) {
    return res.status(409).json({ error: `O pedido está em ${status} e não pode ser cancelado por este fluxo.` });
  }

  const { body: reasonsBody } = await ifoodApi(
    `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(orderId)}/cancellationReasons`
  );
  const { raw: rawReasons, normalized: reasons } = normalizeIfoodCancellationReasons(reasonsBody);

  if (!reasons.length && rawReasons.length) {
    const keys = [...new Set(rawReasons.flatMap(item =>
      item && typeof item === "object" ? Object.keys(item) : []
    ))].slice(0, 12);
    return res.status(502).json({
      error: "O iFood retornou motivos de cancelamento sem um campo de código reconhecível.",
      received_fields: keys
    });
  }

  if (!reasons.length) {
    return res.status(409).json({ error: "O iFood não retornou motivos válidos de cancelamento para este pedido." });
  }

  const reason = reasons.find(r => String(r?.code || "") === requestedReason);
  if (!reason) {
    return res.status(400).json({
      error: "Motivo de cancelamento inválido para este pedido.",
      reasons
    });
  }

  // A documentação pública do Order ainda exemplifica { reason: "<codigo>" },
  // porém o backend de homologação PDV atualmente também exige cancellationCode.
  // Enviamos ambos usando exclusivamente o código devolvido por /cancellationReasons.
  const cancellationCodeRaw = String(reason.code).trim();
  const cancellationCode = /^\d+$/.test(cancellationCodeRaw)
    ? Number(cancellationCodeRaw)
    : cancellationCodeRaw;
  const cancellationPayload = {
    reason: cancellationCodeRaw,
    cancellationCode
  };

  const { body } = await ifoodApi(
    `${IFOOD_ORDER_BASE}/orders/${encodeURIComponent(orderId)}/requestCancellation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cancellationPayload)
    }
  );

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_TEST_CANCELLATION_REQUESTED",
    "ifood_order",
    null,
    {
      order_id: orderId,
      display_id: order.display_id,
      reason: cancellationCodeRaw,
      cancellation_code: cancellationCode,
      reason_description: reason.description || null
    }
  );

  io.emit("ifood:changed");

  res.status(202).json({
    ok: true,
    accepted: true,
    reason,
    response: body || null,
    message: "Solicitação de cancelamento aceita pelo iFood. Aguarde o evento CANCELLED no polling."
  });
}));


app.post("/api/admin/ifood/orders/:id/dispatch-test", auth, adminOnly, asyncRoute(async (req, res) => {
  const orderId = String(req.params.id || "").trim();

  const row = (await pool.query(`
    SELECT
      o.order_id,o.display_id,o.status,o.order_type,o.delivered_by,o.is_test,
      l.dispatch_id,u.name AS courier_name
    FROM ifood_orders o
    LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN dispatches d ON d.id=l.dispatch_id
    LEFT JOIN users u ON u.id=d.courier_id
    WHERE o.order_id=$1
    LIMIT 1
  `, [orderId])).rows[0];

  if (!row) return res.status(404).json({ error: "Pedido iFood não encontrado." });
  if (row.is_test !== true) {
    return res.status(403).json({
      error: "Despacho controlado permitido somente para pedido de teste."
    });
  }
  if (!row.dispatch_id) {
    return res.status(409).json({
      error: "O pedido ainda não está vinculado a uma saída do DespacheFull."
    });
  }
  if (String(row.order_type || "").toUpperCase() !== "DELIVERY") {
    return res.status(409).json({ error: "Pedido não é DELIVERY." });
  }
  if (String(row.delivered_by || "").toUpperCase() !== "MERCHANT") {
    return res.status(409).json({ error: "Pedido não é de entrega própria." });
  }

  const result = await processIfoodDispatchByOrder(orderId, { manualTest: true });

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_TEST_DISPATCH_REQUESTED",
    "ifood_order",
    null,
    {
      order_id: orderId,
      display_id: row.display_id,
      dispatch_id: row.dispatch_id,
      courier_name: row.courier_name,
      result
    }
  );

  io.emit("ifood:changed");

  res.status(result.accepted ? 202 : 200).json({
    ...result,
    message: result.accepted
      ? "iFood aceitou o despacho do pedido de teste. Sincronize os eventos em alguns segundos."
      : result.alreadyDone
        ? "O pedido já está despachado/concluído no iFood."
        : result.skipped
          ? "O despacho já está sendo processado."
          : "Processamento concluído."
  });
}));

app.post("/api/admin/ifood/orders/:id/retry-dispatch", auth, adminOnly, asyncRoute(async (req, res) => {
  const orderId = String(req.params.id || "").trim();

  const row = (await pool.query(`
    SELECT o.order_id,o.display_id,o.delivered_by,l.dispatch_id,j.status AS job_status
    FROM ifood_orders o
    JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
    LEFT JOIN ifood_dispatch_jobs j ON j.ifood_order_id=o.order_id
    WHERE o.order_id=$1
    LIMIT 1
  `, [orderId])).rows[0];

  if (!row) return res.status(404).json({ error: "Pedido/vínculo não encontrado." });
  if (String(row.delivered_by || "").toUpperCase() !== "MERCHANT") {
    return res.status(409).json({ error: "Pedido não é de entrega própria." });
  }
  if (row.job_status === "PROCESSING") {
    return res.status(409).json({ error: "Esse despacho já está sendo processado." });
  }

  await ensureIfoodDispatchJob(orderId);
  await pool.query(`
    UPDATE ifood_dispatch_jobs SET
      status='RETRY',locked_at=NULL,next_attempt_at=NOW(),last_error=NULL,updated_at=NOW()
    WHERE ifood_order_id=$1
  `, [orderId]);

  const result = await processIfoodDispatchByOrder(orderId);

  await auditBestEffort(
    req.session.user.id,
    "IFOOD_DISPATCH_RETRY_REQUESTED",
    "ifood_order",
    null,
    { order_id: orderId, display_id: row.display_id, result }
  );

  io.emit("ifood:changed");
  res.json({ ...result, message: "Nova tentativa executada." });
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


app.get("/api/admin/payments", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();
  const { rule, rows } = await getPaymentRows(date);

  const summary = rows.reduce((acc, row) => {
    acc.couriers += 1;
    acc.deliveries += Number(row.delivery_count || 0);
    acc.total = roundMoney(acc.total + Number(row.total_amount || 0));
    if (row.status === "PAID") {
      acc.paid = roundMoney(acc.paid + Number(row.total_amount || 0));
      acc.paid_count += 1;
    } else {
      acc.pending = roundMoney(acc.pending + Number(row.total_amount || 0));
    }
    if (row.status === "REVIEWED") acc.reviewed_count += 1;
    return acc;
  }, {
    couriers: 0,
    deliveries: 0,
    total: 0,
    paid: 0,
    pending: 0,
    paid_count: 0,
    reviewed_count: 0
  });

  res.json({
    date,
    day_group: isFriSun(date) ? "SEX_DOM" : "SEG_QUI",
    rule,
    formula: "entregas × valor por entrega + encosta + gorjeta - desconto + ajuste",
    rows,
    summary,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/payments/rules", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();
  const current = await getPaymentRateRule(date);
  const history = (await pool.query(`
    SELECT r.id,r.effective_from,r.per_delivery,r.base_mon_thu,r.base_fri_sun,
           r.created_at,u.name AS created_by_name
    FROM payment_rate_rules r
    LEFT JOIN users u ON u.id=r.created_by
    ORDER BY r.effective_from DESC,r.id DESC
    LIMIT 30
  `)).rows.map(r => ({
    ...r,
    per_delivery: Number(r.per_delivery),
    base_mon_thu: Number(r.base_mon_thu),
    base_fri_sun: Number(r.base_fri_sun)
  }));

  res.json({ current, history, date, server_now: new Date().toISOString() });
}));

app.put("/api/admin/payments/rules", auth, adminOnly, asyncRoute(async (req, res) => {
  const effectiveFrom = validDate(req.body.effective_from) ? String(req.body.effective_from) : await getSPDate();
  const perDelivery = parseMoneyValue(req.body.per_delivery, NaN);
  const baseMonThu = parseMoneyValue(req.body.base_mon_thu, NaN);
  const baseFriSun = parseMoneyValue(req.body.base_fri_sun, NaN);

  if (![perDelivery, baseMonThu, baseFriSun].every(Number.isFinite)) {
    return res.status(400).json({ error: "Informe valores válidos para a regra de pagamento." });
  }
  if ([perDelivery, baseMonThu, baseFriSun].some(x => x < 0 || x > 100000)) {
    return res.status(400).json({ error: "Os valores da regra precisam ser positivos e dentro de um limite razoável." });
  }

  const q = await pool.query(`
    INSERT INTO payment_rate_rules(
      effective_from,per_delivery,base_mon_thu,base_fri_sun,created_by
    )
    VALUES($1::date,$2,$3,$4,$5)
    ON CONFLICT(effective_from) DO UPDATE SET
      per_delivery=EXCLUDED.per_delivery,
      base_mon_thu=EXCLUDED.base_mon_thu,
      base_fri_sun=EXCLUDED.base_fri_sun,
      created_by=EXCLUDED.created_by,
      created_at=NOW()
    RETURNING id,effective_from,per_delivery,base_mon_thu,base_fri_sun,created_at
  `, [effectiveFrom, perDelivery, baseMonThu, baseFriSun, req.session.user.id]);

  await audit(req.session.user.id, "PAYMENT_RULE_UPDATED", "payment_rule", q.rows[0].id, {
    effective_from: effectiveFrom,
    per_delivery: perDelivery,
    base_mon_thu: baseMonThu,
    base_fri_sun: baseFriSun
  });

  io.emit("payment:changed", { all: true, change: "RULE_UPDATED" });
  res.json({
    rule: {
      ...q.rows[0],
      per_delivery: Number(q.rows[0].per_delivery),
      base_mon_thu: Number(q.rows[0].base_mon_thu),
      base_fri_sun: Number(q.rows[0].base_fri_sun)
    },
    message: "Regra de pagamento salva."
  });
}));

app.put("/api/admin/payments/:date/:courierId", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = String(req.params.date || "");
  const courierId = Number(req.params.courierId);
  if (!validDate(date)) return res.status(400).json({ error: "Data inválida." });
  if (!Number.isInteger(courierId) || courierId < 1) return res.status(400).json({ error: "Motoboy inválido." });

  const courier = (await pool.query(`
    SELECT id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status
    FROM users
    WHERE id=$1 AND role='courier'
  `, [courierId])).rows[0];
  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });

  const existing = (await pool.query(`
    SELECT *
    FROM courier_payments
    WHERE payment_date=$1::date AND courier_id=$2
    LIMIT 1
  `, [date, courierId])).rows[0] || null;

  const tip = parseMoneyValue(req.body.tip_amount, 0);
  const discount = parseMoneyValue(req.body.discount_amount, 0);
  const adjustment = parseMoneyValue(req.body.adjustment_amount, 0);
  const paymentMethod = String(req.body.payment_method || "").trim().slice(0, 40) || null;
  const notes = String(req.body.notes || "").trim().slice(0, 600) || null;
  const status = String(req.body.status || "OPEN").trim().toUpperCase();

  if (!["OPEN","REVIEWED","PAID"].includes(status)) {
    return res.status(400).json({ error: "Status de pagamento inválido." });
  }
  if (![tip, discount, adjustment].every(Number.isFinite)) {
    return res.status(400).json({ error: "Gorjeta, desconto ou ajuste inválido." });
  }
  if (tip < 0 || discount < 0) {
    return res.status(400).json({ error: "Gorjeta e desconto não podem ser negativos. Use Ajuste para correções positivas ou negativas." });
  }
  if ([Math.abs(tip), Math.abs(discount), Math.abs(adjustment)].some(x => x > 100000)) {
    return res.status(400).json({ error: "Valor financeiro fora do limite permitido." });
  }

  if (existing?.status === "PAID" && status !== "PAID" && req.body.confirm_reopen_paid !== true) {
    return res.status(409).json({
      error: "Este pagamento já está marcado como PAGO. Confirme explicitamente para reabrir.",
      code: "PAYMENT_REOPEN_CONFIRMATION"
    });
  }

  const liveCount = await getCourierDeliveryCount(courierId, date);
  const rule = await getPaymentRateRule(date);
  const preserveFinancialSnapshot = !!existing
    && ["REVIEWED","PAID"].includes(existing.status)
    && ["REVIEWED","PAID"].includes(status);

  const finalTip = preserveFinancialSnapshot ? Number(existing.tip_amount || 0) : tip;
  const finalDiscount = preserveFinancialSnapshot ? Number(existing.discount_amount || 0) : discount;
  const finalAdjustment = preserveFinancialSnapshot ? Number(existing.adjustment_amount || 0) : adjustment;

  const calc = preserveFinancialSnapshot ? {
    delivery_count: Number(existing.delivery_count_snapshot || 0),
    per_delivery: Number(existing.per_delivery_snapshot || 0),
    base_amount: Number(existing.base_snapshot || 0),
    tip_amount: finalTip,
    discount_amount: finalDiscount,
    adjustment_amount: finalAdjustment,
    total_amount: Number(existing.total_snapshot || 0)
  } : calculatePaymentAmounts({
    date,
    deliveryCount: liveCount,
    rule,
    tip: finalTip,
    discount: finalDiscount,
    adjustment: finalAdjustment
  });

  const currentPixStatus = normalizedPixStatus(courier.pix_status, !!courier.pix_key);
  const existingPaidSnapshotStatus = normalizedPixStatus(existing?.pix_status_snapshot, !!existing?.pix_key_snapshot);
  const preservingPaidPix = existing?.status === "PAID" && status === "PAID";

  if (
    status === "PAID" &&
    String(paymentMethod || "").toUpperCase() === "PIX" &&
    !(
      preservingPaidPix
        ? existingPaidSnapshotStatus === "VERIFIED" && !!existing?.pix_key_snapshot
        : currentPixStatus === "VERIFIED" && !!courier.pix_key && !!courier.pix_type && !!courier.pix_holder_name
    )
  ) {
    return res.status(409).json({
      error: "O PIX deste motoboy ainda não foi confirmado. Confirme a chave em Motoboys antes de marcar o pagamento PIX como PAGO.",
      code: "PIX_NOT_VERIFIED"
    });
  }

  const lock = status === "REVIEWED" || status === "PAID";
  const reviewedAt = lock ? (existing?.reviewed_at || new Date()) : null;
  const paidAt = status === "PAID" ? (existing?.paid_at || new Date()) : null;

  const pixSnapshot = lock
    ? preservingPaidPix
      ? {
          key: existing.pix_key_snapshot,
          type: existing.pix_type_snapshot,
          holder: existing.pix_holder_name_snapshot,
          status: existingPaidSnapshotStatus
        }
      : {
          key: courier.pix_key,
          type: courier.pix_type,
          holder: courier.pix_holder_name,
          status: currentPixStatus
        }
    : { key: null, type: null, holder: null, status: null };

  const q = await pool.query(`
    INSERT INTO courier_payments(
      payment_date,courier_id,tip_amount,discount_amount,adjustment_amount,
      payment_method,status,notes,
      delivery_count_snapshot,per_delivery_snapshot,base_snapshot,total_snapshot,
      pix_key_snapshot,pix_type_snapshot,pix_holder_name_snapshot,pix_status_snapshot,
      reviewed_at,reviewed_by,paid_at,paid_by,updated_at
    )
    VALUES(
      $1::date,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,NOW()
    )
    ON CONFLICT(payment_date,courier_id) DO UPDATE SET
      tip_amount=EXCLUDED.tip_amount,
      discount_amount=EXCLUDED.discount_amount,
      adjustment_amount=EXCLUDED.adjustment_amount,
      payment_method=EXCLUDED.payment_method,
      status=EXCLUDED.status,
      notes=EXCLUDED.notes,
      delivery_count_snapshot=EXCLUDED.delivery_count_snapshot,
      per_delivery_snapshot=EXCLUDED.per_delivery_snapshot,
      base_snapshot=EXCLUDED.base_snapshot,
      total_snapshot=EXCLUDED.total_snapshot,
      pix_key_snapshot=EXCLUDED.pix_key_snapshot,
      pix_type_snapshot=EXCLUDED.pix_type_snapshot,
      pix_holder_name_snapshot=EXCLUDED.pix_holder_name_snapshot,
      pix_status_snapshot=EXCLUDED.pix_status_snapshot,
      reviewed_at=EXCLUDED.reviewed_at,
      reviewed_by=EXCLUDED.reviewed_by,
      paid_at=EXCLUDED.paid_at,
      paid_by=EXCLUDED.paid_by,
      updated_at=NOW()
    RETURNING *
  `, [
    date,courierId,finalTip,finalDiscount,finalAdjustment,paymentMethod,status,notes,
    lock ? calc.delivery_count : null,
    lock ? calc.per_delivery : null,
    lock ? calc.base_amount : null,
    lock ? calc.total_amount : null,
    pixSnapshot.key,
    pixSnapshot.type,
    pixSnapshot.holder,
    pixSnapshot.status,
    reviewedAt,
    lock ? req.session.user.id : null,
    paidAt,
    status === "PAID" ? req.session.user.id : null
  ]);

  const row = await buildPaymentRow(courier, q.rows[0], date, rule, liveCount);

  await audit(req.session.user.id, "PAYMENT_UPDATED", "courier_payment", q.rows[0].id, {
    payment_date: date,
    courier_id: courierId,
    courier_name: courier.name,
    delivery_count: row.delivery_count,
    total_amount: row.total_amount,
    status,
    payment_method: paymentMethod,
    pix_status: row.pix_status
  });

  io.emit("payment:changed", { courier_id: courierId });
  res.json({ payment: row, message: "Pagamento atualizado.", server_now: new Date().toISOString() });
}));

app.get("/api/admin/payments.csv", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();
  const { rows } = await getPaymentRows(date);

  const header = [
    "Data","Motoboy","Apelido","Titular PIX","Chave PIX","Tipo PIX","Status PIX","Nº Entregas","Valor por Entrega",
    "Encosta","Gorjeta","Desconto","Ajuste","Forma PGMT","Status","Total","Observações"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      date,r.courier_name,r.nickname||"",r.pix_holder_name||"",r.pix_key||"",r.pix_type||"",r.pix_status_label||"",
      r.delivery_count,r.per_delivery,r.base_amount,r.tip_amount,r.discount_amount,
      r.adjustment_amount,r.payment_method||"",paymentStatusLabel(r.status),
      r.total_amount,r.notes||""
    ].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachefull-pagamentos-${date}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));

  await audit(req.session.user.id, "PAYMENT_REPORT_EXPORTED", "payment", null, {
    date,
    rows: rows.length
  });
}));

app.get("/api/admin/dashboard", auth, adminOnly, asyncRoute(async (req, res) => {
  const metrics = (await pool.query(`
    SELECT
      (
        SELECT COUNT(*)
        FROM courier_attendance a
        JOIN users u ON u.id=a.courier_id
        WHERE a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          AND a.checked_out_at IS NULL
          AND u.role='courier' AND u.active=true AND u.approval_status='APPROVED'
      )::int AS active_couriers,
      (SELECT COUNT(*) FROM users WHERE role='courier' AND approval_status='PENDING')::int AS pending_couriers,
      (
        SELECT COUNT(DISTINCT d.courier_id)
        FROM dispatches d
        JOIN courier_attendance a
          ON a.courier_id=d.courier_id
         AND a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
        WHERE d.status='ON_ROAD'
          AND a.checked_out_at IS NULL
      )::int AS on_road,
      (
        SELECT COUNT(*)
        FROM ifood_orders o
        WHERE (COALESCE(o.order_created_at,o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_orders,
      (
        SELECT COUNT(*)
        FROM ifood_orders o
        LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
        WHERE (COALESCE(o.order_created_at,o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          AND UPPER(COALESCE(o.order_type,''))='DELIVERY'
          AND UPPER(COALESCE(o.delivered_by,''))='MERCHANT'
          AND UPPER(COALESCE(o.status,o.last_event_code,'')) IN (
            'CONFIRMED','READY_TO_PICKUP','PREPARATION_STARTED','SEPARATION_STARTED','SEPARATION_ENDED'
          )
          AND l.ifood_order_id IS NULL
      )::int AS waiting_dispatch,
      (
        SELECT COUNT(o.id) FROM dispatch_orders o JOIN dispatches d ON d.id=o.dispatch_id
        WHERE d.status='ON_ROAD'
      )::int AS active_orders,
      (
        SELECT COUNT(*)
        FROM ifood_orders o
        WHERE (COALESCE(o.order_created_at,o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          AND UPPER(COALESCE(o.status,o.last_event_code,'')) IN ('CONCLUDED','DELIVERED')
      )::int AS delivered_today
  `)).rows[0];

  const activeRaw = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.status,
           d.operational_stage,d.returning_at,d.returned_at,
           d.route_sla_minutes,d.return_sla_minutes,
           u.id AS courier_id,u.name AS courier_name,u.username,${orderArraySql("d")}
    FROM dispatches d JOIN users u ON u.id=d.courier_id
    WHERE d.status='ON_ROAD'
    ORDER BY d.departed_at ASC
  `)).rows;
  const operationalSla = await getOperationalSlaSettings();
  const progressMap = await getDispatchProgressMap(activeRaw.map(r => r.id));
  const active = decorateOperationalDispatches(activeRaw, progressMap, operationalSla);

  const recent = (await pool.query(`
    SELECT d.id,d.dispatch_code,d.order_number,d.departed_at,d.released_at,d.status,
           u.name AS courier_name,${orderArraySql("d")}
    FROM dispatches d JOIN users u ON u.id=d.courier_id
    ORDER BY d.id DESC LIMIT 150
  `)).rows;

  const couriers = (await pool.query(`
    SELECT
      u.id,u.name,u.username,u.nickname,u.pix_key,u.pix_type,u.pix_holder_name,
      u.pix_status,u.pix_verified_at,u.pix_updated_at,u.active,u.approval_status,
      u.must_change_password,
      (
        SELECT COUNT(o.id)
        FROM dispatches d
        JOIN dispatch_orders o ON o.dispatch_id=d.id
        WHERE d.courier_id=u.id
          AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date =
              (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      )::int AS today_count,
      EXISTS(
        SELECT 1 FROM dispatches d2
        WHERE d2.courier_id=u.id AND d2.status='ON_ROAD'
      ) AS on_road,
      p.last_seen_at,
      (p.last_seen_at >= NOW()-INTERVAL '150 seconds') AS is_online,
      (SELECT MAX(d3.departed_at) FROM dispatches d3 WHERE d3.courier_id=u.id) AS last_departure,
      a.id AS attendance_id,
      a.checked_in_at,
      a.checkin_method,
      a.admin_reason AS attendance_admin_reason,
      a.checked_out_at,
      a.checkout_reason,
      (a.id IS NOT NULL) AS attended_today,
      (a.id IS NOT NULL AND a.checked_out_at IS NULL) AS present_today,
      CASE
        WHEN u.active=false THEN 'INATIVO'
        WHEN a.id IS NULL THEN 'AUSENTE'
        WHEN a.checked_out_at IS NOT NULL THEN 'ENCERRADO'
        WHEN EXISTS(
          SELECT 1 FROM dispatches d4
          WHERE d4.courier_id=u.id
            AND d4.status='ON_ROAD'
            AND d4.operational_stage='RETURNING'
        ) THEN 'RETORNANDO'
        WHEN EXISTS(
          SELECT 1 FROM dispatches d4
          WHERE d4.courier_id=u.id AND d4.status='ON_ROAD'
        ) THEN 'NA_RUA'
        ELSE 'DISPONIVEL'
      END AS operational_status
    FROM users u
    LEFT JOIN user_presence p ON p.user_id=u.id
    LEFT JOIN courier_attendance a
      ON a.courier_id=u.id
     AND a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
    WHERE u.role='courier'
      AND u.approval_status<>'DELETED'
    ORDER BY
      CASE u.approval_status WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 2 ELSE 1 END,
      CASE
        WHEN u.active=false THEN 7
        WHEN a.id IS NULL THEN 6
        WHEN a.checked_out_at IS NOT NULL THEN 5
        WHEN EXISTS(
          SELECT 1 FROM dispatches d4
          WHERE d4.courier_id=u.id
            AND d4.status='ON_ROAD'
            AND d4.operational_stage='RETURNING'
        ) THEN 1
        WHEN EXISTS(
          SELECT 1 FROM dispatches d4
          WHERE d4.courier_id=u.id AND d4.status='ON_ROAD'
        ) THEN 2
        ELSE 3
      END,
      u.name
  `)).rows;

  const timeMetrics = (await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='RELEASED')::int AS completed,
      ROUND(AVG(EXTRACT(EPOCH FROM (returning_at-departed_at))/60.0) FILTER (WHERE returning_at IS NOT NULL),1) AS avg_route_minutes,
      ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(returned_at,released_at)-returning_at))/60.0) FILTER (WHERE returning_at IS NOT NULL AND COALESCE(returned_at,released_at) IS NOT NULL),1) AS avg_return_minutes,
      ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(returned_at,released_at)-departed_at))/60.0) FILTER (WHERE COALESCE(returned_at,released_at) IS NOT NULL),1) AS avg_total_minutes,
      COUNT(*) FILTER (
        WHERE returning_at IS NOT NULL AND COALESCE(returned_at,released_at) IS NOT NULL
          AND EXTRACT(EPOCH FROM (returning_at-departed_at))/60.0 <= COALESCE(route_sla_minutes,99999)
          AND EXTRACT(EPOCH FROM (COALESCE(returned_at,released_at)-returning_at))/60.0 <= COALESCE(return_sla_minutes,99999)
      )::int AS within_sla,
      COUNT(*) FILTER (WHERE returning_at IS NOT NULL AND COALESCE(returned_at,released_at) IS NOT NULL)::int AS sla_measured
    FROM dispatches
    WHERE (departed_at AT TIME ZONE 'America/Sao_Paulo')::date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
  `)).rows[0];

  const exceptions = active
    .filter(x => x.sla_state !== 'NORMAL')
    .sort((a,b) => ({CRITICAL:0,DELAYED:1,ATTENTION:2}[a.sla_state] ?? 9) - ({CRITICAL:0,DELAYED:1,ATTENTION:2}[b.sla_state] ?? 9));

  res.json({
    metrics: {
      activeCouriers: metrics.active_couriers,
      pendingCouriers: metrics.pending_couriers,
      onRoad: metrics.on_road,
      enRoute: active.filter(x => x.operational_stage==='EN_ROUTE').length,
      returning: active.filter(x => x.operational_stage==='RETURNING').length,
      available: Math.max(0, metrics.active_couriers - metrics.on_road),
      todayOrders: metrics.today_orders,
      waitingDispatch: metrics.waiting_dispatch,
      activeOrders: metrics.active_orders,
      deliveredToday: metrics.delivered_today,
      exceptions: exceptions.length
    },
    active,
    exceptions,
    timeMetrics: {
      completed: Number(timeMetrics.completed || 0),
      avgRouteMinutes: Number(timeMetrics.avg_route_minutes || 0),
      avgReturnMinutes: Number(timeMetrics.avg_return_minutes || 0),
      avgTotalMinutes: Number(timeMetrics.avg_total_minutes || 0),
      withinSlaPercent: Number(timeMetrics.sla_measured || 0) > 0
        ? Math.round((Number(timeMetrics.within_sla || 0) / Number(timeMetrics.sla_measured)) * 100)
        : null,
      measured: Number(timeMetrics.sla_measured || 0)
    },
    recent,
    couriers,
    alerts: await getAlertSettings(),
    operationalSla,
    server_now: new Date().toISOString()
  });
}));

app.post("/api/admin/couriers", auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const nickname = String(req.body.nickname || "").trim().slice(0, 80) || null;
  const pix = normalizePixInput(req.body);
  const pixStatus = pix.empty ? "NONE" : "VERIFIED";
  const verifiedAt = pix.empty ? null : new Date();

  if (name.length < 3 || username.length < 3 || password.length < 8) {
    return res.status(400).json({ error: "Preencha nome, usuário e senha de pelo menos 8 caracteres." });
  }

  try {
    const q = await pool.query(`
      INSERT INTO users(
        name,username,password_hash,role,approval_status,active,must_change_password,
        nickname,pix_key,pix_type,pix_holder_name,pix_status,pix_verified_at,pix_verified_by,pix_updated_at
      )
      VALUES($1,$2,$3,'courier','APPROVED',true,false,$4,$5,$6,$7,$8,$9,$10,NOW())
      RETURNING id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status,
                pix_verified_at,active,approval_status,must_change_password
    `, [
      name, username, await bcrypt.hash(password, 12), nickname,
      pix.pix_key, pix.pix_type, pix.pix_holder_name, pixStatus,
      verifiedAt, pix.empty ? null : req.session.user.id
    ]);

    if (!pix.empty) {
      await savePixHistory({
        courierId: q.rows[0].id,
        pixKey: pix.pix_key,
        pixType: pix.pix_type,
        holderName: pix.pix_holder_name,
        status: "VERIFIED",
        source: "ADMIN_CREATED",
        changedBy: req.session.user.id,
        verifiedAt,
        verifiedBy: req.session.user.id
      });
    }

    await audit(req.session.user.id, "COURIER_CREATED_APPROVED", "user", q.rows[0].id, {
      username,
      pix_status: pixStatus
    });
    io.emit("courier:changed");
    io.emit("payment:changed", { courier_id: q.rows[0].id });
    res.status(201).json({ user: q.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Esse usuário já existe." });
    throw e;
  }
}));

app.delete("/api/admin/couriers/:id", auth, adminOnly, loginLimiter, asyncRoute(async (req, res) => {
  const courierId = Number(req.params.id);
  const adminPassword = String(req.body?.admin_password || "");

  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Motoboy inválido." });
  }
  if (!adminPassword) {
    return res.status(400).json({
      error: "Digite a senha do seu perfil para confirmar a exclusão.",
      code: "ADMIN_PASSWORD_REQUIRED"
    });
  }

  const admin = await currentUser(req.session.user.id);
  const passwordOk = !!admin
    && admin.role === "admin"
    && admin.active
    && await bcrypt.compare(adminPassword, admin.password_hash);

  if (!passwordOk) {
    await auditBestEffort(
      req.session.user.id,
      "COURIER_DELETE_PASSWORD_FAILED",
      "user",
      courierId,
      requestMeta(req)
    );
    return res.status(403).json({
      error: "Senha do administrador incorreta.",
      code: "ADMIN_PASSWORD_INVALID"
    });
  }

  const replacementPasswordHash = await bcrypt.hash(crypto.randomUUID(), 12);
  const replacementUsername = `deleted_${courierId}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const client = await pool.connect();
  let courier;

  try {
    await client.query("BEGIN");

    courier = (await client.query(`
      SELECT id,name,username,approval_status
      FROM users
      WHERE id=$1 AND role='courier' AND approval_status<>'DELETED'
      FOR UPDATE
    `, [courierId])).rows[0];

    if (!courier) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Motoboy não encontrado ou já excluído." });
    }

    const activeDispatch = (await client.query(`
      SELECT id,dispatch_code,operational_stage
      FROM dispatches
      WHERE courier_id=$1 AND status='ON_ROAD'
      ORDER BY departed_at DESC,id DESC
      LIMIT 1
      FOR UPDATE
    `, [courierId])).rows[0];

    if (activeDispatch) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `${courier.name} ainda está ${activeDispatch.operational_stage === "RETURNING" ? "retornando para a loja" : "em rota"}. Finalize a saída antes de excluir o perfil.`,
        code: "COURIER_DELETE_ACTIVE_DISPATCH",
        dispatch_id: activeDispatch.id
      });
    }

    await client.query(`
      UPDATE courier_attendance
      SET checked_out_at=COALESCE(checked_out_at,NOW()),
          checked_out_by=COALESCE(checked_out_by,$1),
          checkout_reason=COALESCE(checkout_reason,'Perfil excluído pelo administrador')
      WHERE courier_id=$2
        AND attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date
        AND checked_out_at IS NULL
    `, [req.session.user.id, courierId]);

    await client.query(`
      UPDATE users
      SET active=false,
          approval_status='DELETED',
          username=$1,
          password_hash=$2,
          must_change_password=false,
          nickname=NULL,
          pix_key=NULL,
          pix_type=NULL,
          pix_holder_name=NULL,
          pix_status='NONE',
          pix_verified_at=NULL,
          pix_verified_by=NULL,
          pix_updated_at=NOW()
      WHERE id=$3 AND role='courier'
    `, [replacementUsername, replacementPasswordHash, courierId]);

    await client.query("DELETE FROM user_presence WHERE user_id=$1", [courierId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await auditBestEffort(req.session.user.id, "COURIER_DELETED", "user", courierId, {
    courier_name: courier.name,
    former_username: courier.username,
    history_preserved: true,
    active_profile_data_removed: true,
    ...requestMeta(req)
  });

  io.emit("courier:changed");
  io.emit("attendance:changed", { courier_id: courierId, deleted: true });
  io.emit("payment:changed", { courier_id: courierId });
  io.emit("pix:changed", { courier_id: courierId, deleted: true });

  res.json({
    ok: true,
    message: `${courier.name} foi excluído. O histórico de entregas e auditoria foi preservado.`
  });
}));

app.patch("/api/admin/couriers/:id", auth, adminOnly, asyncRoute(async (req, res) => {
  const active = !!req.body.active;
  const q = await pool.query(`
    UPDATE users SET active=$1
    WHERE id=$2 AND role='courier' AND approval_status<>'DELETED'
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
    WHERE id=$1 AND role='courier' AND approval_status<>'DELETED'
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
    WHERE id=$1 AND role='courier' AND approval_status<>'DELETED'
    RETURNING id,name,username,active,approval_status,must_change_password
  `, [req.params.id]);

  if (!q.rowCount) return res.status(404).json({ error: "Motoboy não encontrado." });

  await audit(req.session.user.id, "COURIER_REJECTED", "user", q.rows[0].id, {});
  io.emit("courier:changed");
  res.json({ user: q.rows[0] });
}));


app.patch("/api/admin/couriers/:id/profile", auth, adminOnly, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const nickname = String(req.body.nickname || "").trim().slice(0, 80) || null;
  const pix = normalizePixInput(req.body);

  if (name.length < 3) return res.status(400).json({ error: "Informe o nome completo do motoboy." });

  const existing = (await pool.query(`
    SELECT id,pix_key,pix_type,pix_holder_name,pix_status
    FROM users
    WHERE id=$1 AND role='courier' AND approval_status<>'DELETED'
  `, [req.params.id])).rows[0];
  if (!existing) return res.status(404).json({ error: "Motoboy não encontrado." });

  const pixChanged =
    String(existing.pix_key || "") !== String(pix.pix_key || "") ||
    String(existing.pix_type || "") !== String(pix.pix_type || "") ||
    String(existing.pix_holder_name || "") !== String(pix.pix_holder_name || "");

  const newPixStatus = pix.empty
    ? "NONE"
    : pixChanged ? "VERIFIED" : normalizedPixStatus(existing.pix_status, !!existing.pix_key);

  const q = await pool.query(`
    UPDATE users
    SET name=$1,
        nickname=$2,
        pix_key=$3,
        pix_type=$4,
        pix_holder_name=$5,
        pix_status=$6,
        pix_verified_at=CASE WHEN $7::boolean THEN $8 ELSE pix_verified_at END,
        pix_verified_by=CASE WHEN $7::boolean THEN $9 ELSE pix_verified_by END,
        pix_updated_at=CASE WHEN $7::boolean THEN NOW() ELSE pix_updated_at END
    WHERE id=$10 AND role='courier' AND approval_status<>'DELETED'
    RETURNING id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status,
              pix_verified_at,pix_updated_at,active,approval_status
  `, [
    name,nickname,pix.pix_key,pix.pix_type,pix.pix_holder_name,newPixStatus,
    pixChanged, pix.empty ? null : new Date(), pix.empty ? null : req.session.user.id,
    req.params.id
  ]);

  if (pixChanged) {
    await savePixHistory({
      courierId: q.rows[0].id,
      pixKey: pix.pix_key,
      pixType: pix.pix_type,
      holderName: pix.pix_holder_name,
      status: newPixStatus,
      source: "ADMIN_EDIT",
      changedBy: req.session.user.id,
      verifiedAt: pix.empty ? null : new Date(),
      verifiedBy: pix.empty ? null : req.session.user.id
    });
  }

  await audit(req.session.user.id, "COURIER_PROFILE_UPDATED", "user", q.rows[0].id, {
    has_pix: !!pix.pix_key,
    pix_type: pix.pix_type,
    pix_status: newPixStatus,
    pix_changed: pixChanged
  });

  io.emit("courier:changed");
  io.emit("payment:changed", { courier_id: q.rows[0].id });
  io.emit("pix:changed", { courier_id: q.rows[0].id });
  res.json({ user: q.rows[0] });
}));

app.post("/api/admin/couriers/:id/pix/verify", auth, adminOnly, asyncRoute(async (req, res) => {
  const courier = (await pool.query(`
    SELECT id,name,username,pix_key,pix_type,pix_holder_name,pix_status
    FROM users
    WHERE id=$1 AND role='courier' AND approval_status<>'DELETED'
  `, [req.params.id])).rows[0];

  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });
  if (!courier.pix_key || !courier.pix_type || !courier.pix_holder_name) {
    return res.status(400).json({ error: "O motoboy ainda não cadastrou todos os dados do PIX." });
  }

  const verifiedAt = new Date();
  const q = await pool.query(`
    UPDATE users
    SET pix_status='VERIFIED',
        pix_verified_at=$1,
        pix_verified_by=$2,
        pix_updated_at=COALESCE(pix_updated_at,NOW())
    WHERE id=$3 AND role='courier' AND approval_status<>'DELETED'
    RETURNING id,name,username,pix_key,pix_type,pix_holder_name,pix_status,pix_verified_at,pix_updated_at
  `, [verifiedAt, req.session.user.id, courier.id]);

  await savePixHistory({
    courierId: courier.id,
    pixKey: courier.pix_key,
    pixType: courier.pix_type,
    holderName: courier.pix_holder_name,
    status: "VERIFIED",
    source: "ADMIN_VERIFIED",
    changedBy: req.session.user.id,
    verifiedAt,
    verifiedBy: req.session.user.id
  });

  await audit(req.session.user.id, "COURIER_PIX_VERIFIED", "user", courier.id, {
    pix_type: courier.pix_type
  });

  io.emit("courier:changed");
  io.emit("payment:changed", { courier_id: courier.id });
  io.emit("pix:changed", { courier_id: courier.id });

  res.json({
    user: q.rows[0],
    message: "PIX confirmado. A chave já pode ser usada nos pagamentos."
  });
}));

app.post("/api/admin/couriers/:id/reset-password", auth, adminOnly, asyncRoute(async (req, res) => {
  const newPassword = String(req.body.new_password || "");
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "A senha temporária deve ter pelo menos 8 caracteres." });
  }

  const q = await pool.query(`
    UPDATE users
    SET password_hash=$1,must_change_password=true
    WHERE id=$2 AND role='courier' AND approval_status<>'DELETED'
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

app.post("/api/admin/dispatches/:id/start-return", auth, adminOnly, asyncRoute(async (req, res) => {
  const dispatch = await markDispatchReturning(req.params.id, {
    actorUserId: req.session.user.id,
    source: "ADMIN_MANUAL",
    reason: String(req.body?.reason || "ADMIN_STARTED_RETURN").slice(0,200)
  });
  if (!dispatch) return res.status(404).json({ error: "Saída ativa em rota não encontrada." });
  res.json({ dispatch, server_now: new Date().toISOString() });
}));

app.post("/api/admin/dispatches/:id/release", auth, adminOnly, asyncRoute(async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0,200);
  if (reason.length < 4) {
    return res.status(400).json({
      error: "Informe o motivo da confirmação manual de chegada (mínimo 4 caracteres).",
      code: "ADMIN_ARRIVAL_REASON_REQUIRED"
    });
  }

  const dispatch = await completeDispatchReturn({
    dispatchId: req.params.id,
    actorUserId: req.session.user.id,
    source: "ADMIN_ARRIVAL_OVERRIDE",
    reason
  });
  if (!dispatch) return res.status(404).json({ error: "Saída ativa não encontrada." });
  res.json({ dispatch, server_now: new Date().toISOString() });
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
      CASE
        WHEN d.status='RELEASED' THEN 'CONCLUÍDO'
        WHEN d.operational_stage='RETURNING' THEN 'RETORNANDO'
        ELSE 'EM ROTA'
      END AS status,
      CASE WHEN d.returning_at IS NULL THEN '' ELSE
        to_char(d.returning_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS returning_br,
      CASE WHEN COALESCE(d.returned_at,d.released_at) IS NULL THEN '' ELSE
        to_char(COALESCE(d.returned_at,d.released_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS')
      END AS returned_br,
      COALESCE(d.route_sla_minutes,0)::int AS route_sla_minutes,
      COALESCE(d.return_sla_minutes,0)::int AS return_sla_minutes
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN dispatch_orders o ON o.dispatch_id=d.id
    ORDER BY d.departed_at,o.id
  `)).rows;

  const header = [
    "Data","Horário da saída","Motoboy","Usuário","Pedido",
    "Código da saída","Status","Retorno iniciado","Chegada na loja","SLA rota (min)","SLA retorno (min)"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      r.date_br,r.time_br,r.courier_name,r.username,r.order_number,
      r.dispatch_code,r.status,r.returning_br,r.returned_br,r.route_sla_minutes,r.return_sla_minutes
    ].map(csvCell).join(";"));
  }

  const stamp = new Date().toISOString().slice(0,10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachefull-backup-${stamp}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));

  await audit(req.session.user.id, "FULL_HISTORY_EXPORTED", "backup", null, {
    rows: rows.length,
    ...requestMeta(req)
  });
}));

app.get("/api/admin/settings/operational-sla", auth, adminOnly, asyncRoute(async (req, res) => {
  res.json({ sla: await getOperationalSlaSettings() });
}));

app.put("/api/admin/settings/operational-sla", auth, adminOnly, asyncRoute(async (req, res) => {
  const route = req.body?.route || {};
  const values = [1,2,3,4,5].map(n => Number(route[n] ?? route[String(n)]));
  const returnMinutes = Number(req.body?.returnMinutes);
  const criticalOverMinutes = Number(req.body?.criticalOverMinutes);

  if (!values.every(Number.isInteger) || values.some(v => v < 5 || v > 180)) {
    return res.status(400).json({ error: "As metas de rota devem ser minutos inteiros entre 5 e 180." });
  }
  if (!Number.isInteger(returnMinutes) || returnMinutes < 3 || returnMinutes > 120) {
    return res.status(400).json({ error: "A meta de retorno deve ficar entre 3 e 120 minutos." });
  }
  if (!Number.isInteger(criticalOverMinutes) || criticalOverMinutes < 1 || criticalOverMinutes > 120) {
    return res.status(400).json({ error: "O limite crítico adicional deve ficar entre 1 e 120 minutos." });
  }

  for (let i=0;i<5;i++) await setSetting(`route_sla_${i+1}_minutes`, values[i]);
  await setSetting('return_sla_minutes', returnMinutes);
  await setSetting('sla_critical_over_minutes', criticalOverMinutes);

  await audit(req.session.user.id, "OPERATIONAL_SLA_UPDATED", "settings", null, {
    route: Object.fromEntries(values.map((v,i)=>[i+1,v])), returnMinutes, criticalOverMinutes
  });
  io.emit("settings:changed");
  res.json({ sla: await getOperationalSlaSettings() });
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
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();

  const metrics = (await pool.query(`
    SELECT
      (
        SELECT COUNT(*)
        FROM ifood_orders o
        WHERE (COALESCE(o.order_created_at,o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
      )::int AS orders,
      (
        SELECT COUNT(*)
        FROM dispatch_orders o
        JOIN dispatches d ON d.id=o.dispatch_id
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
      )::int AS dispatched_orders,
      (
        SELECT COUNT(*)
        FROM dispatches d
        WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
      )::int AS dispatches,
      (
        SELECT COUNT(*)
        FROM courier_attendance a
        JOIN users u ON u.id=a.courier_id
        WHERE a.attendance_date=$1::date
          AND u.role='courier'
      )::int AS couriers,
      (
        SELECT COALESCE(MAX(order_count),0)
        FROM (
          SELECT COUNT(o.id)::int AS order_count
          FROM dispatches d
          JOIN dispatch_orders o ON o.dispatch_id=d.id
          WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
          GROUP BY d.id
        ) x
      )::int AS max_orders_per_dispatch
  `, [date])).rows[0];

  const byCourier = (await pool.query(`
    SELECT
      u.id,u.name,u.username,
      a.checked_in_at,a.checkin_method,a.admin_reason,
      a.checked_out_at,a.checkout_reason,checkout_admin.name AS checked_out_by_name,
      CASE
        WHEN a.checked_out_at IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (a.checked_out_at-a.checked_in_at))/60.0)::int
        WHEN a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN ROUND(EXTRACT(EPOCH FROM (NOW()-a.checked_in_at))/60.0)::int
        ELSE NULL
      END AS shift_minutes,
      COUNT(DISTINCT d.id)::int AS dispatches,
      COUNT(o.id)::int AS orders,
      MIN(d.departed_at) AS first_departure,
      MAX(d.departed_at) AS last_departure
    FROM courier_attendance a
    JOIN users u ON u.id=a.courier_id
    LEFT JOIN users checkout_admin ON checkout_admin.id=a.checked_out_by
    LEFT JOIN dispatches d
      ON d.courier_id=u.id
     AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
    LEFT JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE a.attendance_date=$1::date
    GROUP BY
      u.id,u.name,u.username,
      a.checked_in_at,a.checkin_method,a.admin_reason,
      a.checked_out_at,a.checkout_reason,checkout_admin.name,a.attendance_date
    ORDER BY a.checked_in_at,u.name
  `, [date])).rows;

  res.json({
    date,
    metrics,
    byCourier,
    attendance: byCourier,
    server_now: new Date().toISOString()
  });
}));

app.get("/api/admin/reports/daily.csv", auth, adminOnly, asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();

  const rows = (await pool.query(`
    SELECT
      to_char(a.attendance_date,'DD/MM/YYYY') AS date_br,
      to_char(a.checked_in_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS presence_time_br,
      u.name AS courier_name,
      u.username,
      a.checkin_method,
      a.admin_reason,
      to_char(a.checked_out_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS checkout_time_br,
      a.checkout_reason,
      checkout_admin.name AS checkout_admin_name,
      CASE
        WHEN a.checked_out_at IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (a.checked_out_at-a.checked_in_at))/60.0)::int
        WHEN a.attendance_date=(NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN ROUND(EXTRACT(EPOCH FROM (NOW()-a.checked_in_at))/60.0)::int
        ELSE NULL
      END AS shift_minutes,
      to_char(d.departed_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI:SS') AS departure_time_br,
      o.order_number,
      d.dispatch_code,
      CASE
        WHEN d.id IS NULL THEN ''
        WHEN d.status='RELEASED' THEN 'CONCLUÍDO'
        WHEN d.operational_stage='RETURNING' THEN 'RETORNANDO'
        ELSE 'EM ROTA'
      END AS status
    FROM courier_attendance a
    JOIN users u ON u.id=a.courier_id
    LEFT JOIN users checkout_admin ON checkout_admin.id=a.checked_out_by
    LEFT JOIN dispatches d
      ON d.courier_id=u.id
     AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=a.attendance_date
    LEFT JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE a.attendance_date=$1::date
    ORDER BY a.checked_in_at,u.name,d.departed_at,o.id
  `, [date])).rows;

  const header = [
    "Data","Presença","Motoboy","Usuário","Origem da presença","Motivo Admin",
    "Encerramento","Motivo encerramento","Admin encerramento","Tempo de expediente (min)",
    "Horário da saída","Pedido","Código da saída","Status"
  ];
  const lines = [header.map(csvCell).join(";")];

  for (const r of rows) {
    lines.push([
      r.date_br,
      r.presence_time_br,
      r.courier_name,
      r.username,
      r.checkin_method,
      r.admin_reason || "",
      r.checkout_time_br || "",
      r.checkout_reason || "",
      r.checkout_admin_name || "",
      r.shift_minutes ?? "",
      r.departure_time_br || "",
      r.order_number || "",
      r.dispatch_code || "",
      r.status || ""
    ].map(csvCell).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="despachefull-presenca-${date}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));

  await auditBestEffort(req.session.user.id, "DAILY_ATTENDANCE_REPORT_EXPORTED", "report", null, {
    date,
    rows: rows.length
  });
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
    const ifoodControl = await getIfoodRuntimeControl().catch(() => ({ dispatch_paused: null }));

    res.json({
      ok: true,
      database: "connected",
      dbLatencyMs: Date.now() - started,
      time: new Date().toISOString(),
      version: VERSION,
      ifood: {
        configured: ifoodConfigured(),
        environment: ifoodEnvironment(),
        eventSyncEnabled: ifoodAutoEnabled(),
        dispatchFlagEnabled: ifoodDispatchEnabled(),
        dispatchPaused: ifoodControl.dispatch_paused,
        productionSafetyReady: ifoodProductionSafetyReady()
      }
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
      if (result.events > 0 || Number(result.preparationTimes?.changed || 0) > 0) io.emit("ifood:changed");
    })
    .catch(err => {
      console.error("iFood automatic sync:", ifoodSafeError(err));
    });
}, 30 * 1000);

setTimeout(() => {
  if (!ifoodAutoEnabled() || !ifoodConfigured()) return;

  syncIfoodOnce({ reason: "automatic_startup" })
    .then(result => {
      if (result.events > 0 || Number(result.preparationTimes?.changed || 0) > 0) io.emit("ifood:changed");
    })
    .catch(err => {
      console.error("iFood startup sync:", ifoodSafeError(err));
    });
}, 8000);


setInterval(() => {
  runIfoodDispatchWorkerOnce().catch(err => {
    console.error("iFood dispatch interval:", ifoodDispatchErrorText(err));
  });
}, 5 * 1000);

setTimeout(() => {
  resetStaleIfoodDispatchJobs()
    .then(() => runIfoodDispatchWorkerOnce())
    .catch(err => {
      console.error("iFood dispatch startup:", ifoodDispatchErrorText(err));
    });
}, 12000);

setTimeout(() => {
  createNotification({
    type: "SYSTEM_STARTED",
    severity: "info",
    title: "DespacheFull online",
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
server.listen(port, () => console.log(`DespacheFull ${VERSION} rodando na porta ${port}`));

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: encerrando DespacheFull com segurança...`);

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
