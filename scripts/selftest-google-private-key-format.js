// Regressão: a chave da conta de serviço do Google é aceita nos formatos em que
// costuma ser colada no Render. Em 13/10/2026 a produção falhou com
// "error:1E08010C:DECODER routines::unsupported" ao testar a conexão.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { googleSheetsConfig, syncPaymentDayToGoogleSheets } from "../lib/google-sheets.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const email = "despachefull-planilhas@projeto.iam.gserviceaccount.com";
const escaped = JSON.stringify(privateKey).slice(1, -1);
const fullJson = JSON.stringify({ type: "service_account", client_email: email, private_key: privateKey });
const variants = {
  pem: privateKey,
  fromJsonFile: escaped,
  quoted: `"${escaped}"`,
  quotedWithComma: `"${escaped}",`,
  fullJson,
  newlinesAsSpaces: privateKey.replace(/\n/g, " "),
  windowsNewlines: privateKey.replace(/\n/g, "\r\n"),
  doubleEscaped: escaped.replace(/\\n/g, "\\\\n"),
  singleLine: privateKey.replace(/\n/g, "")
};
for (const [name, value] of Object.entries(variants)) {
  const cfg = googleSheetsConfig({ GOOGLE_SERVICE_ACCOUNT_EMAIL: email, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: value });
  const sig = crypto.sign("RSA-SHA256", Buffer.from("teste"), cfg.privateKey);
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from("teste"), publicKey, sig), `assinatura inválida no formato ${name}`);
}
// E-mail com aspas/vírgula e e-mail vindo do JSON inteiro
assert.equal(googleSheetsConfig({ GOOGLE_SERVICE_ACCOUNT_EMAIL: `"${email}",`, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey }).clientEmail, email);
assert.equal(googleSheetsConfig({ GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: fullJson }).clientEmail, email);

// Chave cortada: mensagem clara, sem chamar o Google, sem alterar planilha
let called = false;
await assert.rejects(
  syncPaymentDayToGoogleSheets({ date: "2026-10-13", shiftCode: "DINNER", rows: [], spreadsheetId: "X",
    env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: email, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey.slice(0, 400) },
    fetchFn: async () => { called = true; throw new Error("não deveria chamar a rede"); } }),
  err => err.code === "GOOGLE_PRIVATE_KEY_INVALID" && err.status === 503 && /BEGIN PRIVATE KEY/.test(err.message)
);
assert.equal(called, false);
console.log(`PASS: chave aceita em ${Object.keys(variants).length} formatos; e-mail normalizado; chave cortada gera mensagem clara.`);
