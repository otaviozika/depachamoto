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

if (changed) {
  fs.writeFileSync(serverPath, source, "utf8");
  console.log("Login capacity patch aplicado: limite individual por conta + proteção de burst por IP.");
} else {
  console.log("Login capacity patch já estava aplicado.");
}
