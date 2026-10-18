// Regressão: o fechamento diário encontra a aba do dia nos dois formatos usados
// pelas planilhas reais da operação (verificados em 13/10/2026):
//   janta  "(N) MOTOBOY SETEMBRO 2026": abas "01/09 T", "02/09 Q", ...
//   almoço "(M) MOTOBOY SETEMBRO 2026": abas "01/09", "02/09", ...
// Antes, o app exigia sempre "DD/MM X" e o fechamento do almoço falhava com
// "A aba ... não existe na planilha vinculada".
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { findPaymentDayTab, syncPaymentDayToGoogleSheets, testGoogleSheetsConnection } from "../lib/google-sheets.js";

const tabs = titles => titles.map((title, i) => ({ properties: { title, sheetId: 1000 + i } }));
const days = (fmt, n = 30) => Array.from({ length: n }, (_, i) => fmt(String(i + 1).padStart(2, "0")));
const letters = ["T","Q","Q","S","S","D","S"]; // 01/09/2026 = terça
const dinnerSept = tabs([...days(d => `${d}/09 ${letters[(Number(d) - 1) % 7]}`), "Cadastro", "Configurações"]);
const lunchSept = tabs([...days(d => `${d}/09`), "Cadastro", "Configurações"]);

// 1) Resolução de aba com os nomes reais
assert.equal(findPaymentDayTab(dinnerSept.concat(), "2026-09-13", "DINNER").title, "13/09 D");
assert.equal(findPaymentDayTab(lunchSept, "2026-09-13", "LUNCH").title, "13/09");
assert.equal(findPaymentDayTab(lunchSept, "2026-09-03", "LUNCH").title, "03/09");
assert.equal(findPaymentDayTab(tabs(["03/10", "31/10", "13/10x", "113/10"]), "2026-10-13", "LUNCH"), null, "não pode casar outro dia");
assert.equal(findPaymentDayTab(tabs(["13/10", "13/10 T"]), "2026-10-13", "DINNER").title, "13/10 T", "nome exato tem prioridade");
assert.throws(() => findPaymentDayTab(tabs(["13/10 ", "13/10 Q"]), "2026-10-13", "LUNCH"), /mais de uma aba/);

// 2) Envio completo com API do Google simulada (aba de almoço sem letra)
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey };
const lunchOct = tabs([...days(d => `${d}/10`, 31), "Cadastro"]);
const calls = []; const written = {};
const fetchFn = async (url, opt = {}) => {
  const u = String(url); calls.push({ u, method: opt.method || "GET", body: typeof opt.body === "string" && opt.body.startsWith("{") ? JSON.parse(opt.body) : null });
  const ok = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.includes("oauth2.googleapis.com")) return ok({ access_token: "tok" });
  if (u.includes("values:batchClear")) return ok({});
  if (u.includes("values:batchUpdate")) { for (const d of calls.at(-1).body.data) written[d.range] = d.values; return ok({}); }
  if (u.includes("/values/")) { const range = decodeURIComponent(u.split("/values/")[1].split("?")[0]); return ok({ values: written[range] || [] }); }
  return ok({ properties: { title: "(M) MOTOBOY OUTUBRO 2026" }, sheets: lunchOct });
};
const rows = [
  { courier_name: "Ana", delivery_count: 12, base_amount: 45, rain: true, rain_bonus: 10, adjustment_amount: 0, tip_amount: 5, discount_amount: 0, payment_method: "PIX", status: "PAID", notes: "" },
  { courier_name: "João D'Ávila", delivery_count: 9, base_amount: 45, rain: false, rain_bonus: 10, adjustment_amount: 0, tip_amount: 0, discount_amount: 2.5, payment_method: "Dinheiro", status: "OPEN", notes: "LONGE 1" }
];
const result = await syncPaymentDayToGoogleSheets({ date: "2026-10-13", shiftCode: "LUNCH", rows, spreadsheetId: "SHEET_LUNCH", env, fetchFn });
assert.equal(result.tabTitle, "13/10");
assert.equal(result.rows, 2);
const clear = calls.find(c => c.u.includes("batchClear")).body.ranges;
assert.deepEqual(clear, ["'13/10'!A4:A200", "'13/10'!E4:J200", "'13/10'!M4:M200", "'13/10'!N4:P200"]);
assert.deepEqual(written["'13/10'!A4:A5"], [["Ana"], ["João D'Ávila"]]);
assert.deepEqual(written["'13/10'!E4:J5"][0], [12, 55, 5, "", "PIX", "Sim"]);
assert.deepEqual(written["'13/10'!E4:J5"][1], [9, 45, "", 2.5, "Dinheiro", "Não"]);
assert.ok(!calls.some(c => c.body && JSON.stringify(c.body).includes("13/10 T")), "não pode escrever em aba inexistente");

// 3) Teste de conexão aceita os dois formatos
calls.length = 0;
const fetchConn = async (url) => {
  const u = String(url); const ok = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
  if (u.includes("oauth2")) return ok({ access_token: "tok" });
  return ok(u.includes("LUNCH") ? { properties: { title: "almoço" }, sheets: lunchOct } :
    { properties: { title: "janta" }, sheets: tabs(days(d => `${d}/10 ${["Q","Q","S","S","D","S","T"][(Number(d) - 1) % 7]}`, 31)) });
};
const conn = await testGoogleSheetsConnection({ month: "2026-10", lunchSpreadsheetId: "LUNCH", dinnerSpreadsheetId: "DINNER", env, fetchFn: fetchConn });
assert.equal(conn.lunch.missingTabs.length, 0, JSON.stringify(conn.lunch.missingTabs));
assert.equal(conn.dinner.missingTabs.length, 0, JSON.stringify(conn.dinner.missingTabs));
assert.equal(conn.ok, true);

console.log("PASS: aba do dia encontrada nos formatos 'DD/MM X' (janta) e 'DD/MM' (almoço); envio e teste de conexão verificados.");
