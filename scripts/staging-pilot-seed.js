import assert from "node:assert/strict";
import pg from "pg";

const EXPECTED_DB = "despachefull_incidentes_homologacao";
const EXPECTED_HOST_FRAGMENT = "dbn9n1psrm7s738pu81g";
const { Pool } = pg;

assert.equal(String(process.env.APP_ENV || "").trim().toLowerCase(), "staging",
  "Carga permitida somente com APP_ENV=staging");
assert.ok(["1","true","yes","on"].includes(String(process.env.STAGING_SAFE_MODE || "").trim().toLowerCase()),
  "Carga permitida somente com STAGING_SAFE_MODE ativo");

const databaseUrl = new URL(String(process.env.DATABASE_URL || ""));
assert.equal(decodeURIComponent(databaseUrl.pathname.slice(1)), EXPECTED_DB,
  "Banco incorreto: carga permitida somente na homologacao isolada");
assert.ok(databaseUrl.hostname.includes(EXPECTED_HOST_FRAGMENT),
  "Host incorreto: banco aprovado de homologacao nao encontrado");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 1,
  connectionTimeoutMillis: 10000
});

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const identity = await client.query("SELECT current_database() AS db");
  assert.equal(identity.rows[0]?.db, EXPECTED_DB, "Conexao abriu o banco incorreto");

  await client.query(`
    INSERT INTO anotaai_orders
      (order_id, page_id, display_id, status, order_type,
       remote_created_at, remote_updated_at, payload, customer_name)
    SELECT
      'staging-iphone-pilot-' || n,
      'hosted-staging-only',
      n::text,
      'READY',
      'DELIVERY',
      NOW(), NOW(),
      jsonb_build_object(
        'deliveryAddress', jsonb_build_object(
          'streetName', 'Rua Sintetica', 'streetNumber', '123',
          'neighborhood', 'Barcelona', 'city', 'Sao Caetano do Sul',
          'state', 'SP'),
        'customer', jsonb_build_object('name', 'TESTE IPHONE - NAO ENTREGAR')),
      'TESTE IPHONE - NAO ENTREGAR'
    FROM generate_series(83000001, 83000003) AS n
    WHERE NOT EXISTS (
      SELECT 1 FROM anotaai_orders existing
      WHERE existing.order_id = 'staging-iphone-pilot-' || n
         OR existing.display_id = n::text
    )
  `);

  const check = await client.query(`
    SELECT order_id, display_id, status
    FROM anotaai_orders
    WHERE order_id = ANY($1::text[])
    ORDER BY display_id
  `, [[
    "staging-iphone-pilot-83000001",
    "staging-iphone-pilot-83000002",
    "staging-iphone-pilot-83000003"
  ]]);
  assert.equal(check.rowCount, 3, "Os tres pedidos ficticios nao foram preparados");
  assert.deepEqual(check.rows.map(row => row.display_id), ["83000001","83000002","83000003"]);
  await client.query("COMMIT");
  console.log("STAGING_IPHONE_PILOT_SEED_OK orders=3 external_mutations=false production_access=false");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("STAGING_IPHONE_PILOT_SEED_FAIL", String(error?.message || error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
