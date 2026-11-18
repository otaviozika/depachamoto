// O código versionado é exatamente o código que roda em produção.
// Nenhum script pode reescrever server.js, lib/ ou public/ na inicialização.
import fs from "node:fs";
import assert from "node:assert/strict";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const hook of ["prestart", "poststart", "preinstall", "postinstall", "prepare"]) {
  assert.equal(pkg.scripts?.[hook], undefined, `package.json não deve ter o hook "${hook}"`);
}
assert.equal(pkg.scripts.start, "node server.js", "start deve só iniciar o servidor");

const patches = fs.readdirSync(new URL("./", import.meta.url)).filter(name => /^apply-.*\.js$/.test(name));
assert.deepEqual(patches, [], "scripts de patch não são permitidos: altere o código-fonte diretamente");

const sources = ["../server.js", ...fs.readdirSync(new URL("../lib/", import.meta.url)).map(f => `../lib/${f}`)];
for (const file of sources) {
  const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  assert.doesNotMatch(text, /writeFileSync\([^)]*(server\.js|index\.html|service-worker\.js)/, `${file} não pode reescrever código-fonte`);
}

const shifts = fs.readFileSync(new URL("../lib/operational-shift.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
assert.ok(shifts.includes("const derived = dispatchShiftAt(departedAt);"), "saída usa a janela de despacho");
assert.ok(server.includes("await installPasswordRecovery("), "recuperação de senha conectada no fonte");

console.log(JSON.stringify({ result: "PASS", feature: "no_startup_mutation" }));
