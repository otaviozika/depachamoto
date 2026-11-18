// CSP em modo relatório: o servidor envia SOMENTE Content-Security-Policy-Report-Only
// (nada é bloqueado), os relatórios são limpos (sem query string/fragmento),
// deduplicados e limitados, e o resumo é exclusivo do admin.
import fs from "node:fs";
import assert from "node:assert/strict";
import helmet from "helmet";
import {
  CSP_REPORT_PATH, CSP_REPORT_ONLY_DIRECTIVES, createCspReportStore, helmetCspReportOnly, normalizeCspReports
} from "../lib/csp.js";

let count = 0;
const test = (name, fn) => { fn(); count++; console.log("PASS", name); };

function headersFrom(middleware) {
  const headers = {};
  middleware({}, { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, removeHeader: k => { delete headers[k.toLowerCase()]; } }, () => {});
  return headers;
}

test("helmet envia só o cabeçalho Report-Only, nunca a política aplicada", () => {
  const headers = headersFrom(helmet({ contentSecurityPolicy: helmetCspReportOnly() }));
  assert.ok(headers["content-security-policy-report-only"], "cabeçalho de relatório presente");
  assert.equal(headers["content-security-policy"], undefined, "nenhuma política aplicada");
  assert.match(headers["content-security-policy-report-only"], /report-uri \/api\/csp-report/);
  assert.doesNotMatch(headers["content-security-policy-report-only"], /upgrade-insecure-requests/, "sem diretivas que mudem comportamento");
});

test("política cobre o que o app usa hoje", () => {
  const d = CSP_REPORT_ONLY_DIRECTIVES;
  assert.ok(d["script-src"].includes("'unsafe-inline'") && d["script-src-attr"].includes("'unsafe-inline'"), "handlers onclick e scripts inline");
  assert.ok(d["script-src"].includes("https://cdnjs.cloudflare.com"), "biblioteca de QR Code");
  assert.ok(d["img-src"].includes("https://tile.openstreetmap.org"), "mapa da regra LONGE");
  assert.ok(d["img-src"].includes("data:"), "QR Code gerado como imagem data:");
  assert.ok(d["style-src"].includes("https://fonts.googleapis.com") && d["font-src"].includes("https://fonts.gstatic.com"), "fontes da página Old Man");
  assert.deepEqual(d["object-src"], ["'none'"]);
  // Cada origem externa citada nas páginas precisa estar na política (ou ser só um link).
  const pages = ["../public/index.html", "../public/oldman/index.html", "../public/login-desktop.css", "../public/courier-dark.css"]
    .map(f => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  const linkOnly = new Set(["https://drive.google.com", "https://www.google.com", "https://waze.com", "https://www.instagram.com"]);
  const allowed = new Set(Object.values(d).flat());
  const origins = new Set([...pages.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)].map(m => m[0].toLowerCase()));
  for (const origin of origins) {
    if (linkOnly.has(origin)) continue;
    assert.ok(allowed.has(origin), `origem externa fora da política: ${origin}`);
  }
});

test("relatório report-uri é limpo: sem query string, fragmento ou campos extras", () => {
  const [r] = normalizeCspReports({ "csp-report": {
    "document-uri": "https://depachamoto.onrender.com/reset?token=SEGREDO#x",
    "violated-directive": "img-src https://a.test",
    "effective-directive": "img-src",
    "blocked-uri": "https://tracker.test/p.png?id=123&email=a@b.c",
    "source-file": "https://depachamoto.onrender.com/app.js?v=9",
    "line-number": 42, "original-policy": "x".repeat(5000), "script-sample": "alert(document.cookie)"
  } });
  assert.deepEqual(r, { directive: "img-src", blocked: "https://tracker.test/p.png", page: "/reset", source: "https://depachamoto.onrender.com/app.js", line: 42, disposition: "report" });
  assert.doesNotMatch(JSON.stringify(r), /SEGREDO|email|cookie/);
});

test("formato da Reporting API e entradas inválidas", () => {
  const reports = normalizeCspReports([
    { type: "csp-violation", body: { documentURL: "https://h/x?y", effectiveDirective: "script-src-elem", blockedURL: "inline", lineNumber: 3 } },
    { type: "deprecation", body: { id: "x" } }
  ]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].blocked, "inline");
  assert.equal(reports[0].page, "/x");
  assert.deepEqual(normalizeCspReports(null), []);
  assert.deepEqual(normalizeCspReports({ "csp-report": "texto" }), []);
  assert.deepEqual(normalizeCspReports("lixo"), []);
  assert.equal(normalizeCspReports(Array.from({ length: 100 }, () => ({ type: "csp-violation", body: {} }))).length, 20, "no máximo 20 por envio");
});

test("resumo deduplica, conta e tem limite de chaves", () => {
  const logs = [];
  const store = createCspReportStore({ maxKeys: 2, log: m => logs.push(m) });
  const base = { directive: "img-src", blocked: "https://a.test/x.png", page: "/", source: "", line: null, disposition: "report" };
  assert.equal(store.record(base), true);
  assert.equal(store.record(base), false);
  assert.equal(store.record({ ...base, blocked: "https://b.test/y.png" }), true);
  assert.equal(store.record({ ...base, blocked: "https://c.test/z.png" }), false, "acima do limite é descartado");
  const s = store.summary();
  assert.equal(s.unique, 2); assert.equal(s.total, 3); assert.equal(s.dropped, 1);
  assert.equal(s.items[0].count, 2);
  assert.equal(logs.length, 2, "loga só a primeira ocorrência de cada violação");
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
test("servidor usa a política em modo relatório e protege o endpoint", () => {
  assert.ok(server.includes("app.use(helmet({ contentSecurityPolicy: helmetCspReportOnly() }));"));
  assert.ok(!server.includes("contentSecurityPolicy: false"));
  assert.equal(CSP_REPORT_PATH, "/api/csp-report");
  const route = server.slice(server.indexOf("app.post(CSP_REPORT_PATH"), server.indexOf('app.get("/api/live"'));
  assert.match(route, /cspReportLimiter/, "limite por IP");
  assert.match(route, /limit: "16kb"/, "corpo pequeno");
  assert.match(route, /res\.status\(204\)\.end\(\)/, "resposta vazia, sempre");
  assert.match(route, /app\.get\("\/api\/admin\/csp-reports", auth, adminOnly/, "resumo só para admin");
});

console.log(JSON.stringify({ result: "PASS", feature: "csp_report_only", cases: count }));
