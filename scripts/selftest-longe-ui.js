// Regra LONGE na interface: selo "LONGE · R$ 12" no card, resumo do turno, mapa da
// zona com Leaflet local, colunas Normais/Longas/Valor longa no Financeiro e as
// transformações do prestart (LONGE manual e planilha mensal) ainda aplicáveis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("public/index.html", root), "utf8");
let count = 0;
function test(name, fn) { fn(); count++; console.log("PASS " + name); }

const context = vm.createContext({ escapeHtml: v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  brl: v => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) });
for (const name of ["brlShort", "courierLongeBadgeHtml", "paymentLongeCell"]) {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at > 0, name);
  const end = html.indexOf("\nfunction ", at + 10);
  vm.runInContext(html.slice(at, end), context);
}

test("card do motoboy mostra LONGE · R$ 12 (e marca teste)", () => {
  assert.match(context.courierLongeBadgeHtml({ longe: { status: "LONGE", mode: "ACTIVE", amount: 12 } }), />LONGE · R\$ 12</);
  const test = context.courierLongeBadgeHtml({ longe: { status: "LONGE", mode: "TEST", amount: 12 } });
  assert.match(test, /longe-pill test/); assert.match(test, /não altera o pagamento/);
  assert.equal(context.courierLongeBadgeHtml({ longe: { status: "NORMAL", mode: "ACTIVE", amount: 12 } }), "");
  assert.equal(context.courierLongeBadgeHtml({ longe: null }), "");
  assert.ok(html.includes("${courierLongeBadgeHtml(x)}</div>"), "selo dentro do cabeçalho do card");
});

test("resumo do turno e extrato mostram as longas", () => {
  assert.ok(html.includes('id="myPaymentLongeLabel" class="label">LONGE · R$ 12'));
  assert.ok(html.includes("$('myPaymentLongeLabel').textContent=`LONGE · ${brlShort("));
  assert.ok(html.includes("+' LONGE':'')"), "extrato mensal por turno");
});

test("Financeiro: Normais, Longas (com correção) e Valor longa", () => {
  assert.ok(html.includes('<th title="Entregas dentro da zona de 6,7 km">Normais</th><th title="Entregas fora da zona de 6,7 km (LONGE)">Longas</th><th title="LONGE = 2x o valor por entrega">Valor longa</th>'));
  const cell = context.paymentLongeCell({ longe_count: 2, longe_test_count: 1, longe_unknown_count: 1, longe_rule_active: true, shift_code: "LUNCH" }, "7-LUNCH");
  assert.match(cell, /<b>2<\/b>/); assert.match(cell, /openLongeOrders\('7-LUNCH'\)/); assert.match(cell, /1 teste/); assert.match(cell, /1 sem local/);
  assert.doesNotMatch(context.paymentLongeCell({ longe_count: 0 }, "x"), /Corrigir/, "sem regra no turno não há correção");
  assert.ok(html.includes('id="longeOrdersModal"') && html.includes("Motivo da correção (obrigatório)"));
  assert.ok(html.includes("api(`/api/admin/longe/orders/${id}`,{method:'PUT'"));
  assert.ok(html.includes("row.total_amount=Math.round((Number(row.delivery_count||0)*Number(row.per_delivery||0)+Number(row.longe_extra_amount||0)+"), "planilha mensal soma a longa");
});

test("mapa da zona com Leaflet servido pelo próprio app", () => {
  for (const file of ["leaflet.js", "leaflet.css", "LICENSE.txt"]) assert.ok(fs.statSync(new URL(`public/vendor/leaflet/${file}`, root)).size > 1000, file);
  assert.ok(html.includes("script.src='/vendor/leaflet/leaflet.js'"));
  assert.ok(html.includes('id="courierLongeMap"') && html.includes('id="longeAdminMap"'));
  assert.ok(html.includes("api('/api/longe/zone')"));
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
});

console.log(`PASS: ${count} verificações da interface LONGE.`);
