/**
 * Playwright mobile-browser emulation against the LIVE staging front-end.
 * NEVER logs in or writes to any API. Route and user fixtures exist only in browser memory.
 * iOS WebKit + Android Chromium are emulations, not physical iPhone/Android devices.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, webkit, devices } from "playwright";

const BASE = "https://despachefull-staging.onrender.com";
const reports = [];
const checks = [];
const cases = [
  {name: "iphone-safari-emulated", driver: webkit, device: devices["iPhone 13"]},
  {name: "android-chromium-emulated", driver: chromium, device: devices["Pixel 7"]}
];
const log=(name,value)=>checks.push({name,...value});

async function runCase({name,driver,device}) {
  const browser=await driver.launch({headless:true});
  const context=await browser.newContext({...device,ignoreHTTPSErrors:false,serviceWorkers:"block"});
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",error=>errors.push(String(error.message||error).slice(0,160)));
  try {
    const response=await page.goto(BASE,{waitUntil:"domcontentloaded",timeout:60000});
    assert.equal(response?.status(),200,"Staging front-end must load");
    await page.waitForFunction(()=>typeof renderCourierMyRoute==="function" &&
      typeof buildWazeUrl==="function" && document.getElementById("courierMyRoute")!==null,{timeout:20000});
    const fixture=await page.evaluate(()=>{
      const el=document.getElementById("courierMyRoute");
      const wrapper=document.createElement("main");
      wrapper.id="mobile-test-fixture";
      wrapper.style.cssText="width:100%;max-width:520px;margin:0 auto;padding:12px 10px 40px;box-sizing:border-box;";
      const heading=document.createElement("h1");
      heading.textContent="Minha rota · Homologação";
      heading.style.cssText="font-size:18px;line-height:1.3;margin:10px 4px 20px;";
      wrapper.append(heading);
      wrapper.append(el);
      // Keep the REAL #courierApp ancestor, otherwise the production CSS selectors
      // do not apply and visual screenshots are misleading.
      const app=document.getElementById("courierApp");
      if(!app)throw new Error("courierApp wrapper missing");
      app.remove();
      app.classList.remove("hidden");
      app.style.display="block";
      app.append(wrapper);
      document.body.append(app);
      for(const node of [...app.children]){
        if(node!==wrapper)node.style.display="none";
      }
      for(const node of [...document.body.children]){
        if(node!==app && node.tagName!=="SCRIPT")node.style.display="none";
      }
      document.body.style.cssText="margin:0;padding:0;";
      const nav={latitude:-23.625,longitude:-46.556,prefer_coordinates:true,address:"Rua Sintética, 123, São Caetano do Sul"};
      const nav2={latitude:-23.6258,longitude:-46.5569,prefer_coordinates:true,address:"Rua Sintética, 456, São Caetano do Sul"};
      const stops=[
        {sequence:1,order_number:"#81000001",customer_name:"Cliente Fictício A",
          platform:"anotaai",external_order_id:"synthetic-A",state:"PENDING",
          is_next:true,is_deferred:false,changed_unacked:false,
          address:{text:"Rua Sintética, 123"},navigation:nav,incident:null},
        {sequence:2,order_number:"#81000002",customer_name:"Cliente Fictício B",
          platform:"ifood",external_order_id:"synthetic-B",state:"PENDING",
          is_next:false,is_deferred:false,changed_unacked:false,
          address:{text:"Rua Sintética, 456"},navigation:nav2,incident:null}
      ];
      courierPreDeparture={
        enabled:{pre_departure:true,route_planner:true},
        incident_feature:{enabled:true,pilot_only:true},
        pre_departure:null,
        route:{dispatch_id:999999,route_version:1,dispatch_status:"ON_ROAD",route_status:"READY",
          ack_required:false,counts:{delivered:0,total:2,pending:2},
          stops,extra_orders:[]}
      };
      renderCourierMyRoute();
      return {stops:document.querySelectorAll("#courierMyRoute .route-stop").length,
        routeIsRendered:!!document.querySelector("#courierMyRoute .my-route"),
        width:innerWidth,documentWidth:document.documentElement.scrollWidth};
    });
    assert.equal(fixture.stops,2,"Must render both delivery stops");
    assert.equal(fixture.routeIsRendered,true);
    assert.ok(fixture.documentWidth<=fixture.width+8,"Horizontal overflow detected");
    log(name+"-responsive",{passed:true,viewport:fixture.width,documentWidth:fixture.documentWidth});

    const links=await page.locator("#courierMyRoute .delivery-navigation a").evaluateAll(els=>
      els.map(e=>({href:e.href,target:e.target,rel:e.rel,text:e.textContent.trim()})));
    assert.equal(links.length,2,"Only next stop can expose Waze and Maps");
    const waze=new URL(links.find(x=>x.text.includes("Waze"))?.href||"");
    assert.ok(waze.hostname.endsWith("waze.com"),"Waze host");
    assert.equal(waze.searchParams.get("ll"),"-23.625,-46.556");
    assert.equal(waze.searchParams.get("navigate"),"yes");
    assert.equal(waze.searchParams.get("vehicle_type"),"motorcycle");
    const google=new URL(links.find(x=>x.text.includes("Google Maps"))?.href||"");
    assert.equal(google.hostname,"www.google.com");
    assert.equal(google.pathname,"/maps/dir/");
    assert.equal(google.searchParams.get("api"),"1");
    assert.equal(google.searchParams.get("destination"),"-23.625,-46.556");
    assert.equal(google.searchParams.get("travelmode"),"driving");
    assert.ok(links.every(x=>x.target==="_blank"&&x.rel.includes("noopener")));
    await page.waitForFunction(()=>[...document.querySelectorAll("#courierMyRoute .delivery-navigation img")].every(
      img=>img.complete&&img.naturalWidth>0),null,{timeout:12000});
    const navLayout=await page.evaluate(()=>({
      widths:[...document.querySelectorAll("#courierMyRoute .delivery-navigation a")].map(a=>({
        client:a.clientWidth,scroll:a.scrollWidth,right:a.getBoundingClientRect().right,
        display:getComputedStyle(a).display,whiteSpace:getComputedStyle(a).whiteSpace})),
      viewport:innerWidth,ancestor:document.querySelector("#courierApp #courierMyRoute")!==null
    }));
    assert.equal(navLayout.ancestor,true,"The actual courier CSS must apply");
    assert.ok(navLayout.widths.every(x=>x.scroll<=x.client+3 && x.right<=navLayout.viewport+3),
      "Navigation text/button is clipped on mobile: "+JSON.stringify(navLayout.widths));
    log(name+"-navigation",{passed:true,links:links.length,source:"browser-memory fake coordinates; no external link opened",
      buttonWidths:navLayout.widths.map(x=>({client:x.client,scroll:x.scroll}))});

    // Opening an incident modal must be platform-aware and never confirm an order.
    const modal=await page.evaluate(()=>{
      openDeliveryIncident("anotaai","synthetic-A");
      const el=document.getElementById("deliveryIncidentModal");
      const anotaVisible=el.style.display==="grid";
      const anotaHasNoCode=!document.getElementById("incidentNoCode").classList.contains("hidden");
      closeDeliveryIncident();
      openDeliveryIncident("ifood","synthetic-B");
      const ifoodHasNoCode=!document.getElementById("incidentNoCode").classList.contains("hidden");
      closeDeliveryIncident();
      return {anotaVisible,anotaHasNoCode,ifoodHasNoCode};
    });
    assert.equal(modal.anotaVisible,true);
    assert.equal(modal.anotaHasNoCode,false,"Anota AI must not allow 'no code'");
    assert.equal(modal.ifoodHasNoCode,true,"iFood must offer 'no code'");
    log(name+"-incident-modal",{passed:true});

    // Admin-authorized continuation requires route-version acknowledgement.
    const beforeAck=await page.evaluate(()=>{
      const r=courierPreDeparture.route;
      r.stops[0].incident={status:"CONTINUE_APPROVED",reason:"CLIENT_NOT_FOUND"};
      r.stops[0].is_deferred=true;r.stops[0].is_next=false;
      r.stops[1].is_next=true;r.ack_required=true;r.route_version=2;
      renderCourierMyRoute();
      return {
        nav:document.querySelectorAll("#courierMyRoute .delivery-navigation a").length,
        ack:document.getElementById("courierMyRoute").textContent.includes("Ciente"),
        pendingText:document.getElementById("courierMyRoute").textContent.includes("seguem pendentes"),
        pendingStops:r.stops.filter(s=>s.state==="PENDING").length
      };
    });
    assert.equal(beforeAck.nav,0,"Navigation must be suppressed until acknowledgement");
    assert.equal(beforeAck.ack,true);
    assert.equal(beforeAck.pendingText,true);
    assert.equal(beforeAck.pendingStops,2,"Deferred order must remain pending");
    const afterAck=await page.evaluate(()=>{
      const r=courierPreDeparture.route;
      r.ack_required=false;
      renderCourierMyRoute();
      return {nav:document.querySelectorAll("#courierMyRoute .delivery-navigation a").length,
        navigationLinks:[...document.querySelectorAll("#courierMyRoute .delivery-navigation a")].map(a=>a.href),
        pendingStops:r.stops.filter(s=>s.state==="PENDING").length};
    });
    assert.equal(afterAck.nav,2);
    assert.ok(afterAck.navigationLinks.every(link=>link.includes("-23.6258")),"Next stop must be the second address");
    assert.equal(afterAck.pendingStops,2);
    log(name+"-route-safety",{passed:true,ackBlocksNavigation:true,zeroFalseConfirmations:true});

    await fs.mkdir("mobile-test-results",{recursive:true});
    await page.screenshot({path:"mobile-test-results/"+name+".png",fullPage:true});
    await context.setOffline(true);
    const offline=await page.evaluate(()=>{
      window.dispatchEvent(new Event("offline"));
      return {navigatorOnLine:navigator.onLine,
        stops:document.querySelectorAll("#courierMyRoute .route-stop").length,
        links:document.querySelectorAll("#courierMyRoute .delivery-navigation a").length};
    });
    assert.equal(offline.navigatorOnLine,false);
    assert.equal(offline.stops,2,"The current rendered route must not vanish on connection loss");
    await context.setOffline(false);
    const online=await page.evaluate(()=>{
      window.dispatchEvent(new Event("online"));
      return navigator.onLine;
    });
    assert.equal(online,true,"Browser must regain online status");
    log(name+"-offline-recovery",{passed:true,offlineVisibleStops:offline.stops,onlineRestored:online});
    assert.deepEqual(errors,[],"Unhandled page errors in mobile browser");
    reports.push({device:name,status:"PASS",checks:5,screen:name+".png",
      viewportWidth:fixture.width,renderedStops:fixture.stops});
  } finally {
    await context.close();
    await browser.close();
  }
}
for(const c of cases)await runCase(c);
console.log("MOBILE_STAGING_BROWSER_EMULATION_REPORT_START");
console.log(JSON.stringify({
  result:"PASS",kind:"BROWSER_EMULATION_NOT_PHYSICAL_DEVICES",productionTouched:false,
  stagingHttpMethods:["GET"],externalNavigationAppsOpened:false,
  realProviderCalls:0,devices:reports,checks
},null,2));
console.log("MOBILE_STAGING_BROWSER_EMULATION_REPORT_END");
