// Configuração da conexão PostgreSQL de produção.
//
// TLS: para o banco da Supabase o certificado do servidor é sempre verificado
// (cadeia e hostname). São aceitas as autoridades públicas do Node e a Supabase
// Root 2021 CA, que assina os certificados do banco e do pooler da Supabase.
// Parâmetros sslmode/sslrootcert da URL são removidos: o node-postgres deixaria
// a URL substituir silenciosamente o objeto `ssl` configurado aqui.
//
// Rollback de emergência: DATABASE_SSL_VERIFY=false volta ao comportamento
// anterior (TLS sem verificação). Use só até corrigir a cadeia de certificados.
import fs from "node:fs";
import tls from "node:tls";

const SUPABASE_ROOT_CA_URL = new URL("../certs/supabase-root-ca-2021.crt", import.meta.url);
const SSL_URL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslcrl", "uselibpqcompat", "ssl"];

export const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 120_000;

function envFlag(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  throw new Error(`Valor booleano inválido: "${value}". Use true ou false.`);
}

function envMilliseconds(name, value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} precisa ser um número inteiro de milissegundos (0 desativa).`);
  }
  return number;
}

export function databaseTrustedCas({ readFile = fs.readFileSync } = {}) {
  // "default" inclui as autoridades embutidas no Node e as de NODE_EXTRA_CA_CERTS.
  const defaults = typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : tls.rootCertificates;
  return [...defaults, readFile(SUPABASE_ROOT_CA_URL, "utf8")];
}

export function buildDatabaseConfig(env = process.env, { readFile = fs.readFileSync } = {}) {
  const raw = String(env.DATABASE_URL || "").trim();
  if (!raw) throw new Error("DATABASE_URL não configurada.");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL precisa usar o esquema postgres:// ou postgresql://.");
  }

  const sslmode = String(url.searchParams.get("sslmode") || "").trim().toLowerCase();
  for (const key of SSL_URL_PARAMS) url.searchParams.delete(key);

  const production = env.NODE_ENV === "production";
  // Verificação ligada por padrão onde a autoridade é conhecida (Supabase, banco
  // de produção) e onde a própria URL já pedia verificação (no pg 8, prefer,
  // require e verify-ca equivalem a verify-full). Outros hosts, como o Postgres
  // interno do Render usado no staging, mantêm TLS sem verificação até que
  // DATABASE_SSL_VERIFY=true seja definido.
  const supabaseHost = /(^|\.)supabase\.(co|com)$/i.test(url.hostname);
  const urlAskedVerification = ["prefer", "require", "verify-ca", "verify-full"].includes(sslmode);
  const verify = envFlag(env.DATABASE_SSL_VERIFY, supabaseHost || urlAskedVerification);
  let ssl = false;
  let tlsMode = "disabled";
  if (sslmode === "disable") {
    tlsMode = "disabled_by_url";
  } else if (production || (sslmode && sslmode !== "allow")) {
    if (verify) {
      ssl = { ca: databaseTrustedCas({ readFile }), rejectUnauthorized: true };
      tlsMode = "verified";
    } else {
      ssl = { rejectUnauthorized: false };
      tlsMode = "unverified";
    }
  }

  return {
    poolConfig: {
      connectionString: url.toString(),
      ssl,
      max: Number(env.DB_POOL_MAX || 20),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    },
    tlsMode,
    statementTimeoutMs: envMilliseconds("DB_STATEMENT_TIMEOUT_MS", env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS),
    idleInTransactionTimeoutMs: envMilliseconds("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS)
  };
}

// SQL executado em cada conexão nova do pool. Usa SET (e não parâmetros de
// inicialização) para funcionar também atrás do pooler da Supabase.
export function sessionTimeoutSql({ statementTimeoutMs, idleInTransactionTimeoutMs }) {
  const statement = Number(statementTimeoutMs);
  const idle = Number(idleInTransactionTimeoutMs);
  if (![statement, idle].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Timeouts do banco inválidos.");
  return `SET statement_timeout = ${statement}; SET idle_in_transaction_session_timeout = ${idle};`;
}

export function isTlsVerificationError(error) {
  const code = String(error?.code || "");
  return [
    "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_UNTRUSTED"
  ].includes(code);
}
