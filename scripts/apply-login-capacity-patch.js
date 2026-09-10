import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, "..", "server.js");

let source = fs.readFileSync(serverPath, "utf8");
let changed = false;

// Usa o helper oficial do express-rate-limit para normalizar IPv4/IPv6.
if (source.includes('import rateLimit from "express-rate-limit";')) {
  source = source.replace(
    'import rateLimit from "express-rate-limit";',
    'import rateLimit, { ipKeyGenerator } from "express-rate-limit";'
  );
  changed = true;
}

// Não deixa dezenas de motoboys no mesmo Wi-Fi compartilharem o mesmo contador.
// Mantém uma proteção ampla por IP contra flood e uma proteção separada por conta.
if (!source.includes("const loginIpBurstLimiter = rateLimit({")) {
  const limiterPattern = /const loginLimiter = rateLimit\(\{[\s\S]*?\n\}\);\n\nconst registrationLimiter/;
  const replacement = `const loginIpBurstLimiter = rateLimit({
  // Proteção contra flood: permite uma operação inteira entrar ao mesmo tempo.
  windowMs: Number(process.env.LOGIN_BURST_WINDOW_MS || 60 * 1000),
  limit: Number(process.env.LOGIN_BURST_LIMIT || 300),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: req => !!process.env.LOAD_TEST_KEY &&
    req.get("x-load-test-key") === process.env.LOAD_TEST_KEY,
  message: { error: "Muitos acessos simultâneos. Aguarde alguns segundos e tente novamente." }
});

const loginLimiter = rateLimit({
  // Falhas são controladas por conta + IP, não apenas pelo IP da hamburgueria.
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.LOGIN_RATE_LIMIT || 20),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req => {
    const ip = ipKeyGenerator(req.ip);
    const username = String(req.body?.username || "").trim().toLowerCase().slice(0, 120);
    if (username) return \`login:\${username}:\${ip}\`;
    if (req.session?.user?.id) return \`session:\${req.session.user.id}:\${ip}\`;
    return \`ip:\${ip}\`;
  },
  skip: req => !!process.env.LOAD_TEST_KEY &&
    req.get("x-load-test-key") === process.env.LOAD_TEST_KEY,
  message: { error: "Muitas tentativas de login para esta conta. Confira usuário e senha ou aguarde alguns minutos." }
});

const registrationLimiter`;

  if (!limiterPattern.test(source)) {
    throw new Error("Bloco loginLimiter não encontrado em server.js; patch abortado para evitar alteração insegura.");
  }

  source = source.replace(limiterPattern, replacement);
  changed = true;
}

const oldLoginRoute = 'app.post("/api/login", loginLimiter, asyncRoute(';
const newLoginRoute = 'app.post("/api/login", loginIpBurstLimiter, loginLimiter, asyncRoute(';
if (source.includes(oldLoginRoute)) {
  source = source.replace(oldLoginRoute, newLoginRoute);
  changed = true;
}

if (!source.includes(newLoginRoute)) {
  throw new Error("Rota /api/login não contém as proteções esperadas; patch abortado.");
}

// Corrige classificação de pedidos iFood com dados locais incompletos.
// Se order_type/delivered_by ainda não vieram no polling, consulta o pedido diretamente
// no iFood, atualiza o banco e só então decide se é DELIVERY, TAKEOUT ou entrega parceira.
if (!source.includes("async function refreshIfoodOrderClassificationForDeparture(")) {
  const marker = `function plainLocalOrderNumber(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

async function inspectIfoodOrdersForDeparture(orders) {`;

  const helper = `function plainLocalOrderNumber(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

async function refreshIfoodOrderClassificationForDeparture(row) {
  const orderType = String(row?.order_type || "").trim().toUpperCase();
  const deliveredBy = String(row?.delivered_by || "").trim().toUpperCase();
  const needsRefresh = !["DELIVERY","TAKEOUT"].includes(orderType) ||
    (orderType === "DELIVERY" && !["MERCHANT","IFOOD"].includes(deliveredBy));

  if (!needsRefresh || !row?.order_id || !ifoodConfigured()) return row;

  try {
    const details = await fetchIfoodOrderDetails(row.order_id);
    await upsertIfoodOrderFromDetails(details, {
      orderId: row.order_id,
      merchantId: row.merchant_id || null
    });

    const refreshed = (await pool.query(\`
      SELECT
        o.order_id,o.display_id,o.merchant_id,o.status,o.order_type,o.category,
        o.sales_channel,o.delivered_by,o.is_test,o.order_created_at,
        o.last_event_code,o.last_event_at,
        l.dispatch_id AS linked_dispatch_id,
        d.status AS linked_dispatch_status,
        u.name AS linked_courier_name
      FROM ifood_orders o
      LEFT JOIN ifood_dispatch_links l ON l.ifood_order_id=o.order_id
      LEFT JOIN dispatches d ON d.id=l.dispatch_id
      LEFT JOIN users u ON u.id=d.courier_id
      WHERE o.order_id=$1
      LIMIT 1
    \`, [String(row.order_id)])).rows[0];

    return refreshed || row;
  } catch (err) {
    console.error(\`iFood classification refresh failed [\${row.order_id}]:\`, ifoodSafeError(err));
    return row;
  }
}

async function inspectIfoodOrdersForDeparture(orders) {`;

  if (!source.includes(marker)) {
    throw new Error("Ponto de inserção da correção iFood não encontrado; patch abortado.");
  }
  source = source.replace(marker, helper);
  changed = true;
}

const oldRowSelection = `    const row = current[0] || candidates[0];
    const status = canonicalIfoodOrderStatus(row.status);`;
const newRowSelection = `    let row = current[0] || candidates[0];
    row = await refreshIfoodOrderClassificationForDeparture(row);
    const status = canonicalIfoodOrderStatus(row.status);`;
if (source.includes(oldRowSelection)) {
  source = source.replace(oldRowSelection, newRowSelection);
  changed = true;
}

const oldTypeBlock = `    if (String(row.order_type || "").toUpperCase() !== "DELIVERY") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_NOT_DELIVERY",
        message: "Esse pedido iFood não é uma entrega."
      });
      continue;
    }`;

const newTypeBlock = `    const orderType = String(row.order_type || "").trim().toUpperCase();
    if (orderType === "TAKEOUT") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_TAKEOUT",
        message: "Esse pedido é retirada e não pode ser despachado por motoboy."
      });
      continue;
    }

    if (orderType !== "DELIVERY") {
      blocked.push({
        order_number: localOrder,
        order_id: row.order_id,
        code: "IFOOD_ORDER_TYPE_UNKNOWN",
        message: "Não foi possível identificar o tipo deste pedido no iFood. Atualize e tente novamente."
      });
      continue;
    }`;

if (source.includes(oldTypeBlock)) {
  source = source.replace(oldTypeBlock, newTypeBlock);
  changed = true;
}

if (!source.includes("refreshIfoodOrderClassificationForDeparture(row)")) {
  throw new Error("Correção de classificação iFood não foi aplicada; patch abortado.");
}

if (changed) {
  fs.writeFileSync(serverPath, source, "utf8");
  console.log("Patches aplicados: login de alta concorrência + classificação segura de pedidos iFood.");
} else {
  console.log("Patches de login e classificação iFood já estavam aplicados.");
}
