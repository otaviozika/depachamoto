import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/login-desktop.css',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../public/service-worker.js',import.meta.url),'utf8');
// All desktop declarations stay under one media boundary. Visibility remains
// owned by .hidden!important, even for the root screen after session restore.
const clean=css.replace(/\/\*[\s\S]*?\*\//g,'').trim();
assert.ok(clean.startsWith('@media (min-width:901px){'));
let depth=0;
for(let i=clean.indexOf('{');i<clean.length;i++){
  if(clean[i]==='{')depth++;
  if(clean[i]==='}')depth--;
  if(depth===0)assert.equal(clean.slice(i+1).trim(),'','Desktop styles escaped the media boundary');
}
assert.equal(depth,0);
assert.doesNotMatch(clean,/display\s*:\s*(?!none\b)[\w-]+\s*!important/i,'Display rules must not defeat authentication visibility');
for(const match of css.matchAll(/url\(['"]?(\/[^'"\)]+)['"]?\)/g)){
  assert.ok(fs.existsSync(new URL(`../public${match[1]}`,import.meta.url)),`Missing asset ${match[1]}`);
  assert.ok(sw.includes(match[1]),`Offline cache missing ${match[1]}`);
}
for(const id of ['tabLogin','tabRegister','loginForm','registerForm','loginUser','loginPass','regName','regUser','regPass','regPass2','desktopAuthTitle','desktopAuthSubtitle']){
  assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,`${id} must be unique`);
}
assert.match(html,/\$\('loginForm'\)\.onsubmit=login;/);
assert.match(html,/\$\('registerForm'\)\.onsubmit=register;/);

// Execute the actual access handlers, not copies of their implementation.
const script=html.match(/<script>\s*let me=[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');
new vm.Script(script); // Also validate the complete inline application script.
function source(name){
  const begin=script.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(begin>=0,name);
  const next=script.slice(begin+1).search(/\n(?:async )?function /);
  return script.slice(begin,next<0?undefined:begin+1+next);
}
const elements=new Map();
function element(id){
  if(!elements.has(id)){
    const classes=new Set(id==='registerForm'?['hidden']:[]);
    elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,focused:false,
      focus(){this.focused=true},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v),toggle(v,on){if(on??!classes.has(v))classes.add(v);else classes.delete(v)}}});
  }
  return elements.get(id);
}
const saved=new Map();
let response={},failure=null,requests=[],shown=0,redirect='';
const context=vm.createContext({$:element,me:null,sessionRedirecting:false,
  sessionStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
  window:{location:{replace:url=>{redirect=url}}},setTimeout:fn=>fn(),
  api:async(url,opt)=>{requests.push({url,opt});if(failure)throw failure;return response},
  showApp:()=>shown++
});
for(const name of ['setAuth','message','escapeHtml','showSessionNotice','redirectExpiredSession','login','register','loadPublicConfig'])vm.runInContext(source(name),context);
const hidden=id=>element(id).classList.contains('hidden');
for(const mode of ['login','register','login','register','login']){
  context.setAuth(mode);
  assert.notEqual(hidden('loginForm'),hidden('registerForm'),'Exactly one auth form must be active');
  assert.equal(hidden('loginForm'),mode==='register');
  assert.equal(element('desktopAuthTitle').textContent,mode==='register'?'Crie sua conta':'Acesse sua conta');
}
context.setAuth('unexpected');
assert.equal(hidden('loginForm'),false,'Unknown modes must safely fall back to login');
const event={preventDefault(){}};
element('loginUser').value='desktop.fixture';element('loginPass').value='test-only-password';
response={user:{id:1,role:'admin'}};
await context.login(event);assert.equal(shown,1);assert.equal(context.me.role,'admin');assert.equal(requests.at(-1).url,'/api/login');
failure=new Error('Usuário ou senha inválidos.');
await context.login(event);assert.equal(shown,1);assert.ok(element('authMsg').innerHTML.includes(failure.message));failure=null;
context.setAuth('register');element('regPass').value='test-only-password';element('regPass2').value='different';
let count=requests.length;await context.register(event);assert.equal(requests.length,count);assert.ok(element('authMsg').innerHTML.includes('As senhas não conferem.'));
element('regPass2').value=element('regPass').value;element('regUser').value='desktop.fixture';element('regName').value='Desktop Fixture';
failure=new Error('Usuário já cadastrado.');await context.register(event);assert.equal(hidden('registerForm'),false);assert.ok(element('authMsg').innerHTML.includes(failure.message));failure=null;
response={user:{username:'desktop.fixture'},message:'Cadastro enviado para aprovação.'};
await context.register(event);assert.equal(requests.at(-1).url,'/api/register');assert.equal(hidden('registerForm'),true);assert.equal(element('loginUser').value,'desktop.fixture');assert.ok(element('authMsg').innerHTML.includes(response.message));
response={registrationEnabled:false};await context.loadPublicConfig();assert.equal(element('tabRegister').disabled,true);assert.equal(element('registerSubmit').disabled,true);
response={registrationEnabled:true};await context.loadPublicConfig();assert.equal(element('tabRegister').disabled,false);
context.me={username:'desktop.fixture'};context.redirectExpiredSession();assert.equal(redirect,'/');assert.equal(saved.get('dm_session_username'),'desktop.fixture');
context.setAuth('register');context.showSessionNotice();assert.equal(hidden('registerForm'),true);assert.equal(element('loginPass').value,'');assert.equal(element('loginPass').focused,true);assert.ok(element('authMsg').innerHTML.includes('Sua sessão expirou.'));assert.equal(saved.size,0);
assert.ok(![...saved.keys()].some(k=>/password|senha/i.test(k)));
console.log(JSON.stringify({result:'PASS',singleAuthForm:true,loginSuccessAndError:true,registerValidationAndApproval:true,registrationPolicy:true,expiredSessionReturn:true,desktopCssScoped:true}));
