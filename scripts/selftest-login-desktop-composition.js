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

// Estrutura funcional existente deve continuar intacta.
assert.match(html, /<link rel="stylesheet" href="\/login-desktop\.css">/);
assert.match(html, /class="desktop-auth-divider">OU/);
assert.match(html, /class="login-bike-scene" src="\/login-bike-scene\.png"/);

// O redesign deve existir somente no desktop.
assert.match(css, /@media \(min-width:901px\)/);
assert.match(css, /--login-card-x:50%/);
assert.match(css, /--login-card-y:48%/);
assert.match(css, /--login-bike-left:/);
assert.match(css, /--login-bike-width:/);

// Fundo/parede não pode voltar a ser uma imagem inteira esticada.
assert.match(css, /#loginScreen \.login-photo\{[\s\S]*?radial-gradient/);
assert.doesNotMatch(css, /login-approved-reference|background-size:\s*100%\s+100%/);
assert.doesNotMatch(css, /background:url\('\/login-city-desk-scene-v2\.png'\)/);

// Card deve ser HTML/CSS centralizado e independente do cenário.
assert.match(css, /#loginScreen \.login-auth-panel\{[\s\S]*?left:var\(--login-card-x\)!important;[\s\S]*?top:var\(--login-card-y\)!important;[\s\S]*?translate\(-50%,-50%\)/);
assert.match(css, /#loginScreen \.auth-box\{[\s\S]*?backdrop-filter:blur\(14px\)/);
assert.match(css, /content:url\('\/icon\.svg'\)/);
assert.match(css, /content:"Acesse sua conta"/);
assert.match(css, /content:"Entre para continuar no DespacheFull"/);

// Moto fica como camada própria e a composição antiga fica desativada.
assert.match(css, /#loginScreen \.login-bike-scene\{[\s\S]*?left:var\(--login-bike-left\)!important;[\s\S]*?width:var\(--login-bike-width\)!important/);
assert.match(css, /#loginScreen \.dashboard-monitor,[\s\S]*?display:none!important/);

// Responsividade desktop explícita: laptop, ultrawide e 4K.
assert.match(css, /@media \(max-height:820px\)/);
assert.match(css, /@media \(min-aspect-ratio:21\/9\)/);
assert.match(css, /@media \(min-width:2560px\) and \(min-height:1200px\)/);

// PWA continua carregando o CSS e o ativo separado da moto.
assert.match(sw, /login-desktop\.css/);
assert.match(sw, /login-bike-scene\.png/);
assert.ok(imageSize('login-bike-scene.png')[0] >= 1500);

// IDs e wiring de autenticação não podem mudar com o redesign.
for (const id of ['tabLogin', 'tabRegister', 'loginForm', 'registerForm', 'loginUser', 'loginPass', 'regName', 'regUser', 'regPass', 'regPass2']) {
  assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} deve permanecer único`);
}
assert.match(html, /function setAuth\(mode\)/);
assert.match(html, /\$\('loginForm'\)\.onsubmit=login;/);
assert.match(html, /\$\('registerForm'\)\.onsubmit=register;/);

console.log(JSON.stringify({
  result: 'PASS',
  crispDesktopCard: true,
  bikeLayerSeparated: true,
  authIdsPreserved: true,
  mobileBreakpointPreserved: true
}));
