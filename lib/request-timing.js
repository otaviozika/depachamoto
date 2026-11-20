// Medição de tempo por requisição: tempo total, quantas consultas ao banco e
// quanto tempo elas levaram. Só observa; não altera nenhuma resposta.
//
// - Ações importantes do motoboy (saída, chegada, rota, confirmação) sempre
//   geram uma linha REQUEST_TIMING no log.
// - Qualquer outra rota /api acima de slowMs gera REQUEST_SLOW.
// - Nada de dado pessoal: só método, rota (com parâmetros, nunca valores),
//   status HTTP e números.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const INSTRUMENTED = Symbol("request-timing-instrumented");
const REQUEST_STORE = Symbol("request-timing-store");

export const TRACKED_ROUTES = Object.freeze(new Set([
  "POST /api/courier/depart",
  "POST /api/courier/route/orders",
  "POST /api/courier/dispatches/:id/arrive",
  "POST /api/courier/dispatches/:id/start-return",
  "POST /api/courier/ifood/orders/:orderId/verify-delivery",
  "POST /api/courier/anotaai/orders/:orderId/confirm-delivery",
  "POST /api/courier/pre-departures",
  "POST /api/courier/pre-departures/:id/orders/:orderId/check",
  "GET /api/courier/dashboard",
  "GET /api/courier/ifood/deliveries",
  "GET /api/courier/anotaai/deliveries"
]));

// Caminho sem query e sem valores: trechos com dígitos ou longos (ids, tokens) viram ":x".
export function safePath(url) {
  const path = String(url || "").split(/[?#]/)[0];
  const parts = path.split("/").filter(Boolean).slice(0, 6)
    .map(p => (/\d/.test(p) || p.length > 24 || !/^[\w.-]+$/.test(p)) ? ":x" : p);
  return "/" + parts.join("/");
}

export function createRequestTiming({ slowMs = 1500, log = console.info, tracked = TRACKED_ROUTES, now = () => performance.now() } = {}) {
  const storage = new AsyncLocalStorage();

  // Conta cada consulta feita durante a requisição, inclusive dentro de
  // transações (pool.query também passa por client.query).
  function instrumentClient(client) {
    if (!client || client[INSTRUMENTED]) return;
    client[INSTRUMENTED] = true;
    const original = client.query;
    client.query = function timedQuery(...args) {
      const store = storage.getStore();
      if (!store) return original.apply(this, args);
      const started = now();
      store.queries++;
      const done = () => { store.dbMs += now() - started; };
      const last = args[args.length - 1];
      if (typeof last === "function") {
        args[args.length - 1] = function timedCallback(...cbArgs) { done(); return last.apply(this, cbArgs); };
        return original.apply(this, args);
      }
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") result.then(done, done);
      return result;
    };
  }

  function middleware(req, res, next) {
    const store = { started: now(), queries: 0, dbMs: 0 };
    req[REQUEST_STORE] = store;
    res.once("finish", () => {
      const routePath = req.route?.path;
      const key = routePath ? `${req.method} ${req.baseUrl || ""}${routePath}` : null;
      const totalMs = now() - store.started;
      // Toda resposta 5xx gerada pelo app vira uma linha, com a rota (ou o caminho sem
      // valores) e o código. Se o Render contar uma falha sem linha REQUEST_ERROR, ela
      // não saiu do app.
      if (res.statusCode >= 500) {
        try {
          log(`REQUEST_ERROR ${JSON.stringify({
            route: key || `${req.method} ${safePath(req.originalUrl)}`,
            status: res.statusCode,
            code: typeof res.locals?.errorCode === "string" && res.locals.errorCode ? res.locals.errorCode.slice(0, 60) : null,
            total_ms: Math.round(totalMs),
            db_queries: store.queries
          })}`);
        } catch {}
      }
      const isTracked = key && tracked.has(key);
      const isSlow = !isTracked && totalMs >= slowMs && String(req.originalUrl || "").startsWith("/api/");
      if (!isTracked && !isSlow) return;
      try {
        log(`${isTracked ? "REQUEST_TIMING" : "REQUEST_SLOW"} ${JSON.stringify({
          route: key || `${req.method} (sem rota)`,
          status: res.statusCode,
          total_ms: Math.round(totalMs),
          db_queries: store.queries,
          db_ms: Math.round(store.dbMs)
        })}`);
      } catch {}
    });
    storage.run(store, next);
  }

  // Middlewares baseados em callback (ex.: a leitura da sessão) podem perder o
  // contexto assíncrono; este ponto o retoma antes das rotas.
  function resume(req, res, next) {
    const store = req[REQUEST_STORE];
    if (store && storage.getStore() !== store) return storage.run(store, next);
    next();
  }

  return { middleware, resume, instrumentClient, current: () => storage.getStore() };
}
