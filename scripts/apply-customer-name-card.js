import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverPath = path.join(root, 'server.js');
const indexPath = path.join(root, 'public', 'index.html');
const swPath = path.join(root, 'public', 'service-worker.js');

let server = fs.readFileSync(serverPath, 'utf8');

if (!server.includes('function buildIfoodCustomerName(payload) {')) {
  const anchor = 'function buildIfoodDeliveryDetails(payload) {';
  if (!server.includes(anchor)) throw new Error('Anchor buildIfoodDeliveryDetails nao encontrado.');
  const helper = `function buildIfoodCustomerName(payload) {\n  const order = parseJsonPayload(payload);\n  const name = order?.customer?.name;\n  return typeof name === "string" ? name.trim() : "";\n}\n\n`;
  server = server.replace(anchor, helper + anchor);
}

if (!server.includes('customer_name: buildIfoodCustomerName(row.payload),')) {
  const anchor = '      navigation: buildIfoodDeliveryDestination(row.payload),';
  if (!server.includes(anchor)) throw new Error('Anchor navigation da entrega nao encontrado.');
  server = server.replace(anchor, `      customer_name: buildIfoodCustomerName(row.payload),\n${anchor}`);
}

if (!server.includes('buildIfoodCustomerName(row.payload)')) {
  throw new Error('Validacao do nome do cliente no backend falhou.');
}

fs.writeFileSync(serverPath, server);

let html = fs.readFileSync(indexPath, 'utf8');

const STYLE_START = '<!-- CUSTOMER NAME CARD START -->';
const STYLE_END = '<!-- CUSTOMER NAME CARD END -->';
const oldStyleStart = html.indexOf(STYLE_START);
if (oldStyleStart >= 0) {
  const oldStyleEnd = html.indexOf(STYLE_END, oldStyleStart);
  if (oldStyleEnd >= 0) html = html.slice(0, oldStyleStart) + html.slice(oldStyleEnd + STYLE_END.length);
}

const styleBlock = `\n${STYLE_START}\n<style id="customerNameCardStyles">\n.delivery-customer-name{\n  margin-top:2px;\n  font-size:14px;\n  font-weight:800;\n  line-height:1.25;\n  color:#111827;\n  max-width:100%;\n  white-space:nowrap;\n  overflow:hidden;\n  text-overflow:ellipsis;\n}\n</style>\n${STYLE_END}\n`;

if (!html.includes('</head>')) throw new Error('Nao foi possivel localizar </head> para o estilo do nome do cliente.');
html = html.replace('</head>', `${styleBlock}\n</head>`);

if (!html.includes("const customerName=String(x?.customer_name||'').trim();")) {
  const anchor = "  const display='#'+escapeHtml(x.display_id||String(x.local_order_number||'').replace(/^#/,''));";
  if (!html.includes(anchor)) throw new Error('Anchor display do card da entrega nao encontrado.');
  html = html.replace(anchor, `${anchor}\n  const customerName=String(x?.customer_name||'').trim();`);
}

if (!html.includes('${customerName?`<div class="delivery-customer-name">${escapeHtml(customerName)}</div>`:\'\'}')) {
  const anchor = '<div class="delivery-order">${display}</div>';
  if (!html.includes(anchor)) throw new Error('Numero do pedido no card da entrega nao encontrado.');
  html = html.replace(anchor, `${anchor}\n        ${'${customerName?`<div class="delivery-customer-name">${escapeHtml(customerName)}</div>`:\'\'}'}`);
}

if (!html.includes('delivery-customer-name') || !html.includes('x?.customer_name')) {
  throw new Error('Validacao do nome do cliente no frontend falhou.');
}

fs.writeFileSync(indexPath, html);

let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "[^"]+";/, 'const CACHE = "despachefull-v3.7.0-customer-name-v1";');
fs.writeFileSync(swPath, sw);

console.log('Nome do cliente adicionado ao card da entrega sem alterar os demais elementos.');
