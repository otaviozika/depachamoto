import fs from "node:fs";
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const checks=[
 ["HTTP auth returns explicit SESSION_EXPIRED", /code: "SESSION_EXPIRED"/.test(server)],
 ["Socket handshake requires authenticated session", /SOCKET_AUTH_REQUIRED/.test(server)&&/io\.use\(async \(socket, next\)/.test(server)],
 ["Socket handshake revalidates active account", /const account = await currentUser\(sessionUser\.id\)/.test(server)],
 ["Connected sockets periodically reload session", /socket\.request\.session\.reload/.test(server)],
 ["Revoked user sockets can be disconnected immediately", /async function disconnectUserSockets/.test(server)],
 ["Realtime unknown events fail closed to admins", /Fail closed: unknown operational events never go to couriers/.test(server)],
 ["Courier departure has database client-token uniqueness", /dispatches_client_token_unique_idx/.test(server)],
 ["Courier departure transaction replays same client token", /WHERE d\.client_token=\$1[\s\S]{0,700}duplicate: true/.test(server)],
 ["Reconciliation endpoint is courier-authenticated", /app\.get\("\/api\/courier\/depart\/reconcile\/:clientToken", auth, courierOnly/.test(server)],
 ["Reconciliation is scoped to current courier", /d\.courier_id=\$2[\s\S]{0,180}\[clientToken, req\.session\.user\.id\]/.test(server)],
 ["Reconciliation cannot expose admin-created dispatches", /d\.registration_source='COURIER'/.test(server)],
 ["Client keeps same client_token for uncertain request", /const payload=\{[\s\S]{0,500}client_token:makeClientToken\(\)/.test(html)],
 ["Client never blindly retries uncertain mutation after network loss", /Não repita a saída agora/.test(html)&&/reconcileCourierDeparture\(payload\.client_token\)/.test(html)],
 ["Uncertain operation survives page background/reconnect in sessionStorage", /dm_uncertain_departure/.test(html)],
 ["Online event performs authoritative recovery", /window\.addEventListener\('online',[\s\S]{0,160}recoverAfterConnectivityChange/.test(html)],
 ["Foreground return performs authoritative recovery", /visibilitychange[\s\S]{0,220}recoverAfterConnectivityChange/.test(html)],
 ["Socket reconnect refreshes courier authoritative state", /courier-reconnect[\s\S]{0,180}loadCourierDeliveries/.test(html)],
 ["Socket reconnect refreshes admin authoritative state", /admin-reconnect/.test(html)],
 ["Socket auth failure uses session-expired flow", /connect_error[\s\S]{0,180}redirectExpiredSession/.test(html)],
 ["HTTP 401 uses session-expired flow", /stopForExpiredSession[\s\S]{0,220}redirectExpiredSession/.test(html)],
 ["Network errors are distinct from session expiry", /err\.code='NETWORK_ERROR'/.test(html)],
 ["GET requests remain coalesced during reconnect storms", /const apiGetInFlight=new Map/.test(html)],
 ["Courier departure stays online-only for platform validation", /Conexão obrigatória: o pedido precisa ser validado/.test(html)],
 ["Offline legacy queue cannot create new courier departures", /offline_queued === true[\s\S]{0,700}IFOOD_ONLINE_VALIDATION_REQUIRED/.test(server)]
];
let failed=0;for(const [n,ok] of checks){console.log((ok?"PASS":"FAIL")+" - "+n);if(!ok)failed++}
if(failed){console.error(`Reconnect/session self-test failed: ${failed} check(s).`);process.exit(1)}
console.log(`Reconnect/session self-test passed: ${checks.length}/${checks.length}.`);
