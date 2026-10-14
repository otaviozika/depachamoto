// Regressão: ordem das rotas no Express.
// Bug corrigido: GET /api/public/oldman/queue (fila pública da Tagme) era
// registrado depois do catch-all do app (app.get("/{*splat}")) e respondia o
// index.html em vez do JSON; rotas /api/ inexistentes respondiam HTML com 200.
// Regras garantidas aqui:
//  1) o catch-all do app ignora caminhos /api/;
//  2) o 404 JSON de /api é o ÚLTIMO registro de rota, antes só do tratador de erros;
//  3) nenhuma rota é registrada depois do 404 (ela seria inalcançável).
// Uso: node scripts/selftest-api-route-order.js [caminho/do/server.js]
import fs from "node:fs";
import assert from "node:assert/strict";

const file = process.argv[2] || new URL("../server.js", import.meta.url);
const lines = fs.readFileSync(file, "utf8").split("\n");
const find = re => lines.findIndex(l => re.test(l));
const routeRe = /^\s*app\.(get|post|put|patch|delete|all)\(\s*["'`]/;

const catchAll = find(/^app\.get\("\/\{\*splat\}"/);
const notFound = find(/^app\.use\("\/api", \(req, res\) => \{/);
const errorHandler = lines.findLastIndex(l => /^app\.use\(\(err, req, res, next\) => \{/.test(l));
const lastRoute = lines.findLastIndex(l => routeRe.test(l));
const routesAfter404 = lines.map((l, i) => [i + 1, l]).filter(([i, l]) => i - 1 > notFound && routeRe.test(l));

const checks = {
  catchAllExists: catchAll >= 0,
  catchAllSkipsApi: catchAll >= 0 && lines.slice(catchAll, catchAll + 3).join("\n")
    .includes('if (req.path === "/api" || req.path.startsWith("/api/")) return next();'),
  apiNotFoundExists: notFound >= 0,
  apiNotFoundIsJson404: notFound >= 0 && lines.slice(notFound, notFound + 3).join("\n").includes('res.status(404).json({ error: "Rota não encontrada."'),
  apiNotFoundAfterAllRoutes: notFound > lastRoute,
  apiNotFoundBeforeErrorHandler: notFound >= 0 && notFound < errorHandler,
  noRouteAfter404: routesAfter404.length === 0,
  tagmePublicRouteBefore404: find(/^app\.get\("\/api\/public\/oldman\/queue"/) > -1 && find(/^app\.get\("\/api\/public\/oldman\/queue"/) < notFound
};
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Falhou: ${name}${name === "noRouteAfter404" ? " " + JSON.stringify(routesAfter404) : ""}`);
console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
