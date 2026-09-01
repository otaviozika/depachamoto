import fs from "node:fs";
import assert from "node:assert/strict";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const manifest=fs.readFileSync(new URL("../public/manifest.webmanifest",import.meta.url),"utf8");
const sw=fs.readFileSync(new URL("../public/service-worker.js",import.meta.url),"utf8");
const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));

const checks={
  version:server.includes('const VERSION = "3.5.0";')&&pkg.version==="3.5.0",
  packageName:pkg.name==="despachefull",
  title:html.includes('<title>DespacheFull 3.5.0</title>'),
  loginBrand:html.includes('/brand-logo.png')&&html.includes('/brand-wordmark-light.png')&&html.includes('/brand-wordmark.png'),
  manifest:manifest.includes('"name": "DespacheFull"')&&manifest.includes('"short_name": "DespacheFull"'),
  serviceWorker:sw.includes('despachefull-v3.5.0-preparation-time')&&sw.includes('/app-icon-192.png'),
  publicOldBrandRemoved:!html.includes('DespachaMoto')&&!manifest.includes('DespachaMoto')&&!sw.includes('DespachaMoto'),
  serverOldVisibleBrandRemoved:!server.includes('DespachaMoto'),
  dbCompatibility:server.includes('CREATE TABLE IF NOT EXISTS dispatches')&&server.includes('CREATE TABLE IF NOT EXISTS ifood_orders'),
  sessionCompatibility:html.includes("sessionStorage.setItem('dm_session_notice','expired')")
};
for(const [name,ok] of Object.entries(checks))assert.ok(ok,`Falhou: ${name}`);
console.log(JSON.stringify({result:"PASS",version:"3.5.0",brand:"DespacheFull",checks},null,2));
