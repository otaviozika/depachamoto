// Credential epochs make deletion-only revocation safe against stale saves,
// concurrent logins and long-lived Socket.IO connections.
export function credentialVersion(value) {
  // Sessions issued before this control existed must reauthenticate once.
  if (typeof value !== "number") return -1;
  const version = value;
  return Number.isSafeInteger(version) && version >= 0 ? version : -1;
}

export function accountMatchesSession(account, sessionUser) {
  return !!account && !!sessionUser && account.active === true &&
    Number(account.id) === Number(sessionUser.id) &&
    ["admin", "courier"].includes(account.role) && account.role === sessionUser.role &&
    (account.role !== "courier" || account.approval_status === "APPROVED") &&
    Number.isSafeInteger(account.session_version) && account.session_version >= 0 &&
    credentialVersion(account.session_version) === credentialVersion(sessionUser.session_version);
}

export function authenticatedSessionUser(account) {
  return {
    id: Number(account.id), name: account.name, username: account.username,
    role: account.role, session_version: credentialVersion(account.session_version)
  };
}

export async function regenerateAuthenticatedSession(req, account) {
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.user = authenticatedSessionUser(account);
  await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

export async function changePasswordAndRevokeSessions({ pool, account, sessionUser, nextHash }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // bcrypt is intentionally completed before this short transaction.
    const locked = (await client.query(`
      SELECT id,name,username,role,active,approval_status,password_hash,session_version
      FROM users WHERE id=$1 FOR UPDATE
    `, [account.id])).rows[0];
    if (!accountMatchesSession(locked, sessionUser) || locked.password_hash !== account.password_hash) {
      const error = new Error("Seu acesso mudou. Entre novamente antes de alterar a senha.");
      error.status = 401;
      error.code = "SESSION_EXPIRED";
      throw error;
    }
    const updated = (await client.query(`
      UPDATE users SET password_hash=$1,must_change_password=false,
        session_version=session_version+1
      WHERE id=$2
      RETURNING id,name,username,role,active,approval_status,session_version
    `, [nextHash, locked.id])).rows[0];
    await client.query("DELETE FROM user_sessions WHERE (sess::jsonb #>> '{user,id}')=$1", [String(locked.id)]);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
