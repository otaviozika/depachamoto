// Velocidade sem mudar regras: (1) a sessão não é regravada a cada requisição
// (validade de 12 h a partir do login, igual ao cookie); (2) a conferência de conta
// válida tem cache curto, só de contas válidas, limpo por qualquer alteração de admin
// e protegido contra leituras antigas (geração).
import fs from "node:fs";
import assert from "node:assert/strict";
import { accountCacheTtlFromEnv, createAccountCache, DEFAULT_ACCOUNT_CACHE_TTL_MS } from "../lib/session-account-cache.js";

let count = 0;
const test = (name, fn) => { fn(); count++; console.log("PASS", name); };
const valid = { role: "courier", active: true, approval_status: "APPROVED", password_hash: "não deve ir ao cache" };

test("guarda por até 10 s e expira sozinho", () => {
  let clock = 1000;
  const cache = createAccountCache({ now: () => clock });
  assert.equal(DEFAULT_ACCOUNT_CACHE_TTL_MS, 10_000);
  assert.equal(cache.set(7, valid, cache.generation()), true);
  assert.deepEqual({ ...cache.get(7) }, { role: "courier", active: true, approval_status: "APPROVED" }, "só os 3 campos necessários");
  assert.ok(Object.isFrozen(cache.get(7)));
  clock += 9_999; assert.ok(cache.get(7));
  clock += 1; assert.equal(cache.get(7), null, "expirou em 10 s");
});

test("alteração de admin limpa tudo na hora", () => {
  const cache = createAccountCache();
  cache.set(1, valid, cache.generation()); cache.set(2, valid, cache.generation());
  cache.invalidateAll();
  assert.equal(cache.get(1), null); assert.equal(cache.get(2), null); assert.equal(cache.size(), 0);
});

test("leitura iniciada antes da alteração não volta ao cache depois dela", () => {
  const cache = createAccountCache();
  const generationAtRead = cache.generation(); // requisição do motoboy começa a ler (conta ainda ativa)
  cache.invalidateAll();                       // admin desativa no meio do caminho
  assert.equal(cache.set(9, valid, generationAtRead), false);
  assert.equal(cache.get(9), null);
});

test("desligável (0) e com limite de tamanho", () => {
  const off = createAccountCache({ ttlMs: 0 });
  assert.equal(off.enabled, false);
  assert.equal(off.set(1, valid, off.generation()), false);
  assert.equal(off.get(1), null);
  const small = createAccountCache({ maxEntries: 2 });
  small.set(1, valid, 0); small.set(2, valid, 0); small.set(3, valid, 0);
  assert.ok(small.size() <= 2);
});

test("configuração ACCOUNT_CACHE_TTL_MS validada", () => {
  assert.equal(accountCacheTtlFromEnv(undefined), 10_000);
  assert.equal(accountCacheTtlFromEnv(""), 10_000);
  assert.equal(accountCacheTtlFromEnv("0"), 0);
  assert.equal(accountCacheTtlFromEnv("5000"), 5000);
  for (const bad of ["-1", "abc", "60001", "1.5"]) assert.throws(() => accountCacheTtlFromEnv(bad), /ACCOUNT_CACHE_TTL_MS/);
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("sessão: sem regravação a cada requisição, cookie de 12 h sem rolling", () => {
  const block = server.slice(server.indexOf("const sessionMiddleware = session({"), server.indexOf("app.use(sessionMiddleware);"));
  assert.match(block, /disableTouch: true/);
  assert.match(block, /resave: false/);
  assert.doesNotMatch(block, /rolling:\s*true/, "cookie não é renovado; a validade segue a do login");
  assert.match(block, /maxAge: 1000 \* 60 \* 60 \* 12/);
  // Nenhuma rota altera a sessão depois do login (isso reenviaria o cookie com nova validade).
  const assignments = [...server.matchAll(/req\.session\.([a-zA-Z_]+)\s*=(?!=)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(assignments)], ["user"], "só o login grava na sessão");
});

test("auth usa o cache só para contas válidas, lendo a geração antes da consulta", () => {
  const auth = server.slice(server.indexOf("async function auth(req, res, next) {"), server.indexOf("function adminOnly("));
  const iGet = auth.indexOf("sessionAccounts.get(sessionUser.id)");
  const iGen = auth.indexOf("const generation = sessionAccounts.generation();");
  const iQuery = auth.indexOf('"SELECT role,active,approval_status FROM users WHERE id=$1"');
  const iSet = auth.indexOf("if (sessionAccountValid(sessionUser, account)) sessionAccounts.set(sessionUser.id, account, generation);");
  assert.ok(iGet > 0 && iGen > iGet && iQuery > iGen && iSet > iQuery, "ordem: cache → geração → banco → guarda só se válida");
  assert.match(auth, /if \(!sessionAccountValid\(sessionUser, account\)\) \{\s*await new Promise\(resolve => req\.session\.destroy/, "conta inválida continua sendo barrada");
});

test("toda alteração de admin invalida o cache antes e depois", () => {
  const i = server.indexOf("const sessionAccounts = createAccountCache(");
  const mw = server.slice(i, server.indexOf("\n});", i) + 4);
  assert.match(mw, /req\.session\?\.user\?\.role === "admin" && !\["GET", "HEAD", "OPTIONS"\]\.includes\(req\.method\)/);
  assert.match(mw, /sessionAccounts\.invalidateAll\(\);\s*res\.once\("finish", \(\) => sessionAccounts\.invalidateAll\(\)\);\s*res\.once\("close", \(\) => sessionAccounts\.invalidateAll\(\)\);/);
  assert.ok(i < server.indexOf('app.post("/api/login"'), "registrado antes de todas as rotas");
});

test("escritas em usuários fora de rotas de admin não afetam a validade da conta", () => {
  // Cada UPDATE de users fora do admin só pode mexer em senha ou PIX; quem muda
  // active/approval_status/role é sempre uma rota de admin (coberta pelo middleware).
  const lines = server.split("\n");
  const routeOf = idx => { for (let k = idx; k >= 0; k--) if (/^app\.(get|post|put|patch|delete)\(/.test(lines[k])) return lines[k]; return "inicialização"; };
  for (let idx = 0; idx < lines.length; idx++) {
    if (!/UPDATE users\b/.test(lines[idx])) continue;
    const sql = lines.slice(idx, idx + 4).join(" ");
    const route = routeOf(idx);
    if (/adminOnly/.test(route) || route === "inicialização" || !/^app\./.test(route)) continue;
    assert.doesNotMatch(sql, /\b(active|approval_status|role)\s*=/, `rota sem admin alterando validade: ${route}`);
  }
});

console.log(JSON.stringify({ result: "PASS", feature: "session_account_cache", cases: count }));
