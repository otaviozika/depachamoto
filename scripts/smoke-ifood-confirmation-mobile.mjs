import fs from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";

const html=fs.readFileSync(new URL("../public/index.html",import.meta.url));
const server=http.createServer((req,res)=>{
  if(req.url==="/"){
    res.writeHead(200,{"content-type":"text/html"});
    return res.end(html);
  }
  if(req.url==="/socket.io/socket.io.js"){
    res.writeHead(200,{"content-type":"application/javascript"});
    return res.end("window.io=()=>({on(){},connect(){},disconnect(){},connected:false});");
  }
  res.writeHead(req.url==="/api/public/config"?200:401,{"content-type":"application/json"});
  res.end(req.url==="/api/public/config"?'{"environment":"test"}':'{"code":"SESSION_EXPIRED"}');
});

async function smoke(engine,device){
  const browser=await engine.launch();
  try {
    const context=await browser.newContext({...devices[device],serviceWorkers:"block"});
    const page=await context.newPage();
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await context.route("https://**",route=>route.abort());
    const requests=new Map();
    await page.route("**/api/courier/**",async route=>{
      const path=new URL(route.request().url()).pathname;
      requests.set(path,(requests.get(path)||0)+1);
      if(path.endsWith("/verify-delivery")){
        if(path.includes("/valid/"))return route.fulfill({json:{verified:true}});
        if(path.includes("/network/"))return route.abort("failed");
        return route.fulfill({status:422,json:{code:"DELIVERY_CODE_INVALID",error:"Código incorreto."}});
      }
      if(path.endsWith("/confirmation")){
        if(path.includes("/network/"))return route.fulfill({json:{verified:true,state:"CONCLUDED"}});
        return route.fulfill({json:{verified:false,state:"FAILED",retry_allowed:true}});
      }
      return route.fulfill({status:503,json:{error:"Painel indisponível"}});
    });

    await page.goto("http://127.0.0.1:"+server.address().port,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.querySelector("#deliveryConfirmForm")?.onsubmit&&
      document.querySelector("#sessionBoot").classList.contains("hidden"));
    await page.evaluate(()=>{me={role:"courier",id:1}});
    async function open(order,display){
      await page.evaluate(([order,display])=>openDeliveryConfirmModal(order,display),[order,display]);
      await page.locator("#deliveryConfirmCode").fill("1234");
    }
    const modal=page.locator("#deliveryConfirmModal");
    const button=page.locator("#deliveryConfirmBtn");
    const feedback=page.locator("#courierDeliveryFeedback");

    await open("valid","101");
    const dashboard=page.waitForResponse(response=>response.url().endsWith("/api/courier/dashboard"));
    assert.equal(await page.evaluate(()=>{
      const form=document.querySelector("#deliveryConfirmForm");
      for(let i=0;i<5;i++)form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
      return document.querySelector("#deliveryConfirmBtn").disabled;
    }),true);
    await modal.waitFor({state:"hidden"});
    assert.match(await feedback.textContent(),/Entrega #101 confirmada/);
    assert.equal(requests.get("/api/courier/ifood/orders/valid/verify-delivery"),1);
    assert.equal((await dashboard).status(),503);

    await open("invalid","102");
    await button.click();
    await page.waitForFunction(()=>document.querySelector("#deliveryConfirmMsg").textContent.includes("Código incorreto."));
    assert.equal(await button.isEnabled(),true);
    await page.evaluate(()=>closeDeliveryConfirmModal());

    await open("network","103");
    await button.click();
    await modal.waitFor({state:"hidden"});
    assert.match(await feedback.textContent(),/Entrega #103 confirmada/);
    assert.equal(requests.get("/api/courier/ifood/orders/network/verify-delivery"),1);
    assert.equal(requests.get("/api/courier/ifood/orders/network/confirmation"),1);
    assert.deepEqual(errors,[]);
    console.log("IFOOD_CONFIRMATION_MOBILE_PASS",JSON.stringify({engine:engine.name(),device,scenarios:3}));
  } finally {
    await browser.close();
  }
}

await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
  await smoke(chromium,"Pixel 7");
  await smoke(webkit,"iPhone 14");
} finally {
  server.close();
}
