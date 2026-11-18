// Domínio principal (CANONICAL_HOST): desligado por padrão; quando ligado, o
// navegador leva ao domínio principal só se não houver saída guardada sem
// internet neste aparelho (a fila fica presa ao endereço antigo).
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
let count = 0;
const test = (name, fn) => { fn(); count++; console.log("PASS", name); };

function extract(source, start) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `não encontrado: ${start}`);
  let depth = 0;
  for (let j = source.indexOf("{", i); j < source.length; j++) {
    if (source[j] === "{") depth++;
    if (source[j] === "}" && --depth === 0) return source.slice(i, j + 1);
  }
  throw new Error("fim da função não encontrado");
}

function browser({ href, storage = {}, storageThrows = false }) {
  const url = new URL(href);
  const replaced = [];
  const localStorage = {
    get length() { if (storageThrows) throw new Error("bloqueado"); return Object.keys(storage).length; },
    key: i => Object.keys(storage)[i] ?? null,
    getItem: k => (k in storage ? storage[k] : null)
  };
  const location = { hostname: url.hostname, protocol: url.protocol, pathname: url.pathname, search: url.search, hash: url.hash, replace: u => replaced.push(u) };
  const ctx = vm.createContext({ localStorage, location, JSON, Array, String });
  vm.runInContext(`const OFFLINE_QUEUE_PREFIX='dm_departure_queue_v17_';\n${extract(html, "function hasPendingOfflineDepartures(")}\n${extract(html, "function moveToCanonicalHost(")}`, ctx);
  return { move: host => vm.runInContext(`moveToCanonicalHost(${JSON.stringify(host)})`, ctx), replaced };
}

const OLD = "https://depachamoto.onrender.com/?attendance_token=abc#x";
const NEW = "app.exemplo.com.br";

test("desligado: sem domínio principal, nada muda", () => {
  const b = browser({ href: OLD });
  assert.equal(b.move(null), false);
  assert.equal(b.move(""), false);
  assert.deepEqual(b.replaced, []);
});

test("ligado: leva ao domínio principal mantendo caminho, parâmetros e âncora", () => {
  const b = browser({ href: OLD, storage: { other: "1", "dm_departure_queue_v17_5": "[]" } });
  assert.equal(b.move(NEW), true);
  assert.deepEqual(b.replaced, ["https://app.exemplo.com.br/?attendance_token=abc#x"]);
});

test("NÃO leva quando há saída guardada sem internet neste aparelho", () => {
  const b = browser({ href: OLD, storage: { "dm_departure_queue_v17_7": JSON.stringify([{ orders: ["123"] }]) } });
  assert.equal(b.move(NEW), false);
  assert.deepEqual(b.replaced, []);
});

test("na dúvida (armazenamento ilegível ou bloqueado) também não leva", () => {
  assert.equal(browser({ href: OLD, storage: { "dm_departure_queue_v17_7": "{corrompido" } }).move(NEW), false);
  assert.equal(browser({ href: OLD, storageThrows: true }).move(NEW), false);
});

test("já no domínio principal, ou fora de https (teste local), não faz nada", () => {
  assert.equal(browser({ href: "https://app.exemplo.com.br/" }).move(NEW), false);
  assert.equal(browser({ href: "http://localhost:3000/" }).move(NEW), false);
});

test("servidor: valor validado e exposto em /api/public/config", () => {
  assert.match(server, /process\.env\.CANONICAL_HOST/);
  assert.match(server, /canonicalHost: CANONICAL_HOST,/);
  const block = server.slice(server.indexOf("const CANONICAL_HOST = (() => {"), server.indexOf('app.get("/api/public/config"'));
  const re = new RegExp(block.match(/if \(!(\/\^.*\$\/)\.test\(host\)\)/)[1].slice(1, -1));
  for (const ok of ["app.exemplo.com.br", "despachefull.com", "a-b.c.com.br"]) assert.ok(re.test(ok), ok);
  for (const bad of ["https://app.exemplo.com.br", "app.exemplo.com.br/", "exemplo", "app exemplo.com", "app.exemplo.com.br:443"]) assert.ok(!re.test(bad), bad);
});

test("cliente verifica o domínio antes de montar a tela", () => {
  const load = extract(html, "async function loadPublicConfig(");
  assert.match(load, /const d=await api\('\/api\/public\/config'\);\s*if\(moveToCanonicalHost\(d\.canonicalHost\)\)return;/);
});

console.log(JSON.stringify({ result: "PASS", feature: "canonical_host", cases: count }));
