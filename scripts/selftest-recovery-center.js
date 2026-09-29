import fs from "node:fs";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");

const checks=[
 ["Recovery list is admin-only", /app\.get\("\/api\/admin\/recovery-center", auth, adminOnly/.test(server)],
 ["Stale recovery is admin-only", /app\.post\("\/api\/admin\/recovery-center\/:platform\/:id\/recover-stale", auth, adminOnly/.test(server)],
 ["Recovery list only exposes terminal or stale jobs", /WHERE j\.status='FAILED'[\s\S]{0,300}PROCESSING[\s\S]{0,300}3 minutes/.test(server) && /anotaai_dispatch_status='DEAD'[\s\S]{0,300}PROCESSING[\s\S]{0,300}3 minutes/.test(server)],
 ["Allowed actions are server-calculated", server.includes('allowed_actions = ["RETRY_CYCLE"]') && server.includes('allowed_actions = ["RECOVER_STALE"]')],
 ["iFood stale recovery uses compare-and-set state guard", /WHERE ifood_order_id=\$1[\s\S]{0,180}status='PROCESSING'[\s\S]{0,180}locked_at < NOW\(\)-INTERVAL '3 minutes'/.test(server)],
 ["AnotaAi stale recovery uses compare-and-set state guard", /WHERE anotaai_order_id=\$1[\s\S]{0,220}anotaai_dispatch_status='PROCESSING'[\s\S]{0,180}processing_started_at < NOW\(\)-INTERVAL '3 minutes'/.test(server)],
 ["Stale recovery respects retry ceilings", /CASE WHEN attempts >= \$2 THEN 'FAILED' ELSE 'RETRY' END/.test(server) && /CASE WHEN attempts >= \$2 THEN 'DEAD' ELSE 'FAILED' END/.test(server)],
 ["Stale recovery is audited", server.includes('"RECOVERY_STALE_JOB"')],
 ["Stale recovery emits trace event", server.includes('dispatch.admin_recovered_stale')],
 ["iFood manual cycle only starts from FAILED", /if \(row\.job_status !== "FAILED"\)[\s\S]{0,900}AND status='FAILED'[\s\S]{0,100}RETURNING dispatch_id/.test(server)],
 ["AnotaAi manual cycle only starts from DEAD", /if \(row\.anotaai_dispatch_status !== "DEAD"\)[\s\S]{0,1200}AND anotaai_dispatch_status='DEAD'/.test(server)],
 ["Trace endpoint remains admin-only", /app\.get\("\/api\/admin\/trace", auth, adminOnly/.test(server)],
 ["Recovery UI exists", ui.includes('id="recovery"') && ui.includes("Central de Recuperação")],
 ["Recovery UI is under Sistema", /system:\{label:'Sistema'[\s\S]{0,300}\['recovery','Recuperação'\]/.test(ui)],
 ["Recovery UI consumes server allowed_actions", ui.includes("x.allowed_actions||[]")],
 ["Recovery UI reuses protected trace endpoint", ui.includes("'/api/admin/trace?dispatch_id='")],
 ["Recovery UI has explicit confirmation", ui.includes("O servidor validará o estado novamente antes de executar.")],
 ["Recovery UI has no arbitrary status editor", !/recovery[\s\S]{0,80}(set-status|force-status|edit-status)/i.test(ui)]
];

let failed=0;
for(const [name,ok] of checks){console.log((ok?"PASS":"FAIL")+" - "+name);if(!ok)failed++}
if(failed){console.error(`Recovery Center self-test failed: ${failed} check(s).`);process.exit(1)}
console.log(`Recovery Center self-test passed: ${checks.length}/${checks.length}.`);
