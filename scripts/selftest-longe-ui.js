// Regra LONGE na interface: tudo fica no admin (Financeiro com Normais/Longas/Valor
// longa, correção com motivo, mapa da zona). A tela do motoboy não ganha nada novo:
// nem selo, nem valor, nem mapa. As transformações do prestart continuam aplicáveis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("public/index.html", root), "utf8");
const server = fs.readFileSync(new URL("server.js", root), "utf8");
let count = 0;
function test(name, fn) { fn(); count++; console.log("PASS " + name); }
function fnSource(source, name) {
  const at = source.indexOf(name);
  assert.ok(at >= 0, name);
  return source.slice(at, source.indexOf("\n}", at));
}

test("tela do motoboy sem nada da regra LONGE", () => {
  const courierApp = html.slice(html.indexOf('<div id="courierApp"'), html.indexOf('<div id="longeOrdersModal"'));
  assert.ok(courierApp.includes('id="courierDeliveriesCard"') && courierApp.includes('id="myPaymentCard"'));
  assert.doesNotMatch(courierApp, /longe/i, "HTML do app do motoboy");
  for (const name of ["function courierDeliveryRow(", "async function loadMyPayment(", "async function loadCourierPaymentMonth(", "async function loadCourier(", "function activateCourierTab("]) {
    assert.doesNotMatch(fnSource(html, name), /longe/i, name);
  }
  assert.ok(!html.includes("/api/longe/zone") && !server.includes('"/api/longe/zone"'), "sem rota de mapa para motoboy");
  assert.doesNotMatch(fnSource(server, "async function getCourierIfoodDeliveries("), /longe/i);
  assert.doesNotMatch(fnSource(server, "async function getCourierAnotaAiDeliveries("), /longe/i);
});

const context = vm.createContext({ escapeHtml: v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  brl: v => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) });
for (const name of ["brlShort", "paymentLongeCell"]) {
  const at = html.indexOf(`function ${name}(`);
  vm.runInContext(html.slice(at, html.indexOf("\nfunction ", at + 10)), context);
}

test("Financeiro: Normais, Longas (com correção) e Valor longa", () => {
  assert.ok(html.includes('<th title="Entregas dentro da zona de 6,7 km">Normais</th><th title="Entregas fora da zona de 6,7 km (LONGE)">Longas</th><th title="LONGE = 2x o valor por entrega">Valor longa</th>'));
  const cell = context.paymentLongeCell({ longe_count: 2, longe_test_count: 1, longe_unknown_count: 1, longe_rule_active: true, shift_code: "LUNCH" }, "7-LUNCH");
  assert.match(cell, /<b>2<\/b>/); assert.match(cell, /openLongeOrders\('7-LUNCH'\)/); assert.match(cell, /1 teste/); assert.match(cell, /1 sem local/);
  assert.doesNotMatch(context.paymentLongeCell({ longe_count: 0 }, "x"), /Corrigir/, "sem regra no turno não há correção");
  assert.equal(context.brlShort(12), "R$ 12");
  assert.ok(html.includes('id="longeOrdersModal"') && html.includes("Motivo da correção (obrigatório)"));
  assert.ok(html.includes("api(`/api/admin/longe/orders/${id}`,{method:'PUT'"));
  assert.ok(html.includes("row.total_amount=Math.round((Number(row.delivery_count||0)*Number(row.per_delivery||0)+Number(row.longe_extra_amount||0)+"), "planilha mensal soma a longa");
});

test("mapa da zona só no admin, com Leaflet servido pelo próprio app", () => {
  for (const file of ["leaflet.js", "leaflet.css", "LICENSE.txt"]) assert.ok(fs.statSync(new URL(`public/vendor/leaflet/${file}`, root)).size > 1000, file);
  assert.ok(html.includes("script.src='/vendor/leaflet/leaflet.js'"));
  assert.ok(html.includes('id="longeAdminMap"') && !html.includes("courierLongeMap"));
  assert.ok(html.includes(".longe-map{") && html.includes("isolation:isolate"), "mapa não passa por cima dos modais");
});

test("prestart continua aplicável e não confunde LONGE manual com Longas", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "longe-ui-"));
  fs.mkdirSync(path.join(tmp, "scripts")); fs.mkdirSync(path.join(tmp, "public"));
  fs.writeFileSync(path.join(tmp, "public", "index.html"), html);
  for (const script of ["apply-payment-clean-sheet.js", "apply-payment-longe.js"]) {
    fs.copyFileSync(new URL(`scripts/${script}`, root), path.join(tmp, "scripts", script));
    execFileSync(process.execPath, [path.join(tmp, "scripts", script)], { stdio: "ignore" });
  }
  const patched = fs.readFileSync(path.join(tmp, "public", "index.html"), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(patched.includes(">LONGE manual</th>"));
  assert.ok(!patched.includes("row.longe_count??(Number(row.adjustment_amount"), "contagem manual lê só o ajuste salvo");
  assert.ok(patched.includes("${row.longe_rule_active?'disabled':''}"), "manual bloqueado com a regra ativa");
  assert.ok(patched.includes("<th>Observações</th><th>Normais</th><th>Longas</th><th>Valor longa</th></tr>"));
  const courierApp = patched.slice(patched.indexOf('<div id="courierApp"'), patched.indexOf('<div id="longeOrdersModal"'));
  assert.doesNotMatch(courierApp, /longe/i, "prestart também não leva LONGE ao motoboy");
});

console.log(`PASS: ${count} verificações da interface LONGE.`);
