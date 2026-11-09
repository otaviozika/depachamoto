import assert from "node:assert/strict";
import bcryptjs from "bcryptjs";
import { compareLoginPassword } from "../lib/login-password.js";

for (const password of ["senha-com-acentuação-🛵", "antes\0depois", "🛵".repeat(30), "a".repeat(260), "x\ud800y"]) {
  const hash = await bcryptjs.hash(password, 4);
  for (const candidate of [password, "errada", password.slice(0, 72)]) {
    assert.equal(await compareLoginPassword(candidate, hash), await bcryptjs.compare(candidate, hash));
  }
}

const password = "senha-legada";
const hash = await bcryptjs.hash(password, 4);
for (const prefix of ["$2a$", "$2y$"]) {
  const legacyHash = prefix + hash.slice(4);
  assert.equal(await compareLoginPassword(password, legacyHash), true);
  assert.equal(await compareLoginPassword("errada", legacyHash), false);
}
assert.equal(await compareLoginPassword(password, "$2b$04$invalid"), false);
console.log("Login bcrypt compatibility OK");
