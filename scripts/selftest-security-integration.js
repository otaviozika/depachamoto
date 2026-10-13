import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startIsolatedApp } from './test-support/isolated-app.js';
// ws is the locked Engine.IO transport dependency already used by Socket.IO.
const require=createRequire(import.meta.url),WebSocket=require('ws');
const app=await startIsolatedApp(),sockets=[];
let checks=0;
const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('PASS - '+label);};
async function request(route,{method='GET',body,cookie}={}){
  const response=await fetch(app.base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
async function login(username,password){const result=await request('/api/login',{method:'POST',body:{username,password}});assert.equal(result.status,200);assert.ok(result.cookie);return result.cookie;}
async function socket(cookie,expectAccepted=true){
  const ws=new WebSocket(app.base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket',{headers:cookie?{Cookie:cookie}:{}});sockets.push(ws);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(new Error('Socket test timed out'));},6000);
    ws.on('error',reject);
    ws.on('message',buffer=>{
      const message=buffer.toString();
      if(message.startsWith('0'))ws.send('40');
      if(message==='2')ws.send('3');
      if(message.startsWith('40')){clearTimeout(timer);expectAccepted?resolve(ws):reject(new Error('Revoked socket accepted'));}
      if(message.startsWith('44')){clearTimeout(timer);ws.close();expectAccepted?reject(new Error('Valid socket rejected')):resolve(null);}
    });
  });
}
async function closed(ws){if(ws.readyState===WebSocket.CLOSED)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Old socket remained open')),4000);ws.once('close',()=>{clearTimeout(timer);resolve();});});}
try{
  check((await request('/api/me')).status===401,'unauthenticated HTTP access rejected');
  await socket(null,false);check(true,'unauthenticated realtime access rejected');
  const adminA=await login(app.admin.username,app.admin.password),adminB=await login(app.admin.username,app.admin.password);
  const password='synthetic-courier-password',nextPassword='synthetic-new-courier-password';
  const courier=(await request('/api/admin/couriers',{method:'POST',cookie:adminA,body:{name:'Synthetic courier',username:'synthetic_courier',password}})).data.user;
  check(!!courier?.id,'test courier created through actual admin API');
  const other=(await request('/api/admin/couriers',{method:'POST',cookie:adminA,body:{name:'Other synthetic courier',username:'synthetic_other',password}})).data.user;
  const courierA=await login('synthetic_courier',password),courierB=await login('synthetic_courier',password),otherCookie=await login('synthetic_other',password);
  const socketA=await socket(courierA),socketB=await socket(courierB),otherSocket=await socket(otherCookie);
  check((await request('/api/account/password',{method:'POST',body:{current_password:password,new_password:nextPassword}})).status===401,'password change requires server authentication');
  check((await request('/api/account/password',{method:'POST',cookie:courierA,body:{current_password:'incorrect',new_password:nextPassword}})).status===400,'wrong current password rejected');
  check((await request('/api/account/password',{method:'POST',cookie:courierA,body:{current_password:password,new_password:'short'}})).status===400,'short replacement rejected');
  check((await request('/api/account/password',{method:'POST',cookie:courierA,body:{current_password:password,new_password:password}})).status===400,'unchanged password rejected');
  check((await request('/api/me',{cookie:courierB})).status===200&&socketB.readyState===WebSocket.OPEN,'failed changes do not revoke legitimate access');
  check((await request('/api/admin/couriers/'+other.id+'/reset-password',{method:'POST',cookie:courierA})).status===403,'courier cannot invoke administrator reset');
  const changed=await request('/api/account/password',{method:'POST',cookie:courierA,body:{current_password:password,new_password:nextPassword}});
  check(changed.status===200&&changed.data.session_rotated===true,'actual password change completes and explicitly rotates session');
  check(!!changed.cookie&&changed.cookie!==courierA&&changed.cookie!==courierB,'initiating browser receives a new session identifier');
  check((await request('/api/me',{cookie:courierA})).status===401&&(await request('/api/me',{cookie:courierB})).status===401,'both old cookies rejected immediately');
  check((await request('/api/me',{cookie:changed.cookie})).status===200,'rotated cookie preserves initiating user access');
  await Promise.all([closed(socketA),closed(socketB)]);check(true,'all old user sockets disconnected immediately');
  await socket(courierB,false);check(true,'revoked cookie cannot open a new socket');
  await socket(changed.cookie);check(true,'rotated session reconnects realtime');
  check((await request('/api/me',{cookie:otherCookie})).status===200&&otherSocket.readyState===WebSocket.OPEN,'other user cookies and sockets remain valid');
  check((await request('/api/login',{method:'POST',body:{username:'synthetic_courier',password}})).status===401,'previous password can no longer log in');
  await login('synthetic_courier',nextPassword);check(true,'new password authenticates');
  const adminSocket=await socket(adminB);
  const adminChanged=await request('/api/account/password',{method:'POST',cookie:adminA,body:{current_password:app.admin.password,new_password:'synthetic-new-admin-password'}});
  check(adminChanged.status===200&&(await request('/api/admin/security',{cookie:adminB})).status===401,'administrator old session loses privileged API access');
  await closed(adminSocket);check(true,'administrator old realtime access disconnected');
  check((await request('/api/admin/security',{cookie:adminChanged.cookie})).status===200,'rotated administrator retains legitimate privilege');

  const concurrentA=await login('synthetic_courier',nextPassword),concurrentB=await login('synthetic_courier',nextPassword);
  const races=await Promise.all(['synthetic-race-winner-a','synthetic-race-winner-b'].map((new_password,i)=>request('/api/account/password',{method:'POST',cookie:i?concurrentB:concurrentA,body:{current_password:nextPassword,new_password}})));
  check(races.filter(x=>x.status===200).length===1&&races.filter(x=>x.status===401).length===1,'simultaneous password changes have exactly one winner');
  const winner=races.find(x=>x.status===200);
  check((await request('/api/me',{cookie:winner.cookie})).status===200&&(await request('/api/me',{cookie:concurrentA})).status===401&&(await request('/api/me',{cookie:concurrentB})).status===401,'concurrent loser cannot revive either old cookie');

  const pendingName="');globalThis.attackerExecuted=true;//";
  const registered=await request('/api/register',{method:'POST',body:{name:pendingName,username:'synthetic_pending',password}});
  check(registered.status===201&&registered.data.user.name===pendingName,'public-registration attack reaches real stored-name path as data');
  const list=await request('/api/admin/dashboard',{cookie:adminChanged.cookie});
  check(list.status===200&&list.data.couriers.some(row=>row.name===pendingName),'actual admin response contains attacker name for secure frontend regression');
  const headers=await fetch(app.base+'/');
  const csp=headers.headers.get('content-security-policy');
  check(csp.includes("script-src-attr 'none'")&&!/script-src [^;]*'unsafe-inline'/.test(csp),'actual HTML response enforces strict script and event-handler CSP');
  check(!JSON.stringify(changed.data).includes('session_version')&&!JSON.stringify(changed.data).includes('password_hash'),'password change response exposes no hash or internal epoch');
  const reset=await request('/api/admin/couriers/'+other.id+'/reset-password',{method:'POST',cookie:adminChanged.cookie,body:{new_password:'synthetic-temporary-reset-password'}});
  check(reset.status===200&&(await request('/api/me',{cookie:otherCookie})).status===401,'administrator reset also revokes current credential epoch');
  await closed(otherSocket);check(true,'administrator reset disconnects old sockets');
  const afterReset=await login('synthetic_other','synthetic-temporary-reset-password');
  await socket(afterReset);check(true,'reset account reconnects only using new credentials');
  await request('/api/password-recovery/request',{method:'POST',body:{username:'synthetic_other'}});
  const recoveries=(await request('/api/admin/password-recovery',{cookie:adminChanged.cookie})).data.rows;
  const recovery=recoveries.find(row=>row.username==='synthetic_other'&&row.status==='PENDING');assert.ok(recovery);
  const approval=await request('/api/admin/password-recovery/'+recovery.id+'/approve',{method:'POST',cookie:adminChanged.cookie});
  const recovered=await request('/api/password-recovery/reset',{method:'POST',body:{username:'synthetic_other',code:approval.data.code,new_password:'synthetic-recovered-password',confirm_password:'synthetic-recovered-password'}});
  check(recovered.status===200&&(await request('/api/me',{cookie:afterReset})).status===401,'recovery follows the same session epoch revocation contract');
  await login('synthetic_other','synthetic-recovered-password');check(true,'recovered account authenticates with new password');
  // Simulate session-store failure AFTER the atomic password change committed.
  // Only the test adapter can inject this; production imports no fixture hooks.
  const failing=await startIsolatedApp({failSessionSave:true});
  try{
    async function isolatedPost(path,body,cookie){return fetch(failing.base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});}
    const first=await isolatedPost('/api/login',failing.admin),old=first.headers.get('set-cookie')?.split(';')[0];assert.equal(first.status,200);
    const response=await isolatedPost('/api/account/password',{current_password:failing.admin.password,new_password:'synthetic-store-failure-new-password'},old);
    const body=await response.json();
    check(response.status===200&&body.ok===true&&body.reauthenticate===true,'post-commit save failure clearly requests reauthentication instead of reporting unchanged password');
    check((await fetch(failing.base+'/api/me',{headers:{Cookie:old}})).status===401,'save failure never resurrects old authenticated cookie');
    const newLogin=await isolatedPost('/api/login',{username:failing.admin.username,password:'synthetic-store-failure-new-password'});
    check(newLogin.status===200,'new password remains usable after session-store recovery');
  }finally{await failing.close();}
  console.log(`Full-application security integration passed: ${checks}/${checks}. Real Express routes, password hashing, session store, Socket.IO and in-memory Postgres; no production connections.`);
}finally{for(const ws of sockets)ws.terminate();await app.close();}
