import fs from "fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const checks = {
  version: server.includes('const VERSION = "3.6.1";'),
  destinationExtractor: server.includes("function buildIfoodDeliveryDestination(payload)"),
  coordinatePriority: server.includes('source: "coordinates"') && server.includes("coordinates.latitude"),
  addressFallback: server.includes('source: "address"') && server.includes("formattedAddress"),
  deliveriesCarryPayload: /o\.last_event_code,o\.last_event_at,o\.payload/.test(server),
  courierResponseIncludesNavigation: server.includes("navigation: buildIfoodDeliveryDestination(row.payload)"),
  wazeUrlBuilder: html.includes("function buildWazeUrl(destination)") && html.includes("https://waze.com/ul?"),
  nullCoordinatesDoNotBecomeZero: html.includes("hasCoordinates&&Number.isFinite(lat)&&Number.isFinite(lng)"),
  motorcycleMode: html.includes("vehicle_type','motorcycle"),
  courierButton: html.includes("Ir para o Waze") && html.includes('class="btn waze"'),
  officialIconAsset: html.includes('src="/waze-icon.png"') && sw.includes("/waze-icon.png"),
  hiddenWithoutDestination: html.includes("if(!url)return '';"),
  addressVisible: html.includes("courierDeliveryAddressHtml(x)")
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
console.log(JSON.stringify({ result: failed.length ? "FAIL" : "PASS", version: "3.6.1", checks }, null, 2));
if (failed.length) process.exit(1);


