import bcrypt from "bcryptjs";
import crypto from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export async function installPasswordRecovery({ app, pool, asyncRoute, auth, adminOnly, audit, sessionSecret }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_recovery_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','USED','EXPIRED','REJECTED')),
      code_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rejected_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS password_recovery_user_idx
      ON password_recovery_requests(user_id,requested_at DESC);
    CREATE INDEX IF NOT EXISTS password_recovery_status_idx
      ON password_recovery_requests(status,requested_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS password_recovery_one_active_idx
      ON password_recovery_requests(user_id)
      WHERE status IN ('PENDING','APPROVED');
  `);

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: req => {
      const ip = ipKeyGenerator(req.ip);
      const username = String(req.body?.username || "").trim().toLowerCase().slice(0, 120);
      return `password-recovery:${username || "anon"}:${ip}`;
    },
    message: { error: "Muitas tentativas de recuperação. Aguarde alguns minutos e tente novamente." }
  });

  const codeHash = (id, code) => crypto
    .createHmac("sha256", sessionSecret)
    .update(`password-recovery:${id}:${code}`)
    .digest("hex");

  async function expireRequests(client = pool) {
    await client.query(`UPDATE password_recovery_requests
      SET status='EXPIRED'
      WHERE status='APPROVED' AND expires_at IS NOT NULL AND expires_at<=NOW()`);
  }

  async function revokeSessions(userId) {
    try {
      await pool.query(`DELETE FROM user_sessions
        WHERE (sess::jsonb #>> '{user,id}')=$1`, [String(userId)]);
    } catch (error) {
      console.error("Falha ao revogar sessões após recuperação de senha:", error?.message || error);
    }
  }

  app.post("/api/password-recovery/request", limiter, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const generic = { ok: true, message: "Se o usuário estiver apto, a solicitação foi enviada ao administrador." };
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.json(generic);

    await expireRequests();
    const user = (await pool.query(`SELECT id,name,username FROM users
      WHERE username=$1 AND role='courier' AND active=true AND approval_status='APPROVED'`, [username])).rows[0];
    if (!user) return res.json(generic);

    const existing = (await pool.query(`SELECT id FROM password_recovery_requests
      WHERE user_id=$1 AND status IN ('PENDING','APPROVED')
      ORDER BY requested_at DESC LIMIT 1`, [user.id])).rows[0];

    if (!existing) {
      const created = (await pool.query(`INSERT INTO password_recovery_requests(user_id,status)
        VALUES($1,'PENDING') RETURNING id`, [user.id])).rows[0];
      await pool.query(`INSERT INTO notifications(type,severity,title,message,courier_id,unique_key)
        VALUES('PASSWORD_RECOVERY','warning','Recuperação de senha',$1,$2,$3)
        ON CONFLICT(unique_key) DO NOTHING`, [
        `${user.name} (@${user.username}) solicitou recuperação de senha.`,
        user.id,
        `password_recovery:${created.id}`
      ]);
      await audit(user.id, "PASSWORD_RECOVERY_REQUESTED", "user", user.id, { recovery_request_id: created.id });
    }
    res.json(generic);
  }));

  app.get("/api/admin/password-recovery", auth, adminOnly, asyncRoute(async (_req, res) => {
    await expireRequests();
    const rows = (await pool.query(`SELECT r.id,r.status,r.attempts,r.requested_at,r.approved_at,r.expires_at,r.used_at,r.rejected_at,
      u.id AS user_id,u.name,u.username
      FROM password_recovery_requests r JOIN users u ON u.id=r.user_id
      WHERE r.requested_at>=NOW()-INTERVAL '7 days'
      ORDER BY CASE r.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,r.requested_at DESC
      LIMIT 100`)).rows;
    res.json({ rows, server_now: new Date().toISOString() });
  }));

  app.post("/api/admin/password-recovery/:id/approve", auth, adminOnly, asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Solicitação inválida." });
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      await expireRequests(client);
      const row = (await client.query(`SELECT r.*,u.name,u.username,u.active,u.approval_status
        FROM password_recovery_requests r JOIN users u ON u.id=r.user_id
        WHERE r.id=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Solicitação não encontrada." }); }
      if (row.status !== "PENDING") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Esta solicitação não está mais pendente." }); }
      if (!row.active || row.approval_status !== "APPROVED") { await client.query("ROLLBACK"); return res.status(409).json({ error: "A conta não está apta para recuperação." }); }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const updated = (await client.query(`UPDATE password_recovery_requests
        SET status='APPROVED',code_hash=$1,attempts=0,approved_by=$2,approved_at=NOW(),expires_at=NOW()+INTERVAL '10 minutes'
        WHERE id=$3 RETURNING expires_at`, [codeHash(id, code), req.session.user.id, id])).rows[0];
      await client.query("COMMIT");
      result = { ok: true, code, expires_at: updated.expires_at, username: row.username, name: row.name, user_id: row.user_id };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally { client.release(); }

    await audit(req.session.user.id, "PASSWORD_RECOVERY_APPROVED", "password_recovery", id, { user_id: result.user_id });
    res.json(result);
  }));

  app.post("/api/admin/password-recovery/:id/reject", auth, adminOnly, asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Solicitação inválida." });
    const row = (await pool.query(`UPDATE password_recovery_requests
      SET status='REJECTED',rejected_by=$1,rejected_at=NOW(),code_hash=NULL,expires_at=NULL
      WHERE id=$2 AND status IN ('PENDING','APPROVED') RETURNING user_id`, [req.session.user.id, id])).rows[0];
    if (!row) return res.status(409).json({ error: "Esta solicitação não pode mais ser recusada." });
    await audit(req.session.user.id, "PASSWORD_RECOVERY_REJECTED", "password_recovery", id, { user_id: row.user_id });
    res.json({ ok: true });
  }));

  app.post("/api/password-recovery/reset", limiter, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.new_password || "");
    const confirmPassword = String(req.body?.confirm_password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Usuário ou código de recuperação inválido." });
    if (newPassword.length < 8) return res.status(400).json({ error: "A nova senha deve ter pelo menos 8 caracteres." });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: "As senhas não coincidem." });

    await expireRequests();
    const user = (await pool.query(`SELECT id,password_hash FROM users
      WHERE username=$1 AND role='courier' AND active=true AND approval_status='APPROVED'`, [username])).rows[0];
    if (!user) return res.status(400).json({ error: "Usuário ou código de recuperação inválido." });

    const recovery = (await pool.query(`SELECT id,code_hash,attempts FROM password_recovery_requests
      WHERE user_id=$1 AND status='APPROVED' AND expires_at>NOW()
      ORDER BY approved_at DESC LIMIT 1`, [user.id])).rows[0];
    if (!recovery?.code_hash) return res.status(400).json({ error: "Código expirado ou ainda não aprovado pelo administrador." });

    const expected = codeHash(recovery.id, code);
    const valid = recovery.code_hash.length === expected.length && crypto.timingSafeEqual(Buffer.from(recovery.code_hash), Buffer.from(expected));
    if (!valid) {
      await pool.query(`UPDATE password_recovery_requests SET attempts=attempts+1,
        status=CASE WHEN attempts+1>=5 THEN 'EXPIRED' ELSE status END,
        expires_at=CASE WHEN attempts+1>=5 THEN NOW() ELSE expires_at END WHERE id=$1`, [recovery.id]);
      const blocked = recovery.attempts + 1 >= 5;
      return res.status(400).json({ error: blocked ? "Código bloqueado após muitas tentativas. Solicite uma nova recuperação." : "Usuário ou código de recuperação inválido." });
    }
    if (await bcrypt.compare(newPassword, user.password_hash)) return res.status(400).json({ error: "A nova senha deve ser diferente da senha atual." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2", [await bcrypt.hash(newPassword, 12), user.id]);
      await client.query("UPDATE password_recovery_requests SET status='USED',used_at=NOW(),code_hash=NULL WHERE id=$1 AND status='APPROVED'", [recovery.id]);
      await client.query("UPDATE password_recovery_requests SET status='EXPIRED',expires_at=NOW(),code_hash=NULL WHERE user_id=$1 AND id<>$2 AND status IN ('PENDING','APPROVED')", [user.id, recovery.id]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally { client.release(); }

    await revokeSessions(user.id);
    await audit(user.id, "PASSWORD_RECOVERY_COMPLETED", "user", user.id, { recovery_request_id: recovery.id });
    res.json({ ok: true, message: "Senha alterada. Entre novamente com a nova senha." });
  }));
}
