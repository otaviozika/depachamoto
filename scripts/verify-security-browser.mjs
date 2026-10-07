import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startIsolatedApp } from './test-support/isolated-app.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.SECURITY_PLAYWRIGHT_MODULE || 'playwright');
const app=await startIsolatedApp();
const base=app.base,password='synthetic-courier-password',newPassword='synthetic-browser-new-password';
const outputDir=process.env.SECURITY_BROWSER_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(),'despachefull-browser-security-'));
fs.mkdirSync(outputDir,{recursive:true});
let browser;
try{browser=await chromium.launch({headless:true,...(process.env.SECURITY_CHROMIUM_PATH?{executablePath:process.env.SECURITY_CHROMIUM_PATH}:{}),args:process.getuid?.()===0?['--no-sandbox']:[]});}catch(error){await app.close();throw error;}
let checks=0;
const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('PASS browser - '+label);};
const errors=[];
async function session(username,pass,role,{mobile=false}={}){
  const context=await browser.newContext({serviceWorkers:'block',viewport:mobile?{width:390,height:844}:{width:1440,height:1050}});
  await context.addInitScript(()=>{globalThis.attackerExecuted=false;globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>cspViolations.push(event.violatedDirective));});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('#loginUser').fill(username);await page.locator('#loginPass').fill(pass);
  await page.locator('#loginForm').getByRole('button',{name:'Entrar',exact:true}).click();
  await page.locator(role==='admin'?'#adminApp':'#courierApp').waitFor({state:'visible'});
  await page.waitForFunction(()=>socket.connected);
  return {page,context};
}
try{
  // Required first-load check, before application mutations or full scenarios.
  const initial=await browser.newContext({serviceWorkers:'block'}),initialPage=await initial.newPage();
  initialPage.on('pageerror',error=>errors.push(error.message));
  await initialPage.goto(base,{waitUntil:'networkidle'});
  await initialPage.locator('#loginForm').waitFor({state:'visible'});
  await initialPage.locator('#tabRegister').click();await initialPage.locator('#registerForm').waitFor({state:'visible'});
  await initialPage.locator('#tabLogin').click();await initialPage.locator('#loginForm').waitFor({state:'visible'});
  await initialPage.getByRole('button',{name:'Esqueci minha senha',exact:true}).click();
  await initialPage.getByRole('button',{name:'Já tenho o código',exact:true}).click();
  await initialPage.locator('#passwordRecoveryResetForm').waitFor({state:'visible'});
  await initialPage.locator('#passwordRecoveryModal button[aria-label="Fechar"]').click();
  await initialPage.locator('#passwordRecoveryModal').waitFor({state:'hidden'});
  check(errors.length===0,'first-load, login/register navigation and recovery modal work without JavaScript errors');
  await initial.close();
  const anonymous=await browser.newContext({serviceWorkers:'block'});
  const names=["');globalThis.attackerExecuted=true;//","'-globalThis.attackerExecuted=true-'",'O\'Brien "&<>',
    '<img src=x onerror=globalThis.attackerExecuted=true>', '</script><script>globalThis.attackerExecuted=true</script>',
    '&#39;);globalThis.attackerExecuted=true;//', 'José 🛵\\\nU+2028:\u2028fim'];
  const ids=[];
  for(const [index,name] of names.entries()){
    const result=await anonymous.request.post(base+'/api/register',{data:{name,username:'browser_attack_'+index,password}});
    assert.equal(result.status(),201);ids.push((await result.json()).user.id);
  }
  const admin=await session(app.admin.username,app.admin.password,'admin');
  await admin.page.locator('#adminApp [data-admin-group="management"]').first().click();
  await admin.page.locator('[data-subpage="couriers"]').click();
  for(const [index,id] of ids.entries()){
    const row=admin.page.locator('#courierTable tr').filter({hasText:'browser_attack_'+index});
    check((await row.textContent()).includes(names[index]),'stored public name displayed as literal text');
    const target=row.getByRole('button',{name:'Resetar senha',exact:true});
    check(JSON.parse(await target.getAttribute('data-ui-click-args'))[1]===names[index],'browser-decoded action argument preserves exact name');
    const dialogPromise=admin.page.waitForEvent('dialog').then(async dialog=>{
      check(dialog.type()==='prompt'&&dialog.message().includes(names[index]),'reset button executes only trusted password prompt');await dialog.dismiss();
    });await target.click();await dialogPromise;
    check(await admin.page.evaluate(()=>attackerExecuted)===false,'stored XSS payload never executes on click');
  }
  check(await admin.page.locator('#courierTable [onclick],#courierTable [onerror],#courierTable script,#courierTable img').count()===0,'attacker creates no executable element or handler');
  await admin.page.screenshot({path:path.join(outputDir,'security-admin-stored-xss.png'),fullPage:true});
  await admin.page.locator('#adminProfileButton').click();await admin.page.locator('#adminProfileMenu').waitFor({state:'visible'});
  await admin.page.locator('#adminProfileMenu [data-ui-click="a9649063bcae1f0"]').click();
  await admin.page.locator('#adminAccountModal').waitFor({state:'visible'});
  await admin.page.locator('#adminAccountModal button[data-ui-click="af022eb0bd9405e"]').click();
  check(true,'declarative profile menu and account modal preserve interaction');

  // The restored monthly sheet must work through the actual UI/API boundary.
  // Google integration is disabled in this isolated staging application.
  await admin.page.locator('[data-subpage="payments"]').click();
  await admin.page.locator('#paymentDailyView').waitFor({state:'visible'});
  check(await admin.page.locator('#paymentMonthView').isHidden(),'payments opens in the daily view');
  const monthResponse=admin.page.waitForResponse(response=>response.url().includes('/api/admin/payments/month?')&&response.request().method()==='GET');
  await admin.page.locator('#paymentMonthTab').click();
  const monthResult=await monthResponse;
  check(monthResult.status()===200,'monthly tab loads the protected monthly API');
  await admin.page.locator('#paymentMonthView').waitFor({state:'visible'});
  await admin.page.waitForFunction(()=>paymentMonthState.month&&document.querySelectorAll('#paymentMonthDays button').length>=28);
  check(await admin.page.locator('#paymentMonthTab').getAttribute('aria-selected')==='true','monthly tab exposes its active accessibility state');
  await admin.page.locator('#paymentBookDinner').click();
  check(await admin.page.evaluate(()=>paymentMonthState.shift)==='DINNER','monthly dinner tab selects the correct shift');
  await admin.page.locator('#paymentBookLunch').click();
  check(await admin.page.evaluate(()=>paymentMonthState.shift)==='LUNCH','monthly lunch tab selects the correct shift');
  await admin.page.locator('#paymentMonthDays button').last().click();
  check(await admin.page.evaluate(()=>paymentMonthState.date.endsWith(String(paymentMonthDates(paymentMonthState.month).length))),'monthly day tab selects the last valid day');
  await admin.page.locator('#paymentDailyTab').click();
  await admin.page.locator('#paymentDailyView').waitFor({state:'visible'});
  check(await admin.page.locator('#paymentMonthView').isHidden(),'daily tab restores the daily view');
  check(await admin.page.evaluate(()=>cspViolations.length)===0,'payment tabs execute with the strict CSP');

  for(const username of ['browser_courier','browser_other']){
    const result=await admin.context.request.post(base+'/api/admin/couriers',{data:{name:username,username,password}});assert.equal(result.status(),201);
  }
  const a=await session('browser_courier',password,'courier',{mobile:true});
  const b=await session('browser_courier',password,'courier');
  const other=await session('browser_other',password,'courier',{mobile:true});
  const oldCookie=(await a.context.cookies()).find(cookie=>cookie.name==='connect.sid').value;
  await a.page.locator('#courierAccountButton').click();await a.page.locator('#courierAccountMenu').waitFor({state:'visible'});
  await a.page.locator('#courierAccountMenu').getByRole('button',{name:'Alterar minha senha',exact:false}).click();
  await a.page.locator('#currentPassword').fill('incorrect');await a.page.locator('#newPassword').fill(newPassword);await a.page.locator('#newPassword2').fill(newPassword);
  await a.page.locator('#passwordForm button[type="submit"]').click();
  await a.page.getByText('Senha atual incorreta.',{exact:true}).waitFor({state:'visible'});await a.page.waitForFunction(()=>socket.connected&&!passwordChangeInProgress);
  check((await b.context.request.get(base+'/api/me')).status()===200,'wrong-password UI attempt leaves other browser logged in');
  await a.page.locator('#currentPassword').fill(password);
  let releaseBefore,releaseDuring,holdBefore,holdDuring;
  const beforeCaptured=new Promise(resolve=>{holdBefore=resolve;}),duringCaptured=new Promise(resolve=>{holdDuring=resolve;});
  await a.page.route('**/api/test-stale-before',route=>{releaseBefore=()=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"stale","code":"SESSION_EXPIRED"}'});holdBefore();});
  await a.page.route('**/api/test-stale-during',route=>{releaseDuring=()=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"stale","code":"SESSION_EXPIRED"}'});holdDuring();});
  await a.page.evaluate(()=>{window.beforePending=api('/api/test-stale-before').catch(error=>error.status);});await beforeCaptured;
  await a.page.route('**/api/account/password',async route=>{
    await a.page.evaluate(()=>{window.duringPending=api('/api/test-stale-during').catch(error=>error.status);});await duringCaptured;await route.continue();
  });
  await a.page.locator('#passwordForm button[type="submit"]').click();
  await a.page.getByText('Senha alterada com sucesso. Os outros acessos foram encerrados.',{exact:true}).waitFor({state:'visible'});
  await a.page.waitForFunction(()=>socket.connected&&!passwordChangeInProgress);
  await b.page.locator('#loginForm').waitFor({state:'visible'});
  const rotated=(await a.context.cookies()).find(cookie=>cookie.name==='connect.sid').value;
  check(rotated!==oldCookie,'browser automatically receives fresh HttpOnly session cookie');
  check((await a.context.request.get(base+'/api/me')).status()===200,'initiating mobile UI remains authenticated');
  check((await b.context.request.get(base+'/api/me')).status()===401,'second browser session revoked');
  check(await other.page.evaluate(()=>socket.connected&&me?.username==='browser_other'),'other user realtime remains connected');
  await releaseBefore();await releaseDuring();
  const stale=await a.page.evaluate(async()=>[await window.beforePending,await window.duringPending]);
  check(stale.every(code=>code===401)&&await a.page.evaluate(()=>me?.username==='browser_courier'&&!sessionRedirecting),'late 401 responses from before AND during rotation cannot log out new session');
  check(await a.page.evaluate(()=>stopForExpiredSession({status:401}))===false,'raw download stale 401 checks current cookie and preserves valid session');
  await a.page.reload({waitUntil:'networkidle'});await a.page.locator('#courierApp').waitFor({state:'visible'});await a.page.waitForFunction(()=>socket.connected);
  check(true,'new session and realtime survive actual page reload');
  await a.page.screenshot({path:path.join(outputDir,'security-courier-rotated-session.png'),fullPage:true});
  check(await a.page.evaluate(()=>typeof QRCode)==='function','pinned QR library loads under strict CSP');
  check((await a.page.evaluate(()=>cspViolations)).length===0,'legitimate app scripts trigger no CSP violation');
  await a.page.evaluate(()=>{
    const button=document.createElement('button');button.id='csp-attack-probe';button.setAttribute('onclick','globalThis.attackerExecuted=true');document.body.appendChild(button);button.click();
    const script=document.createElement('script');script.textContent='globalThis.attackerExecuted=true';document.body.appendChild(script);
  });
  await a.page.waitForFunction(()=>cspViolations.length>=2);
  check(await a.page.evaluate(()=>attackerExecuted)===false,'browser CSP blocks injected handler and arbitrary inline script');
  check((await a.page.evaluate(()=>cspViolations)).some(item=>item==='script-src-attr'),'actual browser enforces script-src-attr none');
  check(errors.length===0,'no uncaught JavaScript errors in tested admin/courier flows');
  console.log(`Actual-browser security verification passed: ${checks}/${checks}. Chromium, real app, isolated database, desktop/mobile UI.`);
}finally{await browser.close();await app.close();}
