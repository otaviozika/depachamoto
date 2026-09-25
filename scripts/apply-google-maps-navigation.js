import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const indexPath = path.join(root, 'public', 'index.html');
const swPath = path.join(root, 'public', 'service-worker.js');

let html = fs.readFileSync(indexPath, 'utf8');

const STYLE_START = '<!-- GOOGLE MAPS NAV START -->';
const STYLE_END = '<!-- GOOGLE MAPS NAV END -->';
const styleStart = html.indexOf(STYLE_START);
if (styleStart >= 0) {
  const styleEnd = html.indexOf(STYLE_END, styleStart);
  if (styleEnd >= 0) html = html.slice(0, styleStart) + html.slice(styleEnd + STYLE_END.length);
}

const styleBlock = `
${STYLE_START}
<style id="googleMapsNavigationStyles">
.delivery-navigation{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  gap:8px;
  width:100%;
}
.delivery-navigation .btn{
  min-height:48px;
  padding:10px 12px;
  border-radius:12px;
  font-size:13px;
  line-height:1.15;
  white-space:nowrap;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
}
.delivery-navigation .btn.waze{
  background:#2f80ed;
  color:#fff;
  border:1px solid #2f80ed;
  box-shadow:none;
}
.delivery-navigation .btn.google-maps{
  background:#111827;
  color:#f8fafc;
  border:1px solid #475569;
  box-shadow:none;
}
.delivery-navigation .btn.google-maps:hover{
  background:#172033;
  border-color:#64748b;
}
.delivery-navigation .waze-mark,
.delivery-navigation .google-maps-mark{
  width:27px;
  height:27px;
  min-width:27px;
  border-radius:8px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
}
.delivery-navigation .waze-mark{background:#fff}
.delivery-navigation .google-maps-mark{background:transparent}
.delivery-navigation .waze-mark img{width:22px;height:22px;display:block;object-fit:contain}
.delivery-navigation .google-maps-mark img{width:25px;height:25px;display:block;object-fit:contain}
@media (max-width:390px){
  .delivery-navigation{gap:7px}
  .delivery-navigation .btn{
    min-height:46px;
    padding:9px 8px;
    font-size:12px;
    gap:6px;
  }
  .delivery-navigation .waze-mark,
  .delivery-navigation .google-maps-mark{
    width:24px;
    height:24px;
    min-width:24px;
  }
  .delivery-navigation .waze-mark img{width:20px;height:20px}
  .delivery-navigation .google-maps-mark img{width:23px;height:23px}
}
</style>
${STYLE_END}
`;

if (!html.includes('</head>')) throw new Error('Nao foi possivel localizar </head> para inserir estilos do Google Maps.');
html = html.replace('</head>', `${styleBlock}\n</head>`);

if (!html.includes('function buildGoogleMapsUrl(destination){')) {
  const anchor = 'function courierDeliveryAddressHtml(x){';
  if (!html.includes(anchor)) throw new Error('Anchor courierDeliveryAddressHtml nao encontrado.');
  const buildGoogleMaps = `
function buildGoogleMapsUrl(destination){
  if(!destination)return '';
  const rawLat=destination.latitude;
  const rawLng=destination.longitude;
  const hasCoordinates=rawLat!==null&&rawLat!==undefined&&rawLat!==''&&rawLng!==null&&rawLng!==undefined&&rawLng!=='';
  let target='';
  if(hasCoordinates){
    const lat=Number(rawLat);
    const lng=Number(rawLng);
    if(Number.isFinite(lat)&&Number.isFinite(lng))target=\`${'${lat}'},${'${lng}'}\`;
  }
  if(!target)target=String(destination.address||'').trim();
  if(!target)return '';
  const params=new URLSearchParams();
  params.set('api','1');
  params.set('destination',target);
  params.set('travelmode','driving');
  return \`https://www.google.com/maps/dir/?${'${params.toString()}'}\`;
}

`;
  html = html.replace(anchor, buildGoogleMaps + anchor);
}

if (!html.includes('function courierDeliveryGoogleMapsButton(x){')) {
  const anchor = 'function courierDeliveryRow(x){';
  if (!html.includes(anchor)) throw new Error('Anchor courierDeliveryRow nao encontrado.');
  const mapsButton = `
function courierDeliveryGoogleMapsButton(x){
  const url=buildGoogleMapsUrl(x?.navigation);
  if(!url)return '';
  return \`<a class="btn google-maps" href="${'${escapeHtml(url)}'}" target="_blank" rel="noopener"><span class="google-maps-mark"><img src="/google-maps-icon.svg" alt="" loading="lazy"></span> Ir no Google Maps</a>\`;
}

function courierDeliveryNavigationButtons(x){
  const waze=courierDeliveryWazeButton(x);
  const maps=courierDeliveryGoogleMapsButton(x);
  if(!waze&&!maps)return '';
  return \`<div class="delivery-navigation">${'${waze}'}${'${maps}'}</div>\`;
}

`;
  html = html.replace(anchor, mapsButton + anchor);
}

const oldActions = '<div class="delivery-actions">${courierDeliveryWazeButton(x)}${btn}</div>';
const newActions = '<div class="delivery-actions">${courierDeliveryNavigationButtons(x)}${btn}</div>';
if (html.includes(oldActions)) {
  html = html.replace(oldActions, newActions);
} else if (!html.includes(newActions)) {
  throw new Error('Bloco de acoes da entrega nao encontrado para adicionar Google Maps.');
}

if (!html.includes('buildGoogleMapsUrl(destination)') || !html.includes('Ir no Google Maps') || !html.includes('courierDeliveryNavigationButtons(x)')) {
  throw new Error('Validacao do patch Google Maps falhou.');
}

fs.writeFileSync(indexPath, html);

let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-courier-customer-v2";');
if (!sw.includes('"/google-maps-icon.svg"')) {
  if (sw.includes('"/waze-icon.png"')) {
    sw = sw.replace('"/waze-icon.png"', '"/waze-icon.png", "/google-maps-icon.svg"');
  } else {
    throw new Error('Nao foi possivel adicionar o icone do Google Maps ao cache do PWA.');
  }
}
fs.writeFileSync(swPath, sw);

console.log('Google Maps adicionado ao card de entrega ao lado do Waze.');
