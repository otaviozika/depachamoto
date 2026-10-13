import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function appContentSecurityPolicy(publicDir, production = false) {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  for (const name of ["index.html", "password-recovery.js", "ui-actions.js"]) {
    const source = fs.readFileSync(path.join(publicDir, name), "utf8");
    if (/<[a-z][^<>]*\s+on[a-z]+\s*=/i.test(source)) throw new Error(`Unsafe inline event handler found in ${name}.`);
  }
  const hashes = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(script[1]) || !script[2].trim()) continue;
    hashes.push("'sha256-" + crypto.createHash("sha256").update(script[2]).digest("base64") + "'");
  }
  return { useDefaults: true, directives: {
    scriptSrc: ["'self'", ...hashes],
    scriptSrcAttr: ["'none'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"], fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'"], workerSrc: ["'self'", "blob:"],
    objectSrc: ["'none'"], frameAncestors: ["'self'"],
    upgradeInsecureRequests: production ? [] : null
  } };
}
