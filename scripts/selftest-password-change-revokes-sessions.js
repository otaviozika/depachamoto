// Regressão de segurança: trocar a própria senha deve encerrar os acessos
// abertos em outros aparelhos (sessões HTTP e sockets), mantendo o atual.
// Validado de ponta a ponta (servidor real + PostgreSQL + 2 aparelhos) no PR
// que introduziu este teste; aqui garantimos que o contrato não se perca.
import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const route = server.slice(server.indexOf('app.post("/api/account/password"'));
const routeBody = route.slice(0, route.indexOf("\n}));") + 4);
const helper = server.match(/async function revokeOtherUserSessions\(userId, keepSessionId\) \{[\s\S]*?\n\}/)?.[0] || "";

const checks = {
  helperExists: helper.length > 0,
  helperKeepsCurrentSession: helper.includes("sid<>$2") && helper.includes("(sess::jsonb #>> '{user,id}')=$1"),
  helperDisconnectsOtherSockets: helper.includes("fetchSockets()") && helper.includes("socket.data?.sessionId !== keep") && helper.includes("socket.disconnect(true)"),
  socketRemembersSession: server.includes('socket.data.sessionId = String(socket.request.sessionID || "");'),
  routeRevokesAfterUpdate: routeBody.indexOf("UPDATE users SET password_hash") > -1 &&
    routeBody.indexOf("revokeOtherUserSessions(user.id, req.sessionID)") > routeBody.indexOf("UPDATE users SET password_hash"),
  routeAuditsRevocation: routeBody.includes("other_sessions_revoked: revoked.sessions"),
  adminResetStillRevokesAll: /reset-password[\s\S]*?await revokeUserAccess\(q\.rows\[0\]\.id\);/.test(server)
};
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
