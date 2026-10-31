import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {seedDeliveries} from './egress-test-support.js';

const adminUrl=process.env.EGRESS_CI_DATABASE_URL;
assert.ok(adminUrl,'EGRESS_CI_DATABASE_URL is required');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(adminUrl).hostname),'Only loopback test databases are allowed');
const baseline=path.resolve(process.env.EGRESS_BASELINE_DIR||'../baseline'),candidate=path.resolve('.');
const admin=new pg.Client({connectionString:adminUrl,ssl:false});await admin.connect();
const fixtureAt=new Date().toISOString(),reports=[],snapshots=[];
const percentile=(a,p)=>{a=[...a].sort((a,b)=>a-b);return Number(a[Math.min(a.length-1,Math.ceil(a.length*p)-1)].toFixed(3));};
for(const [index,root] of [baseline,candidate].entries()){
  const database='egress_http_'+index;await admin.query('CREATE DATABASE '+database);
  const connection=new URL(adminUrl);connection.pathname='/'+database;
  const port=3101+index,url='http://127.0.0.1:'+port;
  const env={PATH:process.env.PATH,NODE_ENV:'test',APP_ENV:'staging',STAGING_SAFE_MODE:'true',
    DATABASE_URL:connection.href,SESSION_SECRET:'egress-isolated-test-session-secret-000000000000',
    ADMIN_USERNAME:'egress_admin',ADMIN_PASSWORD:'Egress-Test-Only-987654',ADMIN_NAME:'Egress Test',
    PORT:String(port),DB_POOL_MAX:'20',LOAD_TEST_KEY:'egress-isolated-load-test',
    IFOOD_ENABLED:'true',IFOOD_DISPATCH_ENABLED:'true',ANOTAAI_ENABLED:'true',
    OPERATIONAL_NOW_OVERRIDE:'2026-09-29T15:00:00Z'};
  let logs='';const app=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',b=>{logs+=b});app.stderr.on('data',b=>{logs+=b});
  const db=new pg.Pool({connectionString:connection.href,ssl:false,max:8});
  try{
    let health;
    for(let n=0;n<120;n++){if(app.exitCode!==null)throw Error('App exited: '+logs.slice(-3000));try{const res=await fetch(url+'/api/health');if(res.ok){health=await res.json();break;}}catch{}await delay(250);}
    assert.ok(health?.ok,'Health did not become ready');assert.equal(health.stagingSafeMode,true);assert.equal(health.externalMutationsAllowed,false);assert.equal(health.ifood.eventSyncEnabled,false);assert.equal(health.anotaai.automaticSyncEnabled,false);
    await seedDeliveries((sql,args)=>db.query(sql,args),{couriers:30,perCourier:18});
    await db.query("UPDATE dispatches SET departed_at=$1::timestamptz WHERE dispatch_code LIKE 'egress-%'",[fixtureAt]);
    const hash=await bcrypt.hash('Courier-Test-Only-987654',10);
    await db.query("UPDATE users SET password_hash=$1 WHERE role='courier' AND username LIKE 'egress_%'",[hash]);
    await db.query("SELECT setval(pg_get_serial_sequence('users','id'),(SELECT MAX(id) FROM users))");
    const cookies=[];
    for(let id=2;id<32;id++){
      const r=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-load-test-key':env.LOAD_TEST_KEY},body:JSON.stringify({username:'egress_'+id,password:'Courier-Test-Only-987654'})});assert.equal(r.status,200);cookies.push(r.headers.get('set-cookie').split(';')[0]);
    }
    const endpoints=['/api/courier/ifood/deliveries','/api/courier/anotaai/deliveries','/api/courier/dashboard'];
    const cases=[];
    for(const concurrency of [1,30,60]){
      const timings=endpoints.map(()=>[]),statusCounts={};
      for(let round=0;round<5;round++)await Promise.all(Array.from({length:concurrency},async(_,i)=>{
        await Promise.all(endpoints.map(async(endpoint,e)=>{const start=performance.now();const r=await fetch(url+endpoint,{headers:{cookie:cookies[i%30]}});const body=await r.text();timings[e].push(performance.now()-start);statusCounts[r.status]=(statusCounts[r.status]||0)+1;assert.equal(r.status,200,endpoint+' '+body.slice(0,400));}));
      }));
      cases.push({concurrency,statusCounts,endpoints:endpoints.map((endpoint,e)=>({endpoint,requests:timings[e].length,p50Ms:percentile(timings[e],.5),p95Ms:percentile(timings[e],.95),p99Ms:percentile(timings[e],.99)}))});
    }
    const cards=await(await fetch(url+endpoints[0],{headers:{cookie:cookies[0]}})).json();delete cards.server_now;snapshots.push(cards);
    // The existing transactional smoke starts with couriers who have no route.
    await db.query("UPDATE dispatches SET status='RELEASED' WHERE dispatch_code LIKE 'egress-%'");
    const smoke=spawn(process.execPath,[path.join(candidate,'scripts/smoke-staging-gate.js')],{cwd:root,env:{...env,TARGET_URL:url,LOADTEST_ADMIN_USERNAME:env.ADMIN_USERNAME,LOADTEST_ADMIN_PASSWORD:env.ADMIN_PASSWORD,LOAD_TEST_CONFIRM:'STAGING_ONLY_I_UNDERSTAND',COURIERS:'30',DEPARTURES_PER_COURIER:'5'},stdio:['ignore','pipe','pipe']});
    let smokeLog='';smoke.stdout.on('data',b=>{smokeLog+=b});smoke.stderr.on('data',b=>{smokeLog+=b});
    const smokeExit=await new Promise(resolve=>smoke.on('exit',resolve));assert.equal(smokeExit,0,smokeLog.slice(-5000));
    const smokeReport=JSON.parse(fs.readFileSync(path.join(root,'staging-smoke-report.json'),'utf8'));
    reports.push({variant:index?'candidate':'baseline',health:{safeMode:true,externalMutationsAllowed:false},cases,smoke:smokeReport});
  }finally{
    fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/egress-http-'+index+'.log',logs);app.kill('SIGTERM');await db.end();
    await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(()=>{app.kill('SIGKILL');resolve();},3000).unref();});
  }
}
await admin.end();assert.deepEqual(snapshots[1],snapshots[0],'Full HTTP cards must match, excluding server_now');
const report={engine:'PostgreSQL 17 native',syntheticOnly:true,reports,identicalHttpCards:true};
fs.writeFileSync('test-results/egress-http.json',JSON.stringify(report,null,2));console.log('EGRESS_HTTP_JSON\n'+JSON.stringify(report,null,2));
