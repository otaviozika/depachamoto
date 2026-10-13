// Last prestart gate: legacy transforms must not reintroduce executable
// event attributes in the served HTML or client templates.
import fs from "node:fs";
import { appContentSecurityPolicy } from "../lib/ui-security.js";

const publicDir = new URL("../public/", import.meta.url);
const indexPath = new URL("index.html", publicDir);
const html = fs.readFileSync(indexPath, "utf8");
const versioned = html.replace(/src="\/(password-recovery|ui-actions)\.js(?:\?[^"\s]*)?"/g,
  'src="/$1.js?v=security-actions-session-v1"');
if (versioned !== html) fs.writeFileSync(indexPath, versioned);
appContentSecurityPolicy(publicDir.pathname);
const workerPath = new URL("service-worker.js", publicDir);
let worker = fs.readFileSync(workerPath, "utf8");
worker = worker.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-security-actions-session-v1";');
if (!/"\/ui-actions\.js(?:\?|\")/.test(worker)) worker = worker.replace('const STATIC = [', 'const STATIC = ["/ui-actions.js", ');
worker = worker.replace(/"\/(password-recovery|ui-actions)\.js(?:\?[^"\s]*)?"/g,
  '"/$1.js?v=security-actions-session-v1"');
if (!worker.includes('"/vendor/qrcode.min.js?v=qrcodejs-1.0.0"')) worker = worker.replace('const STATIC = [', 'const STATIC = ["/vendor/qrcode.min.js?v=qrcodejs-1.0.0", ');
fs.writeFileSync(workerPath, worker);
console.log("Security gate: no inline handlers; strict CSP and cache version ready.");
