// Conexão PostgreSQL: TLS verificado no banco da Supabase, rollback explícito,
// URL sem sslmode capaz de anular o objeto ssl, timeouts de sessão e
// revalidação da sessão (admin e motoboy) a cada requisição.
import fs from "node:fs";
import tls from "node:tls";
import assert from "node:assert/strict";
import pg from "pg";
import {
  buildDatabaseConfig, sessionTimeoutSql, isTlsVerificationError,
  DEFAULT_STATEMENT_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS
} from "../lib/db-config.js";

const supabaseCa = fs.readFileSync(new URL("../certs/supabase-root-ca-2021.crt", import.meta.url), "utf8");
const SUPA_POOLER = "postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres";
const SUPA_DIRECT = "postgresql://u:p@db.dmrcidhgnsjxemeaaywf.supabase.co:5432/postgres";
const RENDER = "postgresql://u:p@dpg-abc123-a/despachefull";
const prod = extra => ({ NODE_ENV: "production", ...extra });
let count = 0;
const test = (name, fn) => { fn(); count++; console.log("PASS", name); };

test("produção na Supabase verifica cadeia com a CA da Supabase e as públicas", () => {
  for (const url of [SUPA_POOLER, SUPA_DIRECT]) {
    const cfg = buildDatabaseConfig(prod({ DATABASE_URL: url }));
    assert.equal(cfg.tlsMode, "verified");
    assert.equal(cfg.poolConfig.ssl.rejectUnauthorized, true);
    assert.ok(cfg.poolConfig.ssl.ca.includes(supabaseCa));
    assert.ok(cfg.poolConfig.ssl.ca.length > tls.rootCertificates.length);
  }
});

test("sslmode na URL não anula a verificação (no-verify incluído)", () => {
  for (const mode of ["require", "no-verify", "prefer", "verify-full"]) {
    const cfg = buildDatabaseConfig(prod({ DATABASE_URL: `${SUPA_POOLER}?sslmode=${mode}&application_name=df` }));
    const url = new URL(cfg.poolConfig.connectionString);
    assert.equal(url.searchParams.has("sslmode"), false, mode);
    assert.equal(url.searchParams.get("application_name"), "df");
    assert.equal(cfg.tlsMode, "verified", mode);
    // O node-postgres precisa manter o objeto ssl configurado (a URL não o substitui).
    const effective = new pg.Client(cfg.poolConfig).connectionParameters.ssl;
    assert.equal(effective.rejectUnauthorized, true, mode);
    assert.ok(Array.isArray(effective.ca), mode);
  }
});

test("rollback de emergência: DATABASE_SSL_VERIFY=false", () => {
  const cfg = buildDatabaseConfig(prod({ DATABASE_URL: SUPA_POOLER, DATABASE_SSL_VERIFY: "false" }));
  assert.equal(cfg.tlsMode, "unverified");
  assert.deepEqual(cfg.poolConfig.ssl, { rejectUnauthorized: false });
});

test("Postgres interno do Render (staging) mantém TLS sem verificação, salvo opt-in", () => {
  assert.equal(buildDatabaseConfig(prod({ DATABASE_URL: RENDER })).tlsMode, "unverified");
  assert.equal(buildDatabaseConfig(prod({ DATABASE_URL: RENDER, DATABASE_SSL_VERIFY: "true" })).tlsMode, "verified");
  assert.equal(buildDatabaseConfig(prod({ DATABASE_URL: RENDER + "?sslmode=require" })).tlsMode, "verified", "require continua exigindo verificação como no pg 8");
});

