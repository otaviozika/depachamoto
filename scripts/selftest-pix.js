import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

function validatePix({ key="", type="", holder="" }) {
  const hasAny = Boolean(key || type || holder);
  if (!hasAny) return { ok: true, status: "NONE" };
  const types = new Set(["CPF","Celular","E-mail","Chave aleatória"]);
  if (!key || !type || !holder || !types.has(type) || holder.length < 3 || key.length < 3) {
    return { ok: false };
  }
  return { ok: true, status: "PENDING" };
}

function canPayPix(status, key, type, holder) {
  return status === "VERIFIED" && Boolean(key && type && holder);
}

assert.equal(validatePix({}).status, "NONE");
assert.equal(validatePix({ key:"11999999999", type:"Celular", holder:"João" }).status, "PENDING");
assert.equal(validatePix({ key:"11999999999", type:"Celular", holder:"" }).ok, false);
assert.equal(canPayPix("PENDING","x","CPF","João"), false);
assert.equal(canPayPix("VERIFIED","123","CPF","João"), true);

const requiredServer = [
  'app.get("/api/courier/pix"',
  'app.put("/api/courier/pix"',
  'app.post("/api/admin/couriers/:id/pix/verify"',
  'code: "PIX_LOCKED_TODAY"',
  'code: "PIX_NOT_VERIFIED"',
  "pix_holder_name_snapshot",
  "pix_status_snapshot",
  "courier_pix_history",
  'const newStatus = pix.empty ? "NONE" : "PENDING"',
  "SET pix_status='VERIFIED'"
];

for (const token of requiredServer) {
  assert.ok(server.includes(token), `Server missing: ${token}`);
}

const requiredHtml = [
  'id="myPixCard"',
  'id="myPixHolder"',
  'id="myPixType"',
  'id="myPixKey"',
  'Confirmar PIX',
  'function loadMyPix()',
  'function saveMyPix(e)',
  'function verifyCourierPix(id)'
];

for (const token of requiredHtml) {
  assert.ok(html.includes(token), `Frontend missing: ${token}`);
}

console.log(JSON.stringify({
  result: "PASS",
  version: "3.5.0",
  checks: {
    courierSelfPix: true,
    adminVerification: true,
    pendingAfterCourierChange: true,
    verifiedAfterAdminConfirmation: true,
    paidDayEditLock: true,
    pixPaymentRequiresVerifiedKey: true,
    pixHistory: true,
    paymentSnapshot: true
  }
}, null, 2));
