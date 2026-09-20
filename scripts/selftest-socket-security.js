import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const frontend = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = [
  ["Socket.IO reuses the Express session", server.includes("io.engine.use(sessionMiddleware);")],
  ["Socket.IO rejects unauthenticated handshakes", server.includes('error.data = { code: "SOCKET_AUTH_REQUIRED" };')],
  ["Socket.IO validates the current database account", server.includes("const account = await currentUser(sessionUser.id);")],
  ["Admin and courier rooms are separated", server.includes('admins: "role:admin"') && server.includes('couriers: "role:courier"')],
  ["Each authenticated user gets a private room", server.includes("socket.join(SOCKET_ROOMS.user(user.id));")],
  ["Global io.emit broadcasts were removed", !/\bio\.emit\(/.test(server)],
  ["Unknown realtime events fail closed to admins", server.includes("unknown operational events never go to couriers by default")],
  ["Blocked/rejected/deleted/reset couriers have sessions revoked", (server.match(/revokeUserAccess\(/g) || []).length >= 5],
  ["Logout disconnects the browser socket", server.includes("disconnectSocketForUser(socketId, userId);")],
  ["Browser socket does not connect before authentication", frontend.includes("io({autoConnect:false})")],
  ["Browser connects realtime after showApp", frontend.includes("ensureRealtimeConnected();")],
  ["Logout sends the current socket id", frontend.includes("socket_id:socket.id||null")],
  ["Server-side socket revocation returns the browser to login", frontend.includes("reason==='io server disconnect'")]
];

let failures = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}`);
  if (!pass) failures++;
}

if (failures) {
  console.error(`Socket security self-test failed: ${failures} check(s).`);
  process.exit(1);
}

console.log(`Socket security self-test passed: ${checks.length}/${checks.length}.`);
