import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { Pool } from "./test-support/pglite-pool.js";
import { accountMatchesSession, authenticatedSessionUser, credentialVersion, changePasswordAndRevokeSessions } from "../lib/session-security.js";

const pool = new Pool();
let checks = 0;
const check = (condition, name) => { assert.ok(condition, name); checks++; console.log("PASS - " + name); };
try {
  await pool.query(`CREATE TABLE users(id integer PRIMARY KEY,name text,username text,role text,active boolean,approval_status text,password_hash text,must_change_password boolean,session_version integer NOT NULL DEFAULT 0);
    CREATE TABLE user_sessions(sid text PRIMARY KEY,sess jsonb);
    INSERT INTO users VALUES(1,'Synthetic admin','audit_admin','admin',true,'APPROVED','old-hash',false,0),(2,'Other user','other','courier',true,'APPROVED','other-hash',false,0);
    INSERT INTO user_sessions VALUES('old-A','{"user":{"id":1,"role":"admin"}}'),('old-B','{"user":{"id":1,"role":"admin","session_version":0}}'),('other','{"user":{"id":2,"role":"courier","session_version":0}}');`);
  const account = (await pool.query("SELECT * FROM users WHERE id=1")).rows[0];
  const legacy = { id: 1, role: "admin" };
  const current = { ...legacy, session_version: 0 };
  check(!accountMatchesSession(account, legacy), "pre-upgrade sessions require fresh login, including epoch zero");
  check(accountMatchesSession(account, current), "fresh epoch-zero session authenticates normally");
  check(!accountMatchesSession({ ...account, active: false }, legacy), "disabled administrator rejected");
  check(!accountMatchesSession({ ...account, role: "courier" }, legacy), "stale administrator role rejected");
  check(!accountMatchesSession({ ...account, session_version: null }, legacy), "malformed database epoch fails closed even with legacy cookie");
  for (const value of [undefined, null, -1, NaN, Infinity, true, "0", {}, []]) check(credentialVersion(value) === -1, "malformed epoch rejected: " + typeof value);
  const outcomes = await Promise.allSettled(["first-hash", "second-hash"].map(nextHash => changePasswordAndRevokeSessions({ pool, account, sessionUser: current, nextHash })));
  check(outcomes.filter(x => x.status === "fulfilled").length === 1, "exactly one concurrent password change succeeds");
  check(outcomes.find(x => x.status === "rejected")?.reason.code === "SESSION_EXPIRED", "losing concurrent change cannot overwrite winner");
  const updated = (await pool.query("SELECT * FROM users WHERE id=1")).rows[0];
  check(updated.session_version === 1, "credential epoch incremented once");
  check(!accountMatchesSession(updated, legacy), "deleted legacy session cannot authenticate if resurrected");
  check(!accountMatchesSession(updated, current), "old versioned session cannot authenticate after password change");
  check(accountMatchesSession(updated, authenticatedSessionUser(updated)), "new rotated session is valid");
  const remaining = (await pool.query("SELECT sid FROM user_sessions")).rows;
  check(remaining.length === 1 && remaining[0].sid === "other", "all user sessions deleted, other user's session preserved");

  // Simulate an old request writing its session after deletion.
  await pool.query("INSERT INTO user_sessions VALUES('resurrected',$1::jsonb)", [JSON.stringify({ user: legacy })]);
  check(!accountMatchesSession(updated, legacy), "stale store upsert cannot bypass epoch check");

  // A failed revocation must roll back both the new hash and epoch.
  await pool.query("DROP TABLE user_sessions");
  await assert.rejects(changePasswordAndRevokeSessions({ pool, account: updated, sessionUser: authenticatedSessionUser(updated), nextHash: "must-not-persist" }));
  const afterFailure = (await pool.query("SELECT * FROM users WHERE id=1")).rows[0];
  check(afterFailure.password_hash === updated.password_hash && afterFailure.session_version === updated.session_version, "revocation failure rolls back hash and epoch together");
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const start=server.indexOf('async function disconnectUserSockets('),end=server.indexOf('function disconnectSocketForUser(',start);
  const disconnected=[],events=[];
  const context=vm.createContext({
    io:{sockets:{sockets:new Map([['self',{data:{user:{id:1}},disconnect:()=>disconnected.push(1)}],['other',{data:{user:{id:2}},disconnect:()=>disconnected.push(2)}]])},in:()=>({fetchSockets:async()=>{throw new Error('Synthetic adapter outage');}})},
    SOCKET_ROOMS:{user:id=>'user:'+id},auditBestEffort:async(...args)=>events.push(args)
  });
  vm.runInContext(server.slice(start,end),context);
  check(await context.disconnectUserSockets(1)===1&&disconnected.join(',')==='1', "adapter outage still disconnects this instance's old sockets and preserves other users");
  check(events[0]?.[1]==='SOCKET_REVOCATION_DEFERRED', "deferred remote revocation is monitorable without exposing adapter details");
  console.log(`Session revocation self-test passed: ${checks}/${checks}.`);
} finally { await pool.end(); }
