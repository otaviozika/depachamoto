import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const indexPath = path.join(root, 'public', 'index.html');
const swPath = path.join(root, 'public', 'service-worker.js');
let html = fs.readFileSync(indexPath, 'utf8');

function replace(anchor, value, label) {
  if (!html.includes(anchor)) throw new Error(`Password recovery frontend: anchor not found: ${label}`);
  html = html.replace(anchor, value);
}

const eye = id => `<button type="button" class="password-toggle" data-password-target="${id}" aria-label="Mostrar senha" aria-pressed="false"><svg class="password-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><svg class="password-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.2A10.7 10.7 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-3 3.7"/><path d="M6.7 6.7C3.7 8.5 2 12 2 12s3.5 6 10 6a10.3 10.3 0 0 0 4.2-.9"/></svg></button>`;

if (!html.includes('id="passwordRecoveryModal"')) {
  const loginStylesheet = html.match(/<link rel="stylesheet" href="\/login-desktop\.css(?:\?[^\"]*)?">/)?.[0];
  if (!loginStylesheet) throw new Error('Password recovery frontend: login stylesheet not found');
  replace(loginStylesheet, `${loginStylesheet}\n<link rel="stylesheet" href="/password-recovery.css">`, 'stylesheet');
  replace('<div class="login-help-row">Esqueceu a senha? Procure o administrador.</div>', '<button type="button" class="login-help-row password-recovery-link" data-ui-click="a42504c846a1caf">Esqueci minha senha</button>', 'login link');
  replace(
    '<div class="admin-account-actions"><button class="btn outline" type="button" data-ui-click="a1d419bfecfac68">Alterar minha senha</button></div>',
    '<div class="admin-account-actions"><button class="btn outline" type="button" data-ui-click="a1d419bfecfac68">Alterar minha senha</button><button class="btn outline" type="button" data-ui-click="aa499b5e21d2f71">Recuperações de senha</button></div>',
    'admin account action'
  );

  const ui = `<!-- PASSWORD RECOVERY UI START -->
<div id="passwordRecoveryModal" class="modal password-recovery-modal"><div class="modal-box password-recovery-box">
  <div class="password-recovery-head"><div><h2>Recuperar acesso</h2><p>O administrador precisa autorizar a troca.</p></div><button type="button" class="btn outline" aria-label="Fechar" data-ui-click="a902ffdaba29c58">×</button></div>
  <div id="passwordRecoveryMsg"></div>
  <div id="passwordRecoveryRequestStep"><form id="passwordRecoveryRequestForm" class="form" data-ui-submit="a903d88b27a1bbf"><label>Usuário<input id="passwordRecoveryUsername" autocomplete="username" required placeholder="Seu usuário"></label><button class="btn primary" type="submit">Solicitar recuperação</button></form><button class="password-recovery-have-code" type="button" data-ui-click="a7adc174094f2ef">Já tenho o código</button></div>
  <div id="passwordRecoveryResetStep" class="hidden"><form id="passwordRecoveryResetForm" class="form" data-ui-submit="a8b8c38b7e99781"><label>Usuário<input id="passwordRecoveryResetUsername" autocomplete="username" required placeholder="Seu usuário"></label><label>Código de recuperação<input id="passwordRecoveryCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required placeholder="000000"></label><label>Nova senha<span class="password-field"><input id="recoveryPass" type="password" minlength="8" autocomplete="new-password" required placeholder="Nova senha">${eye('recoveryPass')}</span></label><label>Confirmar nova senha<span class="password-field"><input id="recoveryPass2" type="password" minlength="8" autocomplete="new-password" required placeholder="Confirmar nova senha">${eye('recoveryPass2')}</span></label><button class="btn primary" type="submit">Alterar minha senha</button></form><button class="password-recovery-have-code" type="button" data-ui-click="a7ebdf6938b682a">Voltar</button></div>
</div></div>
<div id="passwordRecoveryAdminModal" class="modal password-recovery-admin-modal"><div class="modal-box password-recovery-admin-box"><div class="password-recovery-head"><div><h2>Recuperações de senha</h2><p>Aprove somente depois de confirmar a identidade do motoboy.</p></div><button type="button" class="btn outline" aria-label="Fechar" data-ui-click="ade6554cf68d06f">×</button></div><div id="passwordRecoveryAdminMsg"></div><div id="passwordRecoveryAdminList" class="password-recovery-list"><div class="empty">Carregando...</div></div></div></div>
<!-- PASSWORD RECOVERY UI END -->
`;
  replace('<script src="/socket.io/socket.io.js"></script>', ui + '\n<script src="/socket.io/socket.io.js"></script>', 'recovery modals');
  replace('</body>', '<script src="/password-recovery.js"></script>\n</body>', 'recovery script');
}

fs.writeFileSync(indexPath, html);

let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-password-recovery-v1";');
if (!/"\/password-recovery\.js(?:\?|\")/.test(sw)) sw = sw.replace('const STATIC = [', 'const STATIC = ["/password-recovery.js","/password-recovery.css",');
fs.writeFileSync(swPath, sw);
console.log('Frontend de recuperação de senha conectado.');
