from pathlib import Path
import re

index = Path('public/index.html')
html = index.read_text(encoding='utf-8')

marker = '/* desktop login approved reference — 2026-09-14 */'
if marker in html:
    start = html.index(marker)
    end = html.index('</style>', start)
    html = html[:start] + html[end:]

css = r'''

/* desktop login approved reference — 2026-09-14 */
@media (min-width:901px){
  #loginScreen.login{
    position:relative!important;
    min-height:100vh!important;
    width:100vw!important;
    display:block!important;
    padding:0!important;
    overflow:hidden!important;
    color:#f8fafc!important;
    background:#080b0f url('/login-approved-reference.jpg') center center/100% 100% no-repeat!important;
  }
  #loginScreen .login-showcase{
    position:absolute!important;
    inset:0!important;
    display:block!important;
    min-width:0!important;
    padding:0!important;
    border:0!important;
    background:transparent!important;
    pointer-events:none!important;
    z-index:0!important;
  }
  #loginScreen .login-showcase:before,
  #loginScreen .login-photo,
  #loginScreen .login-showcase-top,
  #loginScreen .login-showcase-copy,
  #loginScreen .dashboard-preview,
  #loginScreen .login-photo-credit{display:none!important}

  #loginScreen .login-auth-panel{
    position:absolute!important;
    z-index:5!important;
    top:11.4vh!important;
    right:1.45vw!important;
    width:21.45vw!important;
    min-width:350px!important;
    height:69.4vh!important;
    min-height:560px!important;
    display:flex!important;
    align-items:center!important;
    justify-content:center!important;
    padding:clamp(26px,2.15vw,48px)!important;
    border:1px solid rgba(255,255,255,.23)!important;
    border-radius:18px!important;
    background:linear-gradient(180deg,rgba(10,15,22,.985),rgba(8,12,18,.99))!important;
    box-shadow:0 28px 90px rgba(0,0,0,.56),inset 0 1px 0 rgba(255,255,255,.04)!important;
    backdrop-filter:blur(12px)!important;
  }
  #loginScreen .auth-box{
    width:100%!important;
    max-width:none!important;
    margin:0!important;
    padding:0!important;
    border:0!important;
    border-radius:0!important;
    background:transparent!important;
    box-shadow:none!important;
    color:#f8fafc!important;
    display:flex!important;
    flex-direction:column!important;
  }
  #loginScreen .brand-logo-login,
  #loginScreen .auth-desktop-brand,
  #loginScreen .auth-box>.creator-signature{display:none!important}

  #loginScreen .auth-box>h2{
    order:1!important;
    margin:0!important;
    color:#fff!important;
    font-size:clamp(26px,1.75vw,39px)!important;
    line-height:1.02!important;
    letter-spacing:-.035em!important;
    font-weight:850!important;
  }
  #loginScreen .login-title-mobile{display:none!important}
  #loginScreen .login-title-desktop{display:inline!important}
  #loginScreen .auth-box>p.muted{
    order:2!important;
    margin:10px 0 25px!important;
    color:#aab2bd!important;
    font-size:clamp(11px,.72vw,14px)!important;
    line-height:1.45!important;
  }
  #loginScreen #registrationNotice{order:3!important;margin:0 0 6px!important;color:#8c96a3!important;font-size:10px!important}
  #loginScreen #authMsg{order:4!important}
  #loginScreen #loginForm,#loginScreen #registerForm{order:5!important}

  #loginScreen .form{gap:13px!important}
  #loginScreen .form label{font-size:0!important;color:transparent!important;font-weight:400!important}
  #loginScreen .form input,#loginScreen .form select{
    width:100%!important;
    min-height:52px!important;
    margin:0!important;
    padding:0 16px!important;
    border:1px solid #36404c!important;
    border-radius:9px!important;
    outline:none!important;
    background:rgba(8,13,19,.92)!important;
    color:#f6f7f9!important;
    font-size:13px!important;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.025)!important;
  }
  #loginScreen .form input::placeholder{color:#707a86!important;opacity:1!important}
  #loginScreen .form input:focus,#loginScreen .form select:focus{
    border-color:#7b8795!important;
    box-shadow:0 0 0 3px rgba(255,255,255,.05)!important;
  }
  #loginScreen .login-help-row{
    display:flex!important;
    justify-content:flex-end!important;
    margin:-4px 2px 0!important;
    color:#df2438!important;
    font-size:10px!important;
  }
  #loginScreen .btn.primary{
    width:100%!important;
    min-height:52px!important;
    margin-top:7px!important;
    border:1px solid #ff2941!important;
    border-radius:9px!important;
    background:linear-gradient(180deg,#f51d39,#e41431)!important;
    color:#fff!important;
    box-shadow:0 12px 30px rgba(218,20,45,.22)!important;
    font-size:13px!important;
    font-weight:850!important;
    letter-spacing:.025em!important;
    text-transform:uppercase!important;
  }
  #loginScreen .btn.primary:hover{background:linear-gradient(180deg,#ff2943,#ed1736)!important}
  #loginScreen .form p.small.muted{margin:1px 0!important;color:#737d89!important;font-size:9px!important;line-height:1.4!important}

  #loginScreen .tabs{
    order:6!important;
    position:relative!important;
    display:block!important;
    margin:23px 0 0!important;
    padding:27px 0 0!important;
    border:0!important;
    border-top:1px solid #2b333d!important;
    border-radius:0!important;
    background:transparent!important;
  }
  #loginScreen .tabs:before{
    content:'OU'!important;
    position:absolute!important;
    top:-7px!important;
    left:50%!important;
    transform:translateX(-50%)!important;
    padding:0 12px!important;
    background:#090e14!important;
    color:#69737f!important;
    font-size:9px!important;
    letter-spacing:.18em!important;
  }
  #loginScreen .tabs button{
    width:100%!important;
    min-height:50px!important;
    border:1px solid #56616e!important;
    border-radius:9px!important;
    background:transparent!important;
    color:#f4f6f8!important;
    box-shadow:none!important;
    font-size:12px!important;
    font-weight:800!important;
  }
  #loginScreen #tabLogin.on,#loginScreen #tabRegister.on{display:none!important}
  #loginScreen #tabRegister:not(.on),#loginScreen #tabLogin:not(.on){display:block!important}
  #loginScreen .desktop-auth-note{
    order:7!important;
    display:block!important;
    margin:20px 0 0!important;
    color:#5f6975!important;
    text-align:center!important;
    font-size:8px!important;
    letter-spacing:.18em!important;
    text-transform:uppercase!important;
  }
  #loginScreen .desktop-auth-note:before{display:none!important}
}

@media (min-width:901px) and (max-width:1250px){
  #loginScreen.login{background-size:cover!important;background-position:center!important}
  #loginScreen .login-auth-panel{
    top:7vh!important;
    right:3vw!important;
    width:36vw!important;
    min-width:360px!important;
    height:86vh!important;
    min-height:600px!important;
  }
}
'''

