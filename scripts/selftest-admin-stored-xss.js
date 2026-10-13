// Regressão de segurança: XSS armazenado via nome de motoboy no painel admin.
//
// Antes da correção, o nome (que entra pelo cadastro público) era colocado
// dentro do JavaScript de atributos onclick. O navegador decodifica entidades
// HTML do atributo ANTES de executar o código, então escapeHtml() não protegia
// e encodeURIComponent() mantém apóstrofo e parênteses. Um nome como
// x')-alert(1)-(' executava código na sessão do administrador.
//
// Regra garantida por este teste: handlers inline (onclick, onchange...) só
// podem interpolar valores numéricos ou chaves geradas pelo próprio sistema.
// Textos vão em atributos data-* (escapados com escapeHtml) e são lidos via
// this.dataset, que nunca é interpretado como código.
//
// Uso: node scripts/selftest-admin-stored-xss.js [caminho/do/index.html]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.resolve(process.argv[2] || path.join(root, "public", "index.html"));
const html = fs.readFileSync(htmlPath, "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

// ---------------------------------------------------------------------------
// 1) Varredura de todos os handlers inline com interpolação ${...}
// ---------------------------------------------------------------------------
const NUMERIC = /^\s*(?:Number\([^()]*\)|!?[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(?:id|courier_id|dispatch_id|active)|\d+)\s*$/;
// Chaves montadas pelo próprio sistema (IDs numéricos, códigos de turno e datas
// ISO vindos do servidor ou gerados no navegador). Nenhum texto livre de usuário.
const SYSTEM_KEYS = new Set(["key", "date"]);

function inlineHandlers(source) {
  const out = [];
  const re = /\son[a-z]+\s*=\s*"/g;
  let m;
  while ((m = re.exec(source))) {
    let i = re.lastIndex, depth = 0, body = "";
    while (i < source.length) {
      if (source.startsWith("${", i)) { depth++; body += "${"; i += 2; continue; }
      const c = source[i];
      if (c === "}" && depth) depth--;
      if (c === "\"" && depth === 0) break;
      body += c; i++;
    }
    out.push({ line: source.slice(0, m.index).split("\n").length, body });
  }
  return out;
}

function interpolations(body) {
  const out = [];
  let i = 0;
  for (;;) {
    const start = body.indexOf("${", i);
    if (start < 0) return out;
    let depth = 0, k = start;
    for (; k < body.length; k++) {
      if (body.startsWith("${", k)) { depth++; k++; continue; }
      if (body[k] === "}" && --depth === 0) break;
    }
    out.push(body.slice(start + 2, k).trim());
    i = k + 1;
  }
}

const unsafe = [];
let handlerCount = 0;
for (const h of inlineHandlers(html)) {
  handlerCount++;
  for (const expr of interpolations(h.body)) {
    if (!NUMERIC.test(expr) && !SYSTEM_KEYS.has(expr)) unsafe.push(`linha ${h.line}: \${${expr}}`);
  }
}
assert.ok(handlerCount > 50, `esperava encontrar os handlers inline do painel (achou ${handlerCount})`);
assert.deepEqual(unsafe, [], `handlers inline interpolando texto não numérico:\n${unsafe.join("\n")}`);

// ---------------------------------------------------------------------------
// 2) Os três botões corrigidos usam data-* + this.dataset
// ---------------------------------------------------------------------------
const fixedButtons = [
  'data-courier-name="${escapeHtml(x.name)}" onclick="checkoutCourier(${Number(x.courier_id)},this.dataset.courierName)"',
  'data-courier-name="${escapeHtml(x.name)}" onclick="resetCourierPassword(${Number(x.id)},this.dataset.courierName)"',
  'data-platform="${escapeHtml(platform)}" onclick="applyOrderPlatformChoice(this.closest(\'.order-row\').querySelector(\'.order-input\'),this.dataset.platform)"'
];
for (const snippet of fixedButtons) assert.ok(html.includes(snippet), `botão corrigido ausente: ${snippet.slice(0, 80)}`);
assert.ok(!html.includes("decodeURIComponent('${encodeURIComponent("), "padrão vulnerável encodeURIComponent em onclick voltou");

// ---------------------------------------------------------------------------
// 3) Payloads reais: com a função escapeHtml do próprio app, o nome sai do
//    atributo data-* exatamente igual (como texto) e nunca vira código.
// ---------------------------------------------------------------------------
const escapeSrc = html.match(/function escapeHtml\(v\)\{return [^\n]*?\[c\]\)\)\}/);
assert.ok(escapeSrc, "não encontrei escapeHtml em index.html");
const escapeHtml = new Function(`${escapeSrc[0]}; return escapeHtml;`)();
const decodeAttr = v => v.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[e]);
const payloads = [
  "x')-alert(1)-('",
  "x');alert(document.cookie);//",
  "\"><img src=x onerror=alert(1)>",
  "João D'Ávila"
];
for (const name of payloads) {
  const attr = escapeHtml(name);
  assert.ok(!/["<>]/.test(attr), `atributo não escapado para: ${name}`);
  assert.equal(decodeAttr(attr), name, "o nome deve chegar ao JavaScript como texto, sem alteração");
}

// ---------------------------------------------------------------------------
// 4) Segunda camada no servidor: validação do nome nos pontos de gravação.
// ---------------------------------------------------------------------------
const fnSrc = server.match(/function personNameError\(name, missingMessage\) \{[\s\S]*?\n\}/);
assert.ok(fnSrc, "personNameError ausente em server.js");
const personNameError = new Function(`${fnSrc[0]}; return personNameError;`)();
const MISSING = "faltando";
for (const ok of ["Ana", "João D'Ávila", "Maria-Clara Souza", "José (Zé) Silva", "a".repeat(80)]) {
  assert.equal(personNameError(ok, MISSING), null, `nome legítimo recusado: ${ok}`);
}
assert.equal(personNameError("Jo", MISSING), MISSING);
assert.ok(personNameError("a".repeat(81), MISSING));
for (const bad of ["<script>alert(1)</script>", "Ana<b>", "Ana>", "Ana\u0000", "Ana\nBeto", "Ana\u007F"]) {
  assert.ok(personNameError(bad, MISSING), `nome com marcação/controle aceito: ${JSON.stringify(bad)}`);
}
const calls = server.match(/personNameError\(name, "/g) || [];
assert.equal(calls.length, 3, "esperava a validação no cadastro público, na criação e na edição pelo admin");

console.log(`PASS: ${handlerCount} handlers inline sem texto livre; 3 botões via data-*; payloads neutralizados; nome validado no servidor (${path.relative(root, htmlPath)}).`);
