import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Starts the real application with a private, in-memory Postgres database.
// No inherited database URL, .env, integration credential or deploy secret.
export async function startIsolatedApp({ failSessionSave = false } = {}) {
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const admin={username:'synthetic_admin',password:crypto.randomBytes(24).toString('base64url')};
  const child=spawn(process.execPath,['--loader','./scripts/test-support/pglite-loader.js','server.js'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    env:{PATH:process.env.PATH,DOTENV_CONFIG_PATH:'/dev/null',NODE_ENV:'test',APP_ENV:'staging',STAGING_SAFE_MODE:'true',
      DATABASE_URL:'postgresql://isolated-test@127.0.0.1/in-memory',SESSION_SECRET:crypto.randomBytes(48).toString('base64url'),
      ADMIN_USERNAME:admin.username,ADMIN_PASSWORD:admin.password,ADMIN_NAME:'Synthetic test admin',PORT:String(port),
      ISOLATED_SESSION_SAVE_FAILURE:String(failSessionSave)},
    stdio:['ignore','pipe','pipe']
  });
  let output='';child.stdout.on('data',buffer=>{output+=buffer;});child.stderr.on('data',buffer=>{output+=buffer;});
  const close=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;};
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Isolated app startup timed out.')),30000);
      const cleanup=()=>clearTimeout(timer);
      child.stdout.on('data',()=>{if(output.includes(`rodando na porta ${port}`)){cleanup();resolve();}});
      child.once('error',error=>{cleanup();reject(error);});
      child.once('exit',()=>{cleanup();reject(new Error('Isolated app startup failed: '+output.slice(-2000)));});
    });
    return {base:`http://127.0.0.1:${port}`,admin,close};
  }catch(error){await close();throw error;}
}
