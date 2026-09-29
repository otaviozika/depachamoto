import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const suffix = process.pid + "_" + Date.now();
const iq = "resilience_ifood_" + suffix;
const aq = "resilience_anota_" + suffix;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function concurrentClaims(sql, params, count = 12) {
  return Promise.all(Array.from({ length: count }, () =>
    pool.query(sql, params).then(r => r.rows[0] || null)
  ));
}

try {
  await pool.query(`
    CREATE TABLE ${iq} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ
    );
    CREATE TABLE ${aq} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processing_started_at TIMESTAMPTZ
    );
  `);

  await pool.query(`INSERT INTO ${iq}(id,status,attempts) VALUES('I1','PENDING',0)`);
  const ifoodClaim = `
    WITH candidate AS (
      SELECT id FROM ${iq}
      WHERE status IN ('PENDING','RETRY') AND attempts < $1 AND next_attempt_at<=NOW()
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${iq} q SET status='PROCESSING',attempts=q.attempts+1,locked_at=NOW()
    FROM candidate c WHERE q.id=c.id RETURNING q.id,q.attempts
  `;
  const iClaims = (await concurrentClaims(ifoodClaim, [8])).filter(Boolean);
  assert(iClaims.length === 1, `iFood duplicate claim: ${iClaims.length}`);
  assert(Number(iClaims[0].attempts) === 1, "iFood attempt counter mismatch");
  console.log("PASS - iFood concurrent claim is single-owner");

  await pool.query(`UPDATE ${iq} SET status='RETRY',attempts=8,locked_at=NULL WHERE id='I1'`);
  const iExhausted = (await concurrentClaims(ifoodClaim, [8])).filter(Boolean);
  assert(iExhausted.length === 0, "iFood exhausted job was reclaimed");
  console.log("PASS - iFood retry ceiling survives concurrent claim");

  await pool.query(`INSERT INTO ${aq}(id,status,attempts) VALUES('A1','PENDING',0)`);
  const anotaClaim = `
    WITH candidate AS (
      SELECT id FROM ${aq}
      WHERE status IN ('PENDING','FAILED') AND attempts < $1 AND next_attempt_at<=NOW()
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${aq} q SET status='PROCESSING',attempts=q.attempts+1,processing_started_at=NOW()
    FROM candidate c WHERE q.id=c.id RETURNING q.id,q.attempts
  `;
  const aClaims = (await concurrentClaims(anotaClaim, [8])).filter(Boolean);
  assert(aClaims.length === 1, `AnotaAi duplicate claim: ${aClaims.length}`);
  assert(Number(aClaims[0].attempts) === 1, "AnotaAi attempt counter mismatch");
  console.log("PASS - AnotaAi concurrent claim is single-owner");

  await pool.query(`UPDATE ${aq} SET status='FAILED',attempts=8,processing_started_at=NULL WHERE id='A1'`);
  const aExhausted = (await concurrentClaims(anotaClaim, [8])).filter(Boolean);
  assert(aExhausted.length === 0, "AnotaAi exhausted job was reclaimed");
  console.log("PASS - AnotaAi retry ceiling survives concurrent claim");

  await pool.query(`
    UPDATE ${aq}
    SET status='PROCESSING',attempts=8,processing_started_at=NOW()-INTERVAL '4 minutes'
    WHERE id='A1'
  `);
  await pool.query(`
    UPDATE ${aq} SET
      status=CASE WHEN attempts >= $1 THEN 'DEAD' ELSE 'FAILED' END,
      processing_started_at=NULL,next_attempt_at=NOW()
    WHERE status='PROCESSING' AND processing_started_at < NOW()-INTERVAL '3 minutes'
  `, [8]);
  const aRecovered = (await pool.query(`SELECT status,attempts FROM ${aq} WHERE id='A1'`)).rows[0];
  assert(aRecovered.status === "DEAD" && Number(aRecovered.attempts) === 8, "AnotaAi stale exhausted recovery reopened budget");
  assert((await concurrentClaims(anotaClaim, [8])).filter(Boolean).length === 0, "AnotaAi DEAD stale job was reclaimed");
  console.log("PASS - AnotaAi stale recovery cannot create attempt 9");

  await pool.query(`
    UPDATE ${iq}
    SET status='PROCESSING',attempts=8,locked_at=NOW()-INTERVAL '4 minutes'
    WHERE id='I1'
  `);
  await pool.query(`
    UPDATE ${iq} SET
      status=CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'RETRY' END,
      locked_at=NULL,next_attempt_at=NOW()
    WHERE status='PROCESSING' AND locked_at < NOW()-INTERVAL '3 minutes'
  `, [8]);
  const iRecovered = (await pool.query(`SELECT status,attempts FROM ${iq} WHERE id='I1'`)).rows[0];
  assert(iRecovered.status === "FAILED" && Number(iRecovered.attempts) === 8, "iFood stale exhausted recovery reopened budget");
  assert((await concurrentClaims(ifoodClaim, [8])).filter(Boolean).length === 0, "iFood FAILED stale job was reclaimed");
  console.log("PASS - iFood stale recovery cannot create attempt 9");

  console.log("Queue resilience DB self-test passed: 6/6.");
} finally {
  await pool.query(`DROP TABLE IF EXISTS ${iq}; DROP TABLE IF EXISTS ${aq};`).catch(() => {});
  await pool.end();
}
