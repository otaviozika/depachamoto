// The pilot controls are committed directly to public/index.html.
// Keep prestart idempotent and fail loudly if a later HTML refactor drops the controls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const html=fs.readFileSync(path.join(root,"public","index.html"),"utf8");
const required=[
  "function adminSetIncidentPilot(enabled)",
  "if(courierPreDeparture?.incident_feature?.enabled!==true)return '';",
  "if(courierPreDeparture?.incident_feature?.enabled!==true)return alert(",
  "id=\"deliveryIncidentAdmin\"",
  "id=\"incidentPilotCourier\""
];
// The select lives in a dynamic template; its markup still exists as a literal.
const absent=required.filter(marker=>!html.includes(marker));
if(absent.length){
  console.error("Delivery incident pilot UI contract is incomplete:",absent.join(", "));
  process.exit(1);
}
console.log("Delivery incident pilot UI already present; no prestart mutation required.");