test("desenvolvimento e CI sem SSL continuam sem TLS; sslmode=disable é respeitado", () => {
  assert.equal(buildDatabaseConfig({ DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/postgres" }).poolConfig.ssl, false);
  assert.equal(buildDatabaseConfig({ NODE_ENV: "test", DATABASE_URL: SUPA_POOLER }).poolConfig.ssl, false);
  assert.equal(buildDatabaseConfig(prod({ DATABASE_URL: SUPA_POOLER + "?sslmode=disable" })).tlsMode, "disabled_by_url");
});

test("configuração inválida falha na inicialização", () => {
  assert.throws(() => buildDatabaseConfig({}), /DATABASE_URL/);
  assert.throws(() => buildDatabaseConfig({ DATABASE_URL: "mysql://x@y/z" }), /esquema/);
  assert.throws(() => buildDatabaseConfig(prod({ DATABASE_URL: SUPA_POOLER, DATABASE_SSL_VERIFY: "talvez" })), /booleano/);
  assert.throws(() => buildDatabaseConfig({ DATABASE_URL: SUPA_POOLER, DB_STATEMENT_TIMEOUT_MS: "-1" }), /DB_STATEMENT_TIMEOUT_MS/);
});

test("timeouts de sessão: padrão, ajuste e desligamento", () => {
  const cfg = buildDatabaseConfig({ DATABASE_URL: SUPA_POOLER, DB_POOL_MAX: "7" });
  assert.equal(cfg.poolConfig.max, 7);
  assert.equal(cfg.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS);
  assert.equal(cfg.idleInTransactionTimeoutMs, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  assert.ok(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS > 60_000, "maior que a maior espera HTTP dentro de transação");
  assert.equal(sessionTimeoutSql(cfg), "SET statement_timeout = 60000; SET idle_in_transaction_session_timeout = 120000;");
  const off = buildDatabaseConfig({ DATABASE_URL: SUPA_POOLER, DB_STATEMENT_TIMEOUT_MS: "0", DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0" });
  assert.equal(sessionTimeoutSql(off), "SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0;");
  assert.throws(() => sessionTimeoutSql({ statementTimeoutMs: "1; DROP TABLE users", idleInTransactionTimeoutMs: 0 }));
});

test("erros de certificado são reconhecidos para a mensagem de inicialização", () => {
  assert.ok(isTlsVerificationError({ code: "SELF_SIGNED_CERT_IN_CHAIN" }));
  assert.ok(isTlsVerificationError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }));
  assert.ok(!isTlsVerificationError({ code: "ECONNREFUSED" }));
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
test("servidor usa a configuração central e aplica os timeouts em cada conexão", () => {
  assert.match(server, /const pool = new Pool\(\{\s*\.\.\.databaseConfig\.poolConfig,/);
  assert.ok(!server.includes("rejectUnauthorized"), "nada de TLS sem verificação fixo no servidor");
  const hook = server.slice(server.indexOf("onConnect: async client => {"), server.indexOf('pool.on("error"'));
  assert.match(hook, /client\.on\("error"/, "conexão encerrada pelo banco não derruba o processo");
  assert.match(hook, /await client\.query\(databaseSessionSql\)\.catch\(/, "timeouts aguardados e não fatais");
  assert.ok(server.includes('await pool.query("SELECT 1");'), "falha de TLS aparece na inicialização, com mensagem clara");
});

// Revalidação de sessão: extrai a função real do servidor.
const start = server.indexOf("function sessionAccountValid(");
const body = server.slice(start, server.indexOf("\n}\n", start) + 2);
const sessionAccountValid = new Function(`${body}; return sessionAccountValid;`)();
test("sessão de admin desativado, removido ou com papel trocado é derrubada", () => {
  const admin = { id: 1, role: "admin" };
  assert.equal(sessionAccountValid(admin, { role: "admin", active: true, approval_status: "APPROVED" }), true);
  assert.equal(sessionAccountValid(admin, { role: "admin", active: false }), false);
  assert.equal(sessionAccountValid(admin, null), false);
  assert.equal(sessionAccountValid(admin, { role: "courier", active: true, approval_status: "APPROVED" }), false);
  const courier = { id: 2, role: "courier" };
  assert.equal(sessionAccountValid(courier, { role: "courier", active: true, approval_status: "APPROVED" }), true);
  assert.equal(sessionAccountValid(courier, { role: "courier", active: true, approval_status: "PENDING" }), false);
  assert.equal(sessionAccountValid(courier, { role: "admin", active: true }), false, "promoção exige novo login");
});

test("auth e socket usam a mesma regra para todos os papéis", () => {
  const auth = server.slice(server.indexOf("async function auth(req, res, next) {"), server.indexOf("function adminOnly("));
  assert.ok(auth.includes("sessionAccountValid(sessionUser, account)"));
  assert.ok(!auth.includes('sessionUser.role === "courier") {'), "a checagem não pode ficar restrita ao motoboy");
  assert.equal((server.match(/!sessionAccountValid\(sessionUser, account\)/g) || []).length, 3, "HTTP, conexão do socket e recheck periódico");
  assert.ok(server.includes("account.role !== user.role) socket.disconnect(true)"));
});

console.log(JSON.stringify({ result: "PASS", feature: "db_config_and_session", cases: count }));
