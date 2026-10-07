import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'artifacts','regression');
fs.mkdirSync(directory,{recursive:true});
// Tests receive no production credentials or database/integration destinations.
// The integration suite starts the real server with its own synthetic database.
const env={PATH:process.env.PATH,NODE_ENV:'test',APP_ENV:'staging',STAGING_SAFE_MODE:'true',DOTENV_CONFIG_PATH:'/dev/null'};
const run=(args,log)=>{
  const started=Date.now();
  const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  fs.writeFileSync(path.join(directory,log),(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):''));
  return {ok:result.status===0&&!result.error,duration_ms:Date.now()-started,exit_code:result.status,signal:result.signal};
};
// npm's lifecycle chain is the authoritative production preparation sequence.
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const preparation=pkg.scripts.prestart.split(' && ');
for(const command of preparation){
  const match=/^node (scripts\/[a-z0-9-]+\.js)$/.exec(command);
  if(!match)throw new Error('Unrecognized prestart step; update the regression runner explicitly.');
  const result=run([match[1]],path.basename(match[1])+'.log');
  if(!result.ok){console.error('FAIL preparation: '+match[1]);process.exit(1);}
}
const tests=fs.readdirSync(path.join(root,'scripts')).filter(name=>/^selftest-.*\.js$/.test(name)).sort();
if(tests.length===0)throw new Error('No regression tests discovered.');
const results=[];
for(const test of tests){
  const result={test,...run(['scripts/'+test],test+'.log')};results.push(result);
  console.log(`${result.ok?'PASS':'FAIL'} ${test} (${result.duration_ms}ms)`);
  if(!result.ok)console.error(fs.readFileSync(path.join(directory,test+'.log'),'utf8').slice(-6000));
}
const report={date:new Date().toISOString(),node:process.version,prepared:true,total:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,results};
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Regression: ${report.passed}/${report.total}, failures: ${report.failed}`);
process.exitCode=report.failed?1:0;
