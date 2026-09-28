import fs from "node:fs";
const path = new URL("../public/service-worker.js", import.meta.url);
const current = fs.readFileSync(path, "utf8");
const next = current.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-professional-login-v1";');
if (next === current && !current.includes('const CACHE = "despachefull-v3.7.0-professional-login-v1";')) throw new Error("PWA cache version not found");
if (!next.includes('approved-delivery-card-v1') || !next.includes('url.pathname.startsWith("/api/")')) throw new Error("PWA cache safety contract failed");
if (next !== current) fs.writeFileSync(path, next);
console.log("Bandwidth cache version active");

