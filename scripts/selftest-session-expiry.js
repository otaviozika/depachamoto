import fs from "node:fs";
import assert from "node:assert/strict";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const sw=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");

const checks={
  version:server.includes('const VERSION = "2.5.4";')&&html.includes('<title>DespachaMoto 2.5.4</title>'),
  serverCode:server.includes('code: "SESSION_EXPIRED"'),
  redirectFunction:html.includes('function redirectExpiredSession()'),
  onlyAfterAuthenticatedSession:html.includes("response?.status!==401||!me"),
  apiInterception:html.includes('await stopForExpiredSession(r);'),
  rawFetchCoverage:(html.match(/await stopForExpiredSession\(r\);/g)||[]).length>=4,
  noticeStored:html.includes("sessionStorage.setItem('dm_session_notice','expired')"),
  usernamePreserved:html.includes("sessionStorage.setItem('dm_session_username',me.username)"),
  passwordNotStored:!html.includes("sessionStorage.setItem('dm_session_password'")&&!html.includes("localStorage.setItem('dm_session_password'"),
  loginMessage:html.includes('Sua sessão expirou. Entre novamente para continuar.'),
  startupNotice:html.includes('showSessionNotice();'),
  heartbeatStillActive:html.includes("setInterval(()=>{if(me)heartbeat();},20000)"),
  cacheBumped:sw.includes('despachamoto-v2.5.4-session-expiry')
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"2.5.4",checks},null,2));
