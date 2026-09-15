import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const indexPath = path.join(root, 'public', 'index.html');
const cssPath = path.join(root, 'public', 'login-desktop.css');
const swPath = path.join(root, 'public', 'service-worker.js');

const eyeButton = id => `<button type="button" class="password-toggle" data-password-target="${id}" aria-label="Mostrar senha" aria-pressed="false">
  <svg class="password-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
  <svg class="password-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.2A10.7 10.7 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-3 3.7"/><path d="M6.7 6.7C3.7 8.5 2 12 2 12s3.5 6 10 6a10.3 10.3 0 0 0 4.2-.9"/></svg>
</button>`;

const wrap = (input, id) => `<span class="password-field">${input}${eyeButton(id)}</span>`;

let html = fs.readFileSync(indexPath, 'utf8');

const replacements = [
  [
    '<label>Senha<input id="loginPass" type="password" autocomplete="current-password" required placeholder="Senha"></label>',
    `<label>Senha${wrap('<input id="loginPass" type="password" autocomplete="current-password" required placeholder="Senha">','loginPass')}</label>`
  ],
  [
    '<label>Senha<input id="regPass" type="password" minlength="8" required placeholder="Senha"></label>',
    `<label>Senha${wrap('<input id="regPass" type="password" minlength="8" required placeholder="Senha" autocomplete="new-password">','regPass')}</label>`
  ],
  [
    '<label>Confirmar senha<input id="regPass2" type="password" minlength="8" required placeholder="Confirmar senha"></label>',
    `<label>Confirmar senha${wrap('<input id="regPass2" type="password" minlength="8" required placeholder="Confirmar senha" autocomplete="new-password">','regPass2')}</label>`
  ],
  [
    '<label>Senha atual<input id="currentPassword" type="password" required></label>',
    `<label>Senha atual${wrap('<input id="currentPassword" type="password" autocomplete="current-password" required>','currentPassword')}</label>`
  ],
  [
    '<label>Nova senha<input id="newPassword" type="password" minlength="8" required></label>',
    `<label>Nova senha${wrap('<input id="newPassword" type="password" minlength="8" autocomplete="new-password" required>','newPassword')}</label>`
  ],
  [
    '<label>Confirmar nova senha<input id="newPassword2" type="password" minlength="8" required></label>',
    `<label>Confirmar nova senha${wrap('<input id="newPassword2" type="password" minlength="8" autocomplete="new-password" required>','newPassword2')}</label>`
  ]
];

for (const [from, to] of replacements) {
  if (html.includes(from)) html = html.replace(from, to);
}

const JS_START = '/* PASSWORD TOGGLE START */';
const JS_END = '/* PASSWORD TOGGLE END */';
const oldJsStart = html.indexOf(JS_START);
if (oldJsStart >= 0) {
  const oldJsEnd = html.indexOf(JS_END, oldJsStart);
  if (oldJsEnd >= 0) html = html.slice(0, oldJsStart) + html.slice(oldJsEnd + JS_END.length);
}

const toggleJs = `
${JS_START}
function setPasswordVisibility(button, show){
  const input=document.getElementById(button?.dataset?.passwordTarget||'');
  if(!input)return;
  input.type=show?'text':'password';
  button.setAttribute('aria-pressed',String(show));
  button.setAttribute('aria-label',show?'Ocultar senha':'Mostrar senha');
}
function hideAllPasswords(){
  document.querySelectorAll('[data-password-target]').forEach(button=>setPasswordVisibility(button,false));
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-password-target]');
  if(button){
    event.preventDefault();
    const input=document.getElementById(button.dataset.passwordTarget);
    if(!input)return;
    const show=input.type==='password';
    setPasswordVisibility(button,show);
    input.focus({preventScroll:true});
    try{const end=input.value.length;input.setSelectionRange(end,end)}catch{}
    return;
  }
  if(event.target.closest('#tabLogin,#tabRegister')) hideAllPasswords();
});
${JS_END}
`;

const anchor = 'function redirectExpiredSession(){';
if (html.includes(anchor)) html = html.replace(anchor, toggleJs + '\n' + anchor);

fs.writeFileSync(indexPath, html);

const CSS_START = '/* PASSWORD TOGGLE STYLES START */';
const CSS_END = '/* PASSWORD TOGGLE STYLES END */';
let css = fs.readFileSync(cssPath, 'utf8');
const oldCssStart = css.indexOf(CSS_START);
if (oldCssStart >= 0) {
  const oldCssEnd = css.indexOf(CSS_END, oldCssStart);
  if (oldCssEnd >= 0) css = css.slice(0, oldCssStart) + css.slice(oldCssEnd + CSS_END.length);
}

const toggleCss = `
${CSS_START}
.form .password-field{
  position:relative;
  display:block;
  width:100%;
  margin-top:6px;
}
.form .password-field>input{
  margin-top:0!important;
  padding-right:58px!important;
}
.form .password-toggle{
  position:absolute;
  top:50%;
  right:8px;
  transform:translateY(-50%);
  z-index:12;
  display:flex;
  align-items:center;
  justify-content:center;
  width:42px;
  height:42px;
  min-width:42px;
  padding:0;
  border:0;
  border-radius:12px;
  background:transparent;
  color:#aeb4bc;
  cursor:pointer;
  transition:color .15s ease,background .15s ease,transform .1s ease;
  -webkit-tap-highlight-color:transparent;
  touch-action:manipulation;
}
.form .password-toggle svg{
  width:22px;
  height:22px;
  fill:none;
  stroke:currentColor;
  stroke-width:1.8;
  stroke-linecap:round;
  stroke-linejoin:round;
  pointer-events:none;
}
.form .password-toggle:hover{
  color:#fff;
  background:rgba(255,255,255,.06);
}
.form .password-toggle:active{
  transform:translateY(-50%) scale(.92);
}
.form .password-toggle:focus-visible{
  outline:2px solid #ef334a!important;
  outline-offset:2px!important;
}
.form .password-eye-closed{display:none}
.form .password-toggle[aria-pressed="true"]{color:#ef334a}
.form .password-toggle[aria-pressed="true"] .password-eye-open{display:none}
.form .password-toggle[aria-pressed="true"] .password-eye-closed{display:block}

/* Keep the login lock glyph stable even after type=password becomes type=text. */
#loginScreen .form label:has(.password-field)::before{
  left:19px!important;
  top:14px!important;
  width:11px!important;
  height:14px!important;
  border:1.6px solid #e7e9ec!important;
  border-radius:8px 8px 0 0!important;
  background:transparent!important;
}
#loginScreen .form label:has(.password-field)::after{
  left:15px!important;
  top:25px!important;
  width:19px!important;
  height:17px!important;
  border:1.6px solid #e7e9ec!important;
  border-radius:3px!important;
  background:#111519!important;
}

/* Public auth screens have no visible label gap; modal forms keep their normal spacing. */
#loginScreen .form .password-field{margin-top:0}

@media (max-width:900px){
  #loginScreen .form .password-toggle{
    right:8px;
    width:42px;
    height:42px;
  }
}
${CSS_END}
`;

css = css.trimEnd() + '\n\n' + toggleCss + '\n';
fs.writeFileSync(cssPath, css);

let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.6.1-password-toggle-v1";');
fs.writeFileSync(swPath, sw);

console.log('Botoes de mostrar/ocultar senha padronizados.');
