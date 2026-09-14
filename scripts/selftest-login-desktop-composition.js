import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/login-desktop.css', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const imageSize = (name) => {
  const image = fs.readFileSync(new URL(`../public/${name}`, import.meta.url));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
};

assert.match(html, /<link rel="stylesheet" href="\/login-desktop\.css">/);
assert.match(html, /class="dashboard-monitor"/);
assert.match(html, /class="dashboard-preview"/);
assert.equal((html.match(/class="dashboard-preview-metric"/g) || []).length, 6, 'O monitor deve mostrar os seis indicadores da referência');
assert.match(html, /Quem está na rua agora/);
assert.match(html, /Últimas saídas/);
assert.match(html, /class="desktop-auth-divider">OU/);
assert.match(html, /class="login-bike-scene" src="\/login-bike-scene\.png"/);
assert.match(css, /@media \(min-width:901px\)/);
assert.match(css, /background:url\('\/login-city-desk-scene\.png'\)/);
assert.match(css, /aspect-ratio:16\/9/);
assert.match(css, /width:min\(100vw,177\.777778svh\)/);
assert.doesNotMatch(css, /login-approved-reference|background-size:\s*100%\s+100%/);
assert.match(sw, /login-desktop\.css/);
assert.match(sw, /login-city-desk-scene\.png/);
assert.match(sw, /login-bike-scene\.png/);
assert.ok(imageSize('login-city-desk-scene.png')[0] >= 1500);
assert.ok(imageSize('login-bike-scene.png')[0] >= 1500);

for (const id of ['tabLogin', 'tabRegister', 'loginForm', 'registerForm', 'loginUser', 'loginPass', 'regName', 'regUser', 'regPass', 'regPass2']) {
  assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} deve permanecer único`);
}
assert.match(html, /function setAuth\(mode\)/);
assert.match(html, /\$\('loginForm'\)\.onsubmit=login;/);
assert.match(html, /\$\('registerForm'\)\.onsubmit=register;/);
console.log(JSON.stringify({ result: 'PASS', desktopLayers: true, authIdsPreserved: true, mobileBreakpointPreserved: true }));
