from pathlib import Path

INDEX = Path("public/index.html")
SW = Path("public/service-worker.js")

text = INDEX.read_text(encoding="utf-8")
marker = "/* desktop login premium — 2026-09-14 */"

css = r'''
/* desktop login premium — 2026-09-14 */
.login-showcase,.auth-desktop-brand,.login-title-desktop,.desktop-auth-note,.login-help-row{display:none}
.login-title-mobile{display:inline}

@media (min-width:901px){
  #loginScreen.login{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(420px,.75fr);place-items:stretch;padding:0;background:#070a0e;color:#f4f6f8;overflow:hidden}
  #loginScreen .login-showcase{position:relative;display:flex;min-width:0;overflow:hidden;padding:42px clamp(34px,4vw,64px) 34px;flex-direction:column;justify-content:space-between;isolation:isolate;background:radial-gradient(circle at 22% 20%,rgba(122,135,151,.13),transparent 36%),linear-gradient(145deg,#0b0f14 0%,#10161d 48%,#080b0f 100%);border-right:1px solid #20262e}
  #loginScreen .login-showcase:before{content:"";position:absolute;inset:0;z-index:-3;background:linear-gradient(90deg,rgba(4,7,10,.06),rgba(4,7,10,.42) 58%,rgba(4,7,10,.82)),linear-gradient(0deg,rgba(4,7,10,.86),transparent 54%);pointer-events:none}
  #loginScreen .login-photo{position:absolute;inset:0;z-index:-4;background-image:url('/login-motorcycle.jpg');background-size:cover;background-position:center 58%;opacity:.42;filter:saturate(.82) contrast(1.08) brightness(.7);transform:scale(1.025)}
  #loginScreen .login-showcase-top{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:20px}
  #loginScreen .login-showcase-brand{width:205px;max-width:30vw;height:auto;display:block;object-fit:contain}
  #loginScreen .login-showcase-status{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(8,12,16,.62);color:#bbc2cb;font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;backdrop-filter:blur(10px)}
  #loginScreen .login-showcase-status:before{content:"";width:6px;height:6px;border-radius:50%;background:#48c77c;box-shadow:0 0 0 3px rgba(72,199,124,.1)}
  #loginScreen .login-showcase-copy{position:relative;z-index:2;max-width:650px;margin-top:auto;margin-bottom:26px}
  #loginScreen .login-showcase-kicker{margin:0 0 10px;color:#d7dbe0;font-size:11px;font-weight:800;letter-spacing:.17em;text-transform:uppercase}
  #loginScreen .login-showcase-copy h1{max-width:620px;margin:0;color:#f6f7f9;font-size:clamp(34px,3.6vw,58px);line-height:.98;letter-spacing:-.048em;font-weight:790}
  #loginScreen .login-showcase-copy p{max-width:560px;margin:16px 0 0;color:#a9b1bb;font-size:14px;line-height:1.55}
  #loginScreen .dashboard-preview{position:relative;z-index:3;width:min(760px,94%);margin-top:22px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#090d12;box-shadow:0 28px 70px rgba(0,0,0,.43);overflow:hidden;transform:perspective(1400px) rotateY(-3deg) rotateX(1deg);transform-origin:left bottom}
  #loginScreen .dashboard-preview-top{height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#0c1117;border-bottom:1px solid #252c34}
  #loginScreen .dashboard-preview-dots{display:flex;gap:5px}
  #loginScreen .dashboard-preview-dots i{width:6px;height:6px;border-radius:50%;background:#3c444f}
  #loginScreen .dashboard-preview-live{display:flex;align-items:center;gap:6px;color:#8f99a6;font-size:8px;font-weight:800;letter-spacing:.08em}
  #loginScreen .dashboard-preview-live:before{content:"";width:5px;height:5px;border-radius:50%;background:#c91529}
  #loginScreen .dashboard-preview-body{display:grid;grid-template-columns:120px 1fr;min-height:238px}
  #loginScreen .dashboard-preview-side{padding:15px 10px;background:#080c10;border-right:1px solid #20262e}
  #loginScreen .dashboard-preview-side b{display:block;margin:0 8px 12px;color:#f0f2f4;font-size:10px}
  #loginScreen .dashboard-preview-nav{display:grid;gap:6px}
  #loginScreen .dashboard-preview-nav span{height:26px;display:flex;align-items:center;padding:0 8px;border-radius:6px;color:#68727f;font-size:8px}
  #loginScreen .dashboard-preview-nav span:first-child{background:#151b22;color:#d7dbe0}
  #loginScreen .dashboard-preview-main{min-width:0;padding:14px}
  #loginScreen .dashboard-preview-title{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:11px}
  #loginScreen .dashboard-preview-title b{color:#e9ecef;font-size:12px}
  #loginScreen .dashboard-preview-title small{color:#697482;font-size:7px}
  #loginScreen .dashboard-preview-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
  #loginScreen .dashboard-preview-metric{padding:9px;border:1px solid #252c34;border-radius:7px;background:#0d1218}
  #loginScreen .dashboard-preview-metric span{display:block;color:#7f8996;font-size:6.5px;white-space:nowrap}
  #loginScreen .dashboard-preview-metric b{display:block;margin-top:6px;color:#eef0f2;font-size:17px}
  #loginScreen .dashboard-preview-grid{display:grid;grid-template-columns:1.4fr .8fr;gap:8px;margin-top:9px}
  #loginScreen .dashboard-preview-panel{height:106px;padding:10px;border:1px solid #252c34;border-radius:7px;background:#0c1116}
  #loginScreen .dashboard-preview-panel strong{display:block;color:#bfc5cc;font-size:7px;margin-bottom:8px}
  #loginScreen .dashboard-preview-row{height:14px;display:grid;grid-template-columns:1.1fr .7fr .55fr;align-items:center;border-top:1px solid #1f252d;color:#68727e;font-size:6px}
  #loginScreen .dashboard-preview-row em{justify-self:end;color:#9ba4ae;font-style:normal}
  #loginScreen .dashboard-preview-road{display:grid;place-items:center;text-align:center;color:#5f6976;font-size:7px}
  #loginScreen .dashboard-preview-road:before{content:"";display:block;width:27px;height:27px;margin:0 auto 5px;border:1px solid #313945;border-radius:50%;background:radial-gradient(circle at center,#151b22 0 38%,transparent 40%)}
  #loginScreen .login-photo-credit{position:absolute;left:18px;bottom:10px;z-index:4;color:rgba(190,197,205,.46);font-size:8px;text-decoration:none}
  #loginScreen .login-photo-credit:hover{color:#cfd4da}
  #loginScreen .login-auth-panel{min-width:0;display:flex;align-items:center;justify-content:center;padding:clamp(34px,4vw,68px);background:#0a0e13}
  #loginScreen .auth-box{width:min(430px,100%);margin:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;color:#f4f6f8}
  #loginScreen .brand-logo-login{display:none}
  #loginScreen .auth-desktop-brand{display:block;margin-bottom:38px}
  #loginScreen .auth-desktop-brand img{display:block;width:205px;max-width:100%;height:auto}
  #loginScreen .auth-desktop-brand .creator-signature{margin:7px 0 0 2px;text-align:left;color:#586270;font-size:8px;letter-spacing:1.7px}
  #loginScreen .auth-box>h2{margin:0;color:#f5f6f7;font-size:29px;line-height:1.12;letter-spacing:-.035em}
  #loginScreen .login-title-mobile{display:none}
  #loginScreen .login-title-desktop{display:inline}
  #loginScreen .auth-box>p.muted{margin:9px 0 0;color:#77828f;font-size:12px;line-height:1.5}
  #loginScreen .tabs{margin:24px 0 19px;padding:3px;border:1px solid #252c34;border-radius:9px;background:#080c10}
  #loginScreen .tabs button{min-height:38px;color:#717c89;border-radius:7px;font-size:11px;font-weight:700}
  #loginScreen .tabs button.on{background:#171d24;color:#f0f2f4;box-shadow:none}
  #loginScreen #registrationNotice{min-height:0;color:#7e8996;margin-bottom:4px}
  #loginScreen .msg{margin:9px 0;padding:10px 11px;border-radius:8px;font-size:11px}
  #loginScreen .msg.err{background:#291116;color:#f1a7af;border:1px solid #52202a}
  #loginScreen .msg.ok{background:#102219;color:#93ddb1;border:1px solid #21452f}
  #loginScreen .form{gap:14px}
  #loginScreen .form label{color:#aeb6bf;font-size:10px;font-weight:700;letter-spacing:.015em}
  #loginScreen .form input,#loginScreen .form select{min-height:46px;margin-top:7px;padding:0 13px;border:1px solid #2b333d;border-radius:9px;outline:none;background:#080c10;color:#f2f4f6;box-shadow:inset 0 1px 0 rgba(255,255,255,.02)}
  #loginScreen .form input::placeholder{color:#4f5966}
  #loginScreen .form input:focus,#loginScreen .form select:focus{border-color:#6a747f;box-shadow:0 0 0 3px rgba(117,128,141,.09)}
  #loginScreen .btn.primary{min-height:48px;width:100%;margin-top:3px;border:1px solid #dc1c32;border-radius:9px;background:#c91529;color:#fff;box-shadow:0 10px 26px rgba(201,21,41,.14);font-size:12px;font-weight:800}
  #loginScreen .btn.primary:hover{background:#d7182f}
  #loginScreen .form p.small.muted{color:#65707d;line-height:1.45}
  #loginScreen .login-help-row{display:flex;justify-content:flex-end;margin:-3px 0 0;color:#646f7c;font-size:9px}
  #loginScreen .desktop-auth-note{display:flex;align-items:center;gap:7px;margin-top:21px;color:#5f6975;font-size:9px}
  #loginScreen .desktop-auth-note:before{content:"";width:5px;height:5px;border-radius:50%;background:#77828e}
  #loginScreen .auth-box>.creator-signature{display:none}
}

@media (min-width:901px) and (max-width:1180px){
  #loginScreen.login{grid-template-columns:minmax(0,1.25fr) minmax(400px,.8fr)}
  #loginScreen .login-showcase{padding-left:34px;padding-right:34px}
  #loginScreen .dashboard-preview-body{grid-template-columns:96px 1fr}
  #loginScreen .dashboard-preview-metrics{grid-template-columns:repeat(2,1fr)}
  #loginScreen .dashboard-preview-grid{grid-template-columns:1fr}
  #loginScreen .dashboard-preview-panel:last-child{display:none}
  #loginScreen .dashboard-preview{width:100%}
  #loginScreen .login-showcase-copy h1{font-size:38px}
}
'''

