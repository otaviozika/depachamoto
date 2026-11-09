// Regressão: o fechamento diário encontra a aba do dia nos dois formatos usados
// pelas planilhas reais da operação (verificados em 13/10/2026):
//   janta  "(N) MOTOBOY SETEMBRO 2026": abas "01/09 T", "02/09 Q", ...
//   almoço "(M) MOTOBOY SETEMBRO 2026": abas "01/09", "02/09", ...
// Antes, o app exigia sempre "DD/MM X" e o fechamento do almoço falhava com
// "A aba ... não existe na planilha vinculada".
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { paymentDaySheetTitle, findPaymentDayTab, syncPaymentDayToGoogleSheets, testGoogleSheetsConnection } from "../lib/google-sheets.js";

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

// 1b) Regressao 11/2026: as abas reais ora usam "DDMM X", ora "DD/MM X".
const novTitles = Array.from({ length: 30 }, (_, i) => paymentDaySheetTitle(`2026-11-${String(i + 1).padStart(2, "0")}`, "DINNER"));
const novLunch = tabs(novTitles.map(title => title.replace("/", "")));
const novDinner = tabs(novTitles.map((title, i) => i === 1 ? title : title.replace("/", "")));
assert.equal(findPaymentDayTab(novLunch, "2026-11-01", "LUNCH").title, "0111 D");
assert.equal(findPaymentDayTab(novDinner, "2026-11-02", "DINNER").title, "02/11 S");
assert.equal(findPaymentDayTab(novDinner, "2026-11-03", "DINNER").title, "0311 T");
assert.equal(findPaymentDayTab(novDinner, "2026-11-04", "DINNER").title, "0411 Q");
assert.equal(findPaymentDayTab(tabs(["0211 S", "0311 T"]), "2026-11-01", "DINNER"), null);
assert.equal(findPaymentDayTab(tabs(["0310 S", "0311 T"]), "2026-10-03", "DINNER").title, "0310 S");
assert.throws(() => findPaymentDayTab(tabs(["0311 T", "0311"]), "2026-11-03", "DINNER"), /mais de uma aba/);
assert.equal(findPaymentDayTab(tabs(["03/11 T", "0311 T"]), "2026-11-03", "DINNER").title, "03/11 T");

// 2) Envio completo com API do Google simulada (aba de almoço sem letra)
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@test.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey };
const lunchOct = tabs([...days(d => `${d}/10`, 31), "Cadastro"]);
const calls = []; let written = [];
const submittedNames = updates => updates.find(({ range }) => range.startColumnIndex === 0)
  .rows.map(row => row.values.map(cell => cell.userEnteredValue.stringValue));
const unpack = row => row.values.map(cell => cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.stringValue ?? "");
const fetchFn = async (url, opt = {}) => {
  const u = String(url); calls.push({ u, method: opt.method || "GET", body: typeof opt.body === "string" && opt.body.startsWith("{") ? JSON.parse(opt.body) : null });
  const ok = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.includes("oauth2.googleapis.com")) return ok({ access_token: "tok" });
  if (u.endsWith(":batchUpdate")) { written = calls.at(-1).body.requests.map(request => request.updateCells); return ok({}); }
  if (decodeURIComponent(u).includes("'13/10'!C3:D3")) return ok({ values: [["CHAVE PIX", "TIPO PIX"]] });
  if (decodeURIComponent(u).includes("'13/10'!A4:D5")) return ok({ values: submittedNames(written) });
  return ok({ properties: { title: "(M) MOTOBOY OUTUBRO 2026" }, sheets: lunchOct });
};
const rows = [
  { courier_name: "Ana", delivery_count: 12, base_amount: 45, rain: true, rain_bonus: 10, adjustment_amount: 0, tip_amount: 5, discount_amount: 0, payment_method: "PIX", status: "PAID", notes: "" },
  { courier_name: "João D'Ávila", delivery_count: 9, base_amount: 45, rain: false, rain_bonus: 10, adjustment_amount: 0, tip_amount: 0, discount_amount: 2.5, payment_method: "Dinheiro", status: "OPEN", notes: "LONGE 1" }
];
const result = await syncPaymentDayToGoogleSheets({ date: "2026-10-13", shiftCode: "LUNCH", rows, spreadsheetId: "SHEET_LUNCH", env, fetchFn });
assert.equal(result.tabTitle, "13/10");
assert.equal(result.rows, 2);
assert.deepEqual(submittedNames(written), [["Ana"], ["João D'Ávila"]]);
const payments = written.find(({ range }) => range.startColumnIndex === 4);
assert.deepEqual(payments.rows.map(unpack), [[12, 55, 5, "", "PIX", "Sim"], [9, 45, "", 2.5, "Dinheiro", "Não"]]);
assert.ok(written.every(({ range }) => range.sheetId === findPaymentDayTab(lunchOct, "2026-10-13", "LUNCH").sheetId));

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

