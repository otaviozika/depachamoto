// Regressão: o botão "Confirmar entrega" (iFood) só dá baixa quando o iFood
// responde EXPLICITAMENTE que o código é válido (documentação: 200 {"valid": true}).
// Antes, qualquer resposta de sucesso sem "valid"/"success" booleano (corpo vazio,
// 202 {"status":"ACCEPTED"}, "valid":"false" como texto) confirmava a entrega
// mesmo com código errado. Validado de ponta a ponta (app real + iFood simulado,
// 21 cenários) no PR que criou este teste.
import fs from "node:fs";
import assert from "node:assert/strict";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf('app.post("/api/courier/ifood/orders/:orderId/verify-delivery"');
assert.ok(start > 0, "rota de confirmação iFood não encontrada");
const route = server.slice(start, server.indexOf("\n}));", start));

const iCall = route.indexOf("/verifyDeliveryCode`");
const iFalse = route.indexOf("if (explicitValid === false)");
const iStrict = route.indexOf("if (explicitValid !== true)");
const iVerified = route.indexOf("SET status='VERIFIED'");
const strictBlock = route.slice(iStrict, iVerified);

const checks = {
  callsIfood: iCall > 0,
  verdictOnlyFromBooleans: route.includes('typeof body?.valid === "boolean" ? body.valid :') && route.includes('typeof body?.success === "boolean" ? body.success :'),
  rejectsExplicitFalse: iFalse > iCall,
  strictGuardExists: iStrict > iFalse,
  verifiedOnlyAfterStrictGuard: iVerified > iStrict && route.indexOf("SET status='VERIFIED'", iVerified + 1) === -1,
  strictGuardDoesNotConfirm: strictBlock.includes("SET status='FAILED'") && strictBlock.includes("return res.status(503)") && strictBlock.includes('"IFOOD_VERIFY_UNCONFIRMED"'),
  strictGuardIsAudited: strictBlock.includes('"IFOOD_DELIVERY_CODE_UNCONFIRMED_RESPONSE"'),
  wrongCodeHttpErrorsStillInvalid: route.includes("const userCodeError = status === 400 || status === 422;"),
  formatCheckedBeforeIfood: route.indexOf("validDeliveryCode(deliveryCode)") > 0 && route.indexOf("validDeliveryCode(deliveryCode)") < iCall,
  onlyAssignedCourier: route.includes("AND d.courier_id=$2"),
  singleFlightClaim: route.includes("status IN ('PENDING','FAILED')") && route.includes("SET status='PROCESSING'")
};
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}`);
console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
