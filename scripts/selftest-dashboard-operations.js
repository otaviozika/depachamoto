import fs from "fs";

const server=fs.readFileSync("server.js","utf8");
const html=fs.readFileSync("public/index.html","utf8");
const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));

const checks={
  version: server.includes('const VERSION = "3.5.0";') && pkg.version==='3.5.0' && html.includes('<title>DespacheFull 3.5.0</title>'),
  waitingDispatchSql: server.includes('AS waiting_dispatch') && server.includes("UPPER(COALESCE(o.delivered_by,''))='MERCHANT'") && server.includes('l.ifood_order_id IS NULL'),
  deliveredTodaySql: server.includes('AS delivered_today') && server.includes("IN ('CONCLUDED','DELIVERED')"),
  responseMetrics: server.includes('waitingDispatch: metrics.waiting_dispatch') && server.includes('deliveredToday: metrics.delivered_today'),
  topMetrics: ['mActive','mRoad','mAvailable','mToday','mWaiting','mProgress'].every(id=>html.includes(`id="${id}"`)),
  performanceStrip: ['pDelivered','pCompleted','pAvgRoute','pAvgReturn','pSla','pExceptions'].every(id=>html.includes(`id="${id}"`)),
  soberPerformanceCss: html.includes('#adminApp .dashboard-performance') && html.includes('#adminApp .dashboard-performance-item.has-exception b'),
  loadAdminBinding: html.includes("$('mWaiting').textContent=m.waitingDispatch||0") && html.includes("$('pDelivered').textContent=m.deliveredToday||0") && html.includes('tm.withinSlaPercent')
};

const failed=Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k);
if(failed.length){
  console.error(JSON.stringify({result:'FAIL',version:'3.5.0',failed,checks},null,2));
  process.exit(1);
}
console.log(JSON.stringify({result:'PASS',version:'3.5.0',checks},null,2));
