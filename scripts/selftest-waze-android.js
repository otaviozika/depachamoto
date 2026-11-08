/**
 * Static test of the real production Waze navigation functions.
 * Runs without devices, credentials or external calls.
 * Native-app opening still requires a physical Android verification.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const required=["courierNavigationTarget","buildWazeUrl","courierDeliveryWazeButton"];
function extract(name){
  const start=html.indexOf("function "+name+"(");
  assert.ok(start>=0,"Missing function "+name);
  const end=html.indexOf("\n}\n",start);
  assert.ok(end>start,"Incomplete function "+name);
  return html.slice(start,end+2);
}
const code=required.map(extract).join("\n");
function run(userAgent,destination){
  const ctx={navigator:{userAgent},URLSearchParams,escapeHtml:(text)=>String(text).replaceAll("&","&amp;").replaceAll('"',"&quot;")};
  vm.createContext(ctx);
  vm.runInContext(code,ctx,{timeout:1000});
  const url=ctx.buildWazeUrl(destination);
  const button=ctx.courierDeliveryWazeButton({navigation:destination});
  return {url,button};
}
const pin={latitude:-23.625,longitude:-46.556,address:"Rua Ficticia 123",prefer_coordinates:true};
const userAgents={
  samsung:"Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  chrome:"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36",
  iphone:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1"
};
let count=0;
for(const browser of ["samsung","chrome","iphone"]){
  const {url,button}=run(userAgents[browser],pin);
  const parsed=new URL(url);
  const android=browser!=="iphone";
  assert.equal(parsed.protocol,android?"waze:":"https:");
  assert.equal(parsed.searchParams.get("ll"),"-23.625,-46.556");
  assert.equal(parsed.searchParams.get("navigate"),"yes");
  assert.equal(parsed.searchParams.get("vehicle_type"),"motorcycle");
  assert.equal(parsed.searchParams.get("utm_source"),"despachefull");
  if(android){
    assert.equal(parsed.hostname,"");
    assert.ok(!button.includes('target="_blank"'),"Native app must not open a blank browser tab");
    assert.ok(!button.includes("waze.com"),"Android must not open the Waze landing page");
  }else{
    assert.equal(parsed.hostname,"waze.com");
    assert.ok(button.includes('target="_blank" rel="noopener"'));
  }
  assert.ok(button.includes('class="btn waze"'));
  count++;
}
const address={address:"Rua Santa Clara, 321, Sao Caetano do Sul",source:"address",address_complete:true};
const a=run(userAgents.samsung,address),b=run(userAgents.iphone,address);
assert.equal(new URL(a.url).searchParams.get("q"),address.address);
assert.equal(new URL(b.url).searchParams.get("q"),address.address);
assert.ok(!new URL(a.url).searchParams.has("ll"),"Address mode should not silently substitute an unknown pin");
count++;
const missing=run(userAgents.samsung,{address:"",latitude:null,longitude:null});
assert.equal(missing.url,"");
assert.equal(missing.button,"");
count++;
console.log("WAZE_ANDROID_LINK_REGRESSION_PASS "+JSON.stringify({
  scenarios:count,android:["Samsung Internet","Chrome"],iosPreserved:true,
  directScheme:"waze://",origin:"same tap",navigationPinPreserved:true,
  physicalAppLaunchStillPending:true
}));
