import assert from "node:assert/strict";
import { testGoogleSheetsConnection } from "../lib/google-sheets.js";

const env={
  GOOGLE_SERVICE_ACCOUNT_EMAIL:"test@example.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:"-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----"
};

const originalCryptoSign=(await import("node:crypto")).default?.sign;
const calls=[];
const fakeFetch=async (url,options={})=>{
  calls.push({url:String(url),method:options.method||"GET"});
  if(String(url).includes("oauth2.googleapis.com/token"))return new Response(JSON.stringify({access_token:"token"}),{status:200});
  const titles=Array.from({length:31},(_,i)=>{
    const day=String(i+1).padStart(2,"0"),date=`2026-10-${day}`;
    const letter=["D","S","T","Q","Q","S","S"][new Date(`${date}T12:00:00Z`).getUTCDay()];
    return {properties:{title:`${day}/10 ${letter}`}};
  });
  return new Response(JSON.stringify({properties:{title:"Teste"},sheets:titles}),{status:200});
};

// Use a real temporary RSA key because JWT signing is part of the connection path.
const {generateKeyPairSync}=await import("node:crypto");
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=privateKey.export({type:"pkcs8",format:"pem"}).toString();

const result=await testGoogleSheetsConnection({
  month:"2026-10",
  lunchSpreadsheetId:"lunch",
  dinnerSpreadsheetId:"dinner",
  env,
  fetchFn:fakeFetch
});

assert.equal(result.ok,true);
assert.equal(result.mode,"READ_ONLY");
assert.equal(result.lunch.tabsFound,31);
assert.equal(result.dinner.tabsFound,31);
assert.equal(calls.filter(call=>call.method!=="GET"&&!call.url.includes("oauth2.googleapis.com/token")).length,0);
assert.equal(calls.some(call=>call.url.includes(":batchUpdate")),false);
assert.equal(calls.some(call=>call.url.includes("batchClear")),false);
console.log("PASS: teste de conexão Google é somente leitura e valida as duas planilhas.");