// 4) Preflight de novembro: todos os 30 dias existem nos modelos reais sem "/" e misto.
const connNov = await testGoogleSheetsConnection({
  month: "2026-11", lunchSpreadsheetId: "NOV_LUNCH", dinnerSpreadsheetId: "NOV_DINNER",
  env, fetchFn: async (url) => {
    const u = String(url);
    const ok = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (u.includes("oauth2.googleapis.com")) return ok({ access_token: "tok" });
    return ok({ properties: { title: "Novembro 2026" }, sheets: u.includes("NOV_LUNCH") ? novLunch : novDinner });
  }
});
assert.equal(connNov.ok, true, "todos os 30 dias devem ser encontrados sem renomear as planilhas");
assert.equal(connNov.lunch.tabsFound, 30);
assert.equal(connNov.dinner.tabsFound, 30);

// 5) Envio de janta em 03/11 deve usar exatamente a aba existente "0311 T".
let novWrites = [];
const novCalls = [];
const novResult = await syncPaymentDayToGoogleSheets({
  date: "2026-11-03", shiftCode: "DINNER", rows, spreadsheetId: "NOV_DINNER", env,
  fetchFn: async (url, options = {}) => {
    const u = String(url);
    novCalls.push({ url: u, method: options.method || "GET" });
    const ok = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (u.includes("oauth2.googleapis.com")) return ok({ access_token: "tok" });
    if (u.endsWith(":batchUpdate")) {
      novWrites = JSON.parse(options.body).requests.map(request => request.updateCells);
      return ok({});
    }
    if (decodeURIComponent(u).includes("'0311 T'!C3:D3")) return ok({ values: [["CHAVE PIX", "TIPO PIX"]] });
    if (decodeURIComponent(u).includes("'0311 T'!A4:D5")) return ok({ values: submittedNames(novWrites) });
    return ok({ properties: { title: "Novembro 2026" }, sheets: novDinner });
  }
});
assert.equal(novResult.tabTitle, "0311 T");
assert.deepEqual(submittedNames(novWrites), [["Ana"], ["João D'Ávila"]]);
assert.ok(!novCalls.some(c => c.url.includes("NOV_LUNCH")), "janta nunca escreve na planilha de almoço");
assert.ok(novWrites.every(({ range }) => range.sheetId === findPaymentDayTab(novDinner, "2026-11-03", "DINNER").sheetId));

// 6) Google 403 por permissao vira erro claro; nao muda credenciais nem faz retry de escrita.
await assert.rejects(
  () => testGoogleSheetsConnection({
    month: "2026-11", lunchSpreadsheetId: "NOV_LUNCH", dinnerSpreadsheetId: "NOV_DINNER", env,
    fetchFn: async (url) => {
      if (String(url).includes("oauth2.googleapis.com")) return {ok:true,status:200,text:async()=>JSON.stringify({access_token:"tok"})};
      return {ok:false,status:403,text:async()=>JSON.stringify({error:{message:"The caller does not have permission"}})};
    }
  }),
  error => error.code === "GOOGLE_SHEETS_PERMISSION_DENIED" && /Compartilhe/.test(error.message) && !error.message.includes("The caller")
);

console.log("PASS: aba do dia encontrada nos formatos 'DD/MM X' (janta) e 'DD/MM' (almoço); envio e teste de conexão verificados.");

