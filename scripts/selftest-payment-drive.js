import fs from "fs";
import crypto from "crypto";
import assert from "assert/strict";
import vm from "node:vm";
import { hasUiAction } from "./test-support/ui-action-source.js";
import { googleSheetsConfig, paymentDaySheetTitle, paymentRowsToDailySheetData, paymentRowsToSheetValues, paymentSheetTitle, syncPaymentDayToGoogleSheets, syncPaymentsToGoogleSheets } from "../lib/google-sheets.js";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const envExample=fs.readFileSync(new URL("../.env.example",import.meta.url),"utf8");

assert.equal(paymentSheetTitle("2026-09"),"Pagamentos 2026-09");
assert.throws(()=>paymentSheetTitle("09/2026"),/Mês inválido/);

const values=paymentRowsToSheetValues("2026-09",[{
  payment_date:"2026-09-26",courier_name:"Danielle",shift_label:"Janta",delivery_count:12,
  per_delivery:6,base_amount:75,rain:true,rain_bonus:10,tip_amount:4,discount_amount:2,
  adjustment_amount:3,total_amount:162,payment_method:"PIX",status_label:"EM ABERTO",
  pix_holder_name:"Danielle",pix_key:"teste",pix_type:"CPF",pix_status_label:"VERIFICADO",notes:"ok"
}]);
assert.equal(values.length,2);
assert.equal(values[1][2],"Danielle");
assert.equal(values[1][12],162);

assert.equal(paymentDaySheetTitle("2026-09-26","LUNCH"),"26/09 S");
assert.equal(paymentDaySheetTitle("2026-10-01","LUNCH"),"01/10 Q");
assert.equal(paymentDaySheetTitle("2026-10-01","DINNER"),"01/10 Q");
assert.equal(paymentDaySheetTitle("2026-09-26","DINNER"),"26/09 S");
const daily=paymentRowsToDailySheetData([{
  courier_name:"Danielle",delivery_count:12,base_amount:75,rain:true,rain_bonus:10,
  adjustment_amount:3,tip_amount:4,discount_amount:2,payment_method:"DINHEIRO",status:"PAID",notes:"ok"
}]);
assert.deepEqual(daily.names,[["Danielle"]]);
assert.deepEqual(daily.payments,[[12,88,4,2,"Dinheiro","Sim"]]);
assert.deepEqual(daily.notes,[["ok"]]);

const {privateKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const env={
  GOOGLE_SERVICE_ACCOUNT_EMAIL:"despache@test.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:privateKey.export({type:"pkcs8",format:"pem"}),
  GOOGLE_SHEETS_SPREADSHEET_ID:"sheet-id",
  GOOGLE_SHEETS_TAB_PREFIX:"Financeiro"
};
assert.equal(googleSheetsConfig(env).configured,true);

const calls=[];
const fetchFn=async(url,options={})=>{
  calls.push({url,options});
  if(url.includes("oauth2.googleapis.com"))return new Response(JSON.stringify({access_token:"token"}),{status:200});
  if(url.includes("?fields=sheets.properties"))return new Response(JSON.stringify({sheets:[{properties:{sheetId:7,title:"Financeiro 2026-09"}}]}),{status:200});
  return new Response(JSON.stringify({}),{status:200});
};
const synced=await syncPaymentsToGoogleSheets({month:"2026-09",rows:[],env,fetchFn});
assert.equal(synced.tabTitle,"Financeiro 2026-09");
assert.equal(synced.rows,0);
assert.equal(calls.length,5);
assert.ok(calls.some(call=>call.url.includes(":clear")));
assert.ok(calls.some(call=>call.url.includes("valueInputOption=RAW")));

const dailyCalls=[];
const dailyFetch=async(url,options={})=>{
  dailyCalls.push({url,options});
  if(url.includes("oauth2.googleapis.com"))return new Response(JSON.stringify({access_token:"token"}),{status:200});
  if(url.includes("?fields=properties.title,sheets.properties"))return new Response(JSON.stringify({properties:{title:"Janta"},sheets:[{properties:{sheetId:109,title:"26/09 S"}}]}),{status:200});
  if(url.includes("/values/")&&String(options.method||"GET")==="GET")return new Response(JSON.stringify({values:[["Danielle"]]}),{status:200});
  return new Response(JSON.stringify({}),{status:200});
};
const closed=await syncPaymentDayToGoogleSheets({date:"2026-09-26",shiftCode:"DINNER",rows:[{courier_name:"Danielle",delivery_count:12,base_amount:75,status:"OPEN"}],spreadsheetId:"dinner-id",env,dailyFetch,fetchFn:dailyFetch});
assert.equal(closed.tabTitle,"26/09 S");
assert.equal(closed.rows,1);
assert.ok(dailyCalls.some(call=>call.url.includes("values:batchClear")));
assert.ok(dailyCalls.some(call=>call.url.includes("values:batchUpdate")));
const clearBody=JSON.parse(dailyCalls.find(call=>call.url.includes("values:batchClear")).options.body);
assert.deepEqual(clearBody.ranges,["'26/09 S'!A4:A200","'26/09 S'!E4:J200","'26/09 S'!M4:M200"]);
const updateBody=JSON.parse(dailyCalls.find(call=>call.url.includes("values:batchUpdate")).options.body);
assert.deepEqual(updateBody.data.map(item=>item.range),["'26/09 S'!A4:A4","'26/09 S'!E4:J4","'26/09 S'!M4:M4"]);

const checks={
  admin_month_endpoint:server.includes('app.get("/api/admin/payments/month"'),
  drive_status_endpoint:server.includes('app.get("/api/admin/payments/drive/status"'),
  drive_sync_endpoint:server.includes('app.post("/api/admin/payments/drive/sync"'),
  day_close_endpoint:server.includes('app.post("/api/admin/payments/close-day"'),
  sheet_config_endpoints:server.includes('app.get("/api/admin/payments/sheets"')&&server.includes('app.put("/api/admin/payments/sheets"'),
  close_day_ui:html.includes('id="paymentCloseDay"')&&html.includes('Fechar / atualizar planilha'),
  connection_test_endpoint:server.includes('app.get("/api/admin/payments/sheets/test-connection"'),
  connection_test_ui:html.includes('id="paymentSheetTestConnection"')&&html.includes('Testar conexão Google'),
  monthly_view_initially_hidden:html.includes('<section id="paymentMonthView" class="hidden">'),
  daily_and_monthly_actions:hasUiAction(html,"setPaymentView('daily')")&&hasUiAction(html,"setPaymentView('month')"),
  monthly_sheet_links:html.includes('id="paymentSheetLunchUrl"')&&html.includes('id="paymentSheetDinnerUrl"'),
  render_env:envExample.includes('GOOGLE_SERVICE_ACCOUNT_EMAIL=')&&envExample.includes('GOOGLE_SHEETS_SPREADSHEET_ID=')
};
assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));