if marker not in text:
    text = text.replace("</style>", css + "\n</style>", 1)

start_token = '<div id="loginScreen" class="login">'
end_token = '\n\n<div id="adminApp" class="app hidden">'
start = text.find(start_token)
end = text.find(end_token, start)
if start < 0 or end < 0:
    raise SystemExit("Bloco de login atual não encontrado.")

login = r'''<div id="loginScreen" class="login">
  <section class="login-showcase" aria-hidden="true">
    <div class="login-photo"></div>
    <div class="login-showcase-top">
      <img class="login-showcase-brand" src="/brand-wordmark-light.png" alt="">
      <span class="login-showcase-status">Operação conectada</span>
    </div>
    <div class="login-showcase-copy">
      <div class="login-showcase-kicker">Controle operacional em tempo real</div>
      <h1>Despacho rápido.<br>Operação sob controle.</h1>
      <p>Centralize motoboys, pedidos, tempos de rota e integrações em uma única operação.</p>
      <div class="dashboard-preview">
        <div class="dashboard-preview-top"><div class="dashboard-preview-dots"><i></i><i></i><i></i></div><span class="dashboard-preview-live">AO VIVO</span></div>
        <div class="dashboard-preview-body">
          <div class="dashboard-preview-side"><b>DespacheFull</b><div class="dashboard-preview-nav"><span>Dashboard</span><span>Operação</span><span>iFood</span><span>Gestão</span><span>Sistema</span></div></div>
          <div class="dashboard-preview-main">
            <div class="dashboard-preview-title"><b>Central de despacho</b><small>Atualização em tempo real</small></div>
            <div class="dashboard-preview-metrics">
              <div class="dashboard-preview-metric"><span>Motoboys ativos</span><b>18</b></div>
              <div class="dashboard-preview-metric"><span>Fora da loja</span><b>11</b></div>
              <div class="dashboard-preview-metric"><span>Disponíveis</span><b>7</b></div>
              <div class="dashboard-preview-metric"><span>Pedidos hoje</span><b>286</b></div>
            </div>
            <div class="dashboard-preview-grid">
              <div class="dashboard-preview-panel"><strong>Quem está na rua agora</strong><div class="dashboard-preview-row"><span>Motoboy 01</span><span>#5821 • #5828</span><em>22 min</em></div><div class="dashboard-preview-row"><span>Motoboy 02</span><span>#5830</span><em>17 min</em></div><div class="dashboard-preview-row"><span>Motoboy 03</span><span>#5834 • #5837</span><em>13 min</em></div><div class="dashboard-preview-row"><span>Motoboy 04</span><span>#5841</span><em>08 min</em></div></div>
              <div class="dashboard-preview-panel dashboard-preview-road">Operação monitorada em tempo real</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <a class="login-photo-credit" href="https://commons.wikimedia.org/wiki/File:Ducati_Panigale_V4_R_(3).jpg" target="_blank" rel="noopener">Foto: Cjp24 / Wikimedia Commons — CC BY-SA 4.0</a>
  </section>

  <section class="login-auth-panel">
    <div class="auth-box">
      <img class="brand-logo-login" src="/brand-logo.png" alt="DespacheFull — Inteligente, Seguro, Eficiente">
      <div class="creator-signature">Create by. Hernandes</div>
      <div class="auth-desktop-brand"><img src="/brand-wordmark-light.png" alt="DespacheFull"><div class="creator-signature">Create by. Hernandes</div></div>
      <h2><span class="login-title-mobile">Bem-vindo</span><span class="login-title-desktop">Entrar no DespacheFull</span></h2>
      <p class="muted">Sistema online de despacho de motoboys.</p>
      <div class="tabs"><button id="tabLogin" class="on" type="button" onclick="setAuth('login')">Entrar</button><button id="tabRegister" type="button" onclick="setAuth('register')">Criar conta</button></div>
      <div id="registrationNotice" class="small muted"></div>
      <div id="authMsg"></div>
      <form id="loginForm" class="form">
        <label>Usuário<input id="loginUser" autocomplete="username" required></label>
        <label>Senha<input id="loginPass" type="password" autocomplete="current-password" required></label>
        <div class="login-help-row">Esqueceu a senha? Procure o administrador.</div>
        <button class="btn primary">Entrar</button>
      </form>
      <form id="registerForm" class="form hidden">
        <label>Nome completo<input id="regName" required></label>
        <label>Usuário<input id="regUser" required></label>
        <label>Senha<input id="regPass" type="password" minlength="8" required></label>
        <label>Confirmar senha<input id="regPass2" type="password" minlength="8" required></label>
        <button id="registerSubmit" class="btn primary">Solicitar cadastro</button>
        <p class="small muted">A senha precisa ter pelo menos 8 caracteres. O administrador aprova o acesso.</p>
      </form>
      <div class="desktop-auth-note">Acesso de administrador e motoboy</div>
    </div>
  </section>
</div>'''

