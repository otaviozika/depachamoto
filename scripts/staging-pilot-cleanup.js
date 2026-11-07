import assert from "node:assert/strict";
import pg from "pg";

const EXPECTED_DB = "despachefull_incidentes_homologacao";
const EXPECTED_HOST_FRAGMENT = "dbn9n1psrm7s738pu81g";
const IDS = [
  "staging-iphone-pilot-83000001",
  "staging-iphone-pilot-83000002",
  "staging-iphone-pilot-83000003"
];
const NUMBERS = ["#83000001","#83000002","#83000003"];
const { Pool } = pg;

assert.equal(String(process.env.APP_ENV || "").trim().toLowerCase(), "staging",
  "Limpeza permitida somente com APP_ENV=staging");
assert.ok(["1","true","yes","on"].includes(String(process.env.STAGING_SAFE_MODE || "").trim().toLowerCase()),
  "Limpeza permitida somente com STAGING_SAFE_MODE ativo");

const databaseUrl = new URL(String(process.env.DATABASE_URL || ""));
assert.equal(decodeURIComponent(databaseUrl.pathname.slice(1)), EXPECTED_DB,
  "Banco incorreto: limpeza permitida somente na homologacao isolada");
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

  const orders = await client.query(`
    SELECT order_id, display_id, page_id, customer_name
    FROM anotaai_orders
    WHERE order_id = ANY($1::text[])
    ORDER BY display_id
  `, [IDS]);
  assert.equal(orders.rowCount, 3, "Os tres pedidos sinteticos esperados nao foram encontrados");
  for (const row of orders.rows) {
    assert.equal(row.page_id, "hosted-staging-only", "Pedido nao pertence a fixture de homologacao");
    assert.equal(row.customer_name, "TESTE IPHONE - NAO ENTREGAR", "Cliente sintetico inesperado");
  }

  const dispatches = await client.query(`
    SELECT DISTINCT d.id, u.username
    FROM dispatches d
    JOIN users u ON u.id=d.courier_id
    JOIN anotaai_dispatch_links l ON l.dispatch_id=d.id
    WHERE l.anotaai_order_id = ANY($1::text[])
  `, [IDS]);
  assert.equal(dispatches.rowCount, 1, "Era esperada exatamente uma saida sintetica");
  assert.equal(dispatches.rows[0].username, "piloto.iphone", "A saida nao pertence ao motoboy piloto");
  const dispatchId = Number(dispatches.rows[0].id);

  const composition = await client.query(`
    SELECT order_number
    FROM dispatch_orders
    WHERE dispatch_id=$1
    ORDER BY order_number
  `, [dispatchId]);
  assert.deepEqual(composition.rows.map(row => row.order_number), NUMBERS,
    "A saida contem pedidos fora da fixture; limpeza cancelada");

  const removedDispatch = await client.query("DELETE FROM dispatches WHERE id=$1 RETURNING id", [dispatchId]);
  assert.equal(removedDispatch.rowCount, 1, "Saida sintetica nao removida");
  const removedOrders = await client.query(
    "DELETE FROM anotaai_orders WHERE order_id = ANY($1::text[]) RETURNING order_id",
    [IDS]
  );
  assert.equal(removedOrders.rowCount, 3, "Pedidos sinteticos nao removidos");

  await client.query("COMMIT");
  console.log("STAGING_IPHONE_PILOT_CLEANUP_OK dispatches=1 orders=3 users=0 settings=0 production_access=false");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("STAGING_IPHONE_PILOT_CLEANUP_FAIL", String(error?.message || error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