// Execute the shipped view switcher: initial daily view, monthly loading,
// tab accessibility and the unsaved-edits confirmation must remain intact.
const elements=new Map();
for(const id of ['paymentDailyView','paymentMonthView','paymentDailyToolbar','paymentDailyTab','paymentMonthTab']){
  const classes=new Set(id==='paymentMonthView'?['hidden']:[]);
  elements.set(id,{classes,attributes:{},classList:{toggle(name,enabled){enabled?classes.add(name):classes.delete(name);}},setAttribute(name,value){this.attributes[name]=value;}});
}
let monthLoads=0,dayLoads=0,confirmation=false;
const context=vm.createContext({$:id=>elements.get(id),paymentActiveView:'daily',paymentMonthState:{month:'',dirty:new Set()},
  courierMonthToday:()=> '2026-10',loadPaymentMonth:month=>{assert.equal(month,'2026-10');monthLoads++;},
  loadPayments:()=>{dayLoads++;},confirm:()=>confirmation});
const viewStart=html.indexOf('function setPaymentView(view){');
assert.ok(viewStart>=0);
vm.runInContext(html.slice(viewStart,html.indexOf('function paymentMonthRowKey',viewStart)),context);
context.setPaymentView('month');
assert.equal(context.paymentActiveView,'month');assert.equal(monthLoads,1);
assert.equal(elements.get('paymentMonthView').classes.has('hidden'),false);
assert.equal(elements.get('paymentDailyView').classes.has('hidden'),true);
assert.equal(elements.get('paymentMonthTab').attributes['aria-selected'],'true');
assert.equal(elements.get('paymentDailyTab').attributes['aria-selected'],'false');
context.paymentMonthState.month='2026-10';context.setPaymentView('month');assert.equal(monthLoads,1);
context.paymentMonthState.dirty.add('synthetic-row');context.setPaymentView('daily');
assert.equal(context.paymentActiveView,'month');assert.equal(dayLoads,0);
confirmation=true;context.setPaymentView('daily');
assert.equal(context.paymentActiveView,'daily');assert.equal(dayLoads,1);
assert.equal(elements.get('paymentMonthView').classes.has('hidden'),true);
assert.equal(elements.get('paymentDailyView').classes.has('hidden'),false);
assert.equal(elements.get('paymentDailyToolbar').classes.has('hidden'),false);
assert.equal(elements.get('paymentDailyTab').attributes['aria-selected'],'true');
assert.equal(elements.get('paymentMonthTab').attributes['aria-selected'],'false');
console.log(JSON.stringify({result:"PASS",checks},null,2));
