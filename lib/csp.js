// Content Security Policy em MODO RELATÓRIO (Content-Security-Policy-Report-Only).
//
// Nada é bloqueado: o navegador só avisa, em /api/csp-report, o que esta
// política bloquearia. Serve para validar a política com o uso real antes de
// qualquer decisão de aplicá-la de verdade.
//
// A política descreve o que o app usa hoje: scripts e estilos inline (há
// handlers onclick em toda a interface), o script de QR Code do cdnjs, mapas do
// OpenStreetMap, fontes do Google e as imagens externas da página Old Man.

export const CSP_REPORT_PATH = "/api/csp-report";

export const CSP_REPORT_ONLY_DIRECTIVES = Object.freeze({
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
  "script-src-attr": ["'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  "img-src": ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://images.getinapp.com.br", "https://static-images.ifood.com.br"],
  "connect-src": ["'self'"],
  "media-src": ["'self'", "blob:"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
  "report-uri": [CSP_REPORT_PATH]
});

// Configuração do helmet: só o cabeçalho Report-Only; nenhuma política é aplicada.
export function helmetCspReportOnly() {
  return { useDefaults: false, reportOnly: true, directives: CSP_REPORT_ONLY_DIRECTIVES };
}

// Os relatórios chegam de qualquer navegador, sem login. Guardamos só o mínimo,
// sem query string nem fragmento (que podem levar tokens, ex.: recuperação de senha).
function originAndPath(value) {
  const text = String(value ?? "").trim().slice(0, 500);
  if (!text) return "";
  if (/^(inline|eval|data|blob|self|wasm-eval|trusted-types-sink)$/i.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text);
    if (["data:", "blob:", "about:"].includes(url.protocol)) return url.protocol.slice(0, -1);
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return text.replace(/[?#].*$/, "").replace(/[^\w:/.\-'@]/g, "").slice(0, 80);
  }
}

function pathOnly(value) {
  try { return new URL(String(value ?? "")).pathname.slice(0, 120); } catch { return ""; }
}

// Aceita o formato report-uri ({"csp-report": {...}}) e o da Reporting API ([{type, body}]).
export function normalizeCspReports(payload) {
  const raw = Array.isArray(payload)
    ? payload.filter(item => item?.type === "csp-violation").map(item => item.body)
    : [payload?.["csp-report"]];
  return raw.filter(r => r && typeof r === "object").slice(0, 20).map(r => {
    const directive = String(r["effective-directive"] || r.effectiveDirective || r["violated-directive"] || r.violatedDirective || "")
      .split(" ")[0].replace(/[^a-z-]/gi, "").slice(0, 40);
    const line = Number(r["line-number"] ?? r.lineNumber);
    return {
      directive: directive || "desconhecida",
      blocked: originAndPath(r["blocked-uri"] ?? r.blockedURL) || "desconhecido",
      page: pathOnly(r["document-uri"] ?? r.documentURL) || "desconhecida",
      source: originAndPath(r["source-file"] ?? r.sourceFile),
      line: Number.isSafeInteger(line) && line > 0 ? line : null,
      disposition: String(r.disposition || "report").slice(0, 10)
    };
  });
}

// Resumo em memória, deduplicado, com limite de chaves: um navegador com
// problema não enche o log nem a memória.
export function createCspReportStore({ maxKeys = 300, log = console.warn, now = () => new Date() } = {}) {
  const entries = new Map();
  let dropped = 0;
  return {
    record(report) {
      const key = [report.directive, report.blocked, report.page, report.source, report.line].join("|");
      const current = entries.get(key);
      if (current) {
        current.count++;
        current.last_seen = now().toISOString();
        return false;
      }
      if (entries.size >= maxKeys) { dropped++; return false; }
      const at = now().toISOString();
      entries.set(key, { ...report, count: 1, first_seen: at, last_seen: at });
      log(`CSP_REPORT_ONLY ${JSON.stringify(report)}`);
      return true;
    },
    summary() {
      const items = [...entries.values()].sort((a, b) => b.count - a.count);
      return { unique: items.length, total: items.reduce((sum, item) => sum + item.count, 0), dropped, items };
    }
  };
}