text = text[:start] + login + text[end:]
INDEX.write_text(text, encoding="utf-8")

sw = SW.read_text(encoding="utf-8")
sw = sw.replace("despachefull-v3.6.1-delivery-details", "despachefull-v3.6.1-login-desktop-premium")
if '"/login-motorcycle.jpg"' not in sw:
    sw = sw.replace('"/waze-icon.png"]', '"/waze-icon.png", "/login-motorcycle.jpg"]')
SW.write_text(sw, encoding="utf-8")

required = [
    'id="loginScreen"','id="loginForm"','id="loginUser"','id="loginPass"','id="registerForm"',
    'id="regName"','id="regUser"','id="regPass"','id="regPass2"','id="registerSubmit"',
    'id="tabLogin"','id="tabRegister"', marker, '@media (min-width:901px)', 'dashboard-preview'
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Itens ausentes: " + ", ".join(missing))

for element_id in ("loginScreen","loginForm","loginUser","loginPass","registerForm","tabLogin","tabRegister"):
    count = text.count(f'id="{element_id}"')
    if count != 1:
        raise SystemExit(f"ID {element_id} aparece {count} vezes")

Path("public/login-media-attribution.txt").write_text(
    "Ducati Panigale V4 R (3).jpg — Cjp24 — Wikimedia Commons — CC BY-SA 4.0\n"
    "Source: https://commons.wikimedia.org/wiki/File:Ducati_Panigale_V4_R_(3).jpg\n"
    "License: https://creativecommons.org/licenses/by-sa/4.0/\n",
    encoding="utf-8",
)

print("Desktop login premium aplicado; contrato de autenticação preservado.")
