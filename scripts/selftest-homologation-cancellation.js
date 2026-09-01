import fs from 'fs';
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const sw=fs.readFileSync(new URL('../public/service-worker.js',import.meta.url),'utf8');
const checks={
  version: pkg.version==='3.5.2' && server.includes('const VERSION = "3.5.2";'),
  reasons_endpoint: server.includes('/cancellation-reasons-test') && server.includes('/cancellationReasons'),
  cancel_endpoint: server.includes('/cancel-test') && server.includes('/requestCancellation'),
  test_only_guard: server.includes('Cancelamento controlado permitido somente para pedido de teste.'),
  validates_dynamic_reason: server.includes('Motivo de cancelamento inválido para este pedido.') && server.includes('reasons.find'),
  audit: server.includes('IFOOD_TEST_CANCELLATION_REQUESTED'),
  ui_button: html.includes('Cancelar teste') && html.includes('cancelIfoodTestOrder'),
  ui_fetches_reasons: html.includes('/cancellation-reasons-test'),
  pwa_cache: sw.includes('despachefull-v3.5.2-homologation-cancel')
};
const failed=Object.entries(checks).filter(([,v])=>!v).map(([k])=>k);
if(failed.length){console.error(JSON.stringify({result:'FAIL',failed,checks},null,2));process.exit(1)}
console.log(JSON.stringify({result:'PASS',version:'3.5.2',checks},null,2));
