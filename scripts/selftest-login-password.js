import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import bcrypt from "bcrypt";
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

let active = 0;
let peak = 0;
const compareMock = mock.method(bcrypt, "compare", async value => {
  peak = Math.max(peak, ++active);
  try {
    await delay(5);
    if (value === "fail") throw new Error("Synthetic native failure");
    return true;
  } finally {
    active--;
  }
});
try {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    compareLoginPassword(i === 2 ? "fail" : password, hash)));
  assert.equal(peak, 2);
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value).length, 7);
  assert.equal(results[2].status, "rejected");
} finally {
  compareMock.mock.restore();
}
console.log("Login bcrypt compatibility OK");