html = html.replace('</style>', css + '\n</style>', 1)

# Mantém os mesmos IDs/handlers e só melhora o texto visual dos campos.
def add_placeholder(text, element_id, placeholder):
    pattern = rf'(<input(?=[^>]*\bid="{re.escape(element_id)}")[^>]*)(>)'
    def repl(m):
        tag = m.group(1)
        if 'placeholder=' not in tag:
            tag += f' placeholder="{placeholder}"'
        return tag + m.group(2)
    return re.sub(pattern, repl, text, count=1)

html = add_placeholder(html, 'loginUser', 'E-mail ou usuário')
html = add_placeholder(html, 'loginPass', 'Senha')
html = add_placeholder(html, 'regName', 'Nome completo')
html = add_placeholder(html, 'regUser', 'Usuário')
html = add_placeholder(html, 'regPass', 'Senha')
html = add_placeholder(html, 'regPass2', 'Confirmar senha')
html = html.replace('Sistema online de despacho de motoboys.', 'Acesse sua central de despacho.', 1)

index.write_text(html, encoding='utf-8')

sw = Path('public/service-worker.js')
sw_text = sw.read_text(encoding='utf-8')
sw_text = re.sub(r'const CACHE = "[^"]+";', 'const CACHE = "despachefull-v3.6.1-login-approved-reference";', sw_text, count=1)
if '"/login-approved-reference.jpg"' not in sw_text:
    sw_text = sw_text.replace('"/login-motorcycle.jpg"', '"/login-motorcycle.jpg", "/login-approved-reference.jpg"', 1)
sw.write_text(sw_text, encoding='utf-8')

required_ids = ['loginScreen','loginForm','loginUser','loginPass','registerForm','regName','regUser','regPass','regPass2','registerSubmit','tabLogin','tabRegister','registrationNotice','authMsg']
for element_id in required_ids:
    count = html.count(f'id="{element_id}"')
    if count != 1:
        raise SystemExit(f'ID {element_id}: esperado 1, encontrado {count}')

assert marker in html
assert '/login-approved-reference.jpg' in html
assert '@media (min-width:901px)' in html
print('PASS approved desktop login patch')
