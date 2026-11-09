import fs from "fs";
import crypto from "crypto";
import assert from "assert/strict";
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
assert.deepEqual(values[0].slice(4,9),["Entregas","Normais","Longas","Valor longa","Valor por entrega"]);
assert.deepEqual(values[1].slice(4,8),[12,12,0,12],"sem LONGE: todas normais, valor longa = 2x");
assert.equal(values[1][15],162);

assert.equal(paymentDaySheetTitle("2026-09-26","LUNCH"),"26/09 S");
assert.equal(paymentDaySheetTitle("2026-10-01","LUNCH"),"01/10 Q");
assert.equal(paymentDaySheetTitle("2026-10-01","DINNER"),"01/10 Q");
assert.equal(paymentDaySheetTitle("2026-09-26","DINNER"),"26/09 S");
const daily=paymentRowsToDailySheetData([{
  courier_name:"Danielle",pix_key:"00123456789",pix_type:"CPF",delivery_count:12,base_amount:75,rain:true,rain_bonus:10,
  adjustment_amount:3,tip_amount:4,discount_amount:2,payment_method:"DINHEIRO",status:"PAID",notes:"ok"
}]);
assert.deepEqual(daily.names,[["Danielle"]]);
assert.deepEqual(daily.pix,[["00123456789","CPF"]]);
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
const dailyRows=[
  {courier_name:"Danielle",pix_key:"00123456789",pix_type:"CPF",delivery_count:12,base_amount:75,status:"OPEN"},
  {courier_name:"Ana",pix_key:"+550000000000",pix_type:"Celular",status:"PAID"},
  {courier_name:"João",status:"OPEN"}
];
let returnedKey=dailyRows[0].pix_key;
let pixHeaders=["CHAVE PIX","TIPO PIX"];
const dailyFetch=async(url,options={})=>{
  dailyCalls.push({url,options});
  if(url.includes("oauth2.googleapis.com"))return new Response(JSON.stringify({access_token:"token"}),{status:200});
  if(url.includes("?fields=properties.title,sheets.properties"))return Response.json({properties:{title:"Janta"},sheets:[{properties:{sheetId:109,title:"26/09 S"}},{properties:{sheetId:110,title:"Cadastro"}}]});
  if(decodeURIComponent(url).includes("C3:D3"))return Response.json({values:[pixHeaders]});
  if(decodeURIComponent(url).includes("A4:D6"))return Response.json({values:[["Danielle","",returnedKey,"CPF"],["Ana","",dailyRows[1].pix_key,"Celular"],["João"]]});
  return new Response(JSON.stringify({}),{status:200});
};
const close=()=>syncPaymentDayToGoogleSheets({date:"2026-09-26",shiftCode:"DINNER",rows:dailyRows,spreadsheetId:"dinner-id",env,fetchFn:dailyFetch});
const closed=await close();
assert.equal(closed.tabTitle,"26/09 S");
assert.equal(closed.rows,3);
const writes=dailyCalls.filter(call=>call.url.endsWith(":batchUpdate"));
assert.equal(writes.length,1,"o fechamento diário deve usar uma gravação atômica");
const updates=JSON.parse(writes[0].options.body).requests.map(request=>request.updateCells);
assert.ok(updates.every(update=>update.range.sheetId===109&&update.fields==="userEnteredValue"));
assert.deepEqual(updates.map(({range:r})=>[r.startRowIndex,r.endRowIndex,r.startColumnIndex,r.endColumnIndex]),
  [[3,4,2,4],[3,200,0,1],[3,200,2,4],[3,200,4,10],[3,200,12,13],[3,200,13,16],[2,3,13,16]],
  "sem longas, preserva fórmulas de status e total");
assert.deepEqual(updates[2].rows[0].values.map(cell=>cell.userEnteredValue),[{stringValue:"00123456789"},{stringValue:"CPF"}]);
assert.deepEqual(updates[2].rows[1].values[0].userEnteredValue,{stringValue:"+550000000000"});
assert.match(updates[2].rows[2].values[0].userEnteredValue.formulaValue,/XLOOKUP\(A6;Cadastro!/);
assert.deepEqual(updates[3].rows[0].values[0].userEnteredValue,{numberValue:12});

returnedKey=123456789;
await assert.rejects(close,{code:"PAYMENT_DAY_VERIFY_FAILED"});
pixHeaders=["OUTRA COLUNA","TIPO PIX"];
dailyCalls.length=0;
await assert.rejects(close,{code:"PAYMENT_DAY_PIX_COLUMNS_INVALID"});
assert.ok(!dailyCalls.some(call=>call.url.endsWith(":batchUpdate")));

const checks={
  admin_month_endpoint:server.includes('app.get("/api/admin/payments/month"'),
  drive_status_endpoint:server.includes('app.get("/api/admin/payments/drive/status"'),
  drive_sync_endpoint:server.includes('app.post("/api/admin/payments/drive/sync"'),
  day_close_endpoint:server.includes('app.post("/api/admin/payments/close-day"'),
  sheet_config_endpoints:server.includes('app.get("/api/admin/payments/sheets"')&&server.includes('app.put("/api/admin/payments/sheets"'),
  close_day_ui:html.includes('id="paymentCloseDay"')&&html.includes('Fechar / atualizar planilha'),
  connection_test_endpoint:server.includes('app.get("/api/admin/payments/sheets/test-connection"'),
  connection_test_ui:html.includes('id="paymentSheetTestConnection"')&&html.includes('Testar conexão Google'),
  no_monthly_access:!html.includes('id="paymentMonthView"')&&!html.includes('onclick="setPaymentView(\'month\')"'),
  monthly_sheet_links:html.includes('id="paymentSheetLunchUrl"')&&html.includes('id="paymentSheetDinnerUrl"'),
  render_env:envExample.includes('GOOGLE_SERVICE_ACCOUNT_EMAIL=')&&envExample.includes('GOOGLE_SHEETS_SPREADSHEET_ID=')
};
assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
console.log(JSON.stringify({result:"PASS",checks},null,2));

