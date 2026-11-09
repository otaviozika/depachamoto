// Simulações do motor de sequência (lib/route-planner.js) para justificar a fórmula e os
// pesos. Matrizes SINTÉTICAS (não são dados do Google): pontos em km a partir da loja,
// tempo = 1 min de saída/estacionamento + 1,3 × distância reta × 2,4 min/km (≈25 km/h).
// Uso: node scripts/simulate-route-planner.js [--write docs/ROTEIRIZACAO_SIMULACOES.md]
import fs from "node:fs";
import {
  ROUTE_PLANNER_DEFAULTS, evaluateSequence, greedySequence, normalizePlannerParams, planRoute
} from "../lib/route-planner.js";

const MIN_PER_KM = 2.4, ROAD_FACTOR = 1.3, FIXED = 1;
const km = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function syntheticMatrix(points) {
  const nodes = [{ x: 0, y: 0 }, ...points];
  return nodes.map((a, i) => nodes.map((b, j) => i === j ? 0 : Math.round((FIXED + ROAD_FACTOR * km(a, b) * MIN_PER_KM) * 10) / 10));
}

export const SCENARIOS = [
  {
    id: "S1", title: "Pedido muito antigo × pedidos recentes perto",
    stops: [
      { key: "A", x: 3.2, y: 1.0, age: 52 },
      { key: "B", x: 0.6, y: -0.4, age: 8 },
      { key: "C", x: -0.8, y: 0.5, age: 6 },
      { key: "D", x: 0.9, y: 0.9, age: 10 }
    ]
  },
  {
    id: "S2", title: "Pedido muito distante",
    stops: [
      { key: "A", x: 0.8, y: 0.6, age: 18 },
      { key: "B", x: 1.2, y: -0.5, age: 15 },
      { key: "C", x: 7.5, y: 3.0, age: 20 },
      { key: "D", x: -0.6, y: 1.1, age: 16 }
    ]
  },
  {
    id: "S3", title: "Pedido recente e próximo",
    stops: [
      { key: "A", x: 0.3, y: 0.2, age: 2 },
      { key: "B", x: 2.4, y: 1.8, age: 30 },
      { key: "C", x: 2.9, y: 1.2, age: 28 }
    ]
  },
  {
    id: "S4", title: "Cinco pedidos em bairros diferentes",
    stops: [
      { key: "A", x: 2.8, y: 2.2, age: 14 },   // Santa Paula
      { key: "B", x: -2.5, y: 1.4, age: 9 },   // Ipiranga
      { key: "C", x: 1.5, y: -2.6, age: 18 },  // Santa Maria
      { key: "D", x: -1.2, y: -3.0, age: 6 },  // Sacomã
      { key: "E", x: 4.4, y: -0.6, age: 11 }   // divisa com Santo André
    ]
  },
  {
    id: "S5", title: "Cinco pedidos próximos entre si",
    stops: [
      { key: "A", x: 1.10, y: 0.90, age: 20 },
      { key: "B", x: 1.30, y: 1.05, age: 14 },
      { key: "C", x: 1.20, y: 0.70, age: 26 },
      { key: "D", x: 1.45, y: 0.85, age: 9 },
      { key: "E", x: 1.00, y: 1.15, age: 17 }
    ]
  },
  {
    id: "S6", title: "Trajeto mais curto que prejudica demais um cliente",
    // Paradas em anel: os dois sentidos têm os mesmos trechos, exceto o primeiro.
    // O sentido mais curto deixa o pedido antigo (E) por último.
    stops: [
      { key: "A", x: 1.0, y: 0.0, age: 10 },
      { key: "B", x: 2.0, y: 0.3, age: 9 },
      { key: "C", x: 2.4, y: 1.3, age: 11 },
      { key: "D", x: 1.6, y: 2.0, age: 8 },
      { key: "E", x: 0.6, y: 1.4, age: 40 }
    ]
  },
  {
    id: "S7", title: "Mais antigo primeiro com percurso desnecessariamente longo",
    stops: [
      { key: "A", x: 4.2, y: 2.4, age: 27 },
      { key: "B", x: 0.4, y: 0.3, age: 24 },
      { key: "C", x: 0.7, y: 0.5, age: 23 },
      { key: "D", x: 1.0, y: 0.2, age: 22 },
      { key: "E", x: 0.5, y: -0.2, age: 21 }
    ]
  }
];

export const WEIGHT_SETS = [
  { id: "W0", label: "Só duração (α=1, β=0, γ=0)", params: { alpha: 1, beta: 0, gamma: 0 } },
  { id: "W1", label: "Só esperas (α=0, β=1, γ=0)", params: { alpha: 0, beta: 1, gamma: 0 } },
  { id: "W2", label: "α=1, β=1, γ=0", params: { alpha: 1, beta: 1, gamma: 0 } },
  { id: "W3", label: "α=1, β=1, γ=0,2, L=45 (escolhida)", params: { alpha: 1, beta: 1, gamma: 0.2, wait_limit_minutes: 45 } },
  { id: "W4", label: "α=1, β=1, γ=1, L=45", params: { alpha: 1, beta: 1, gamma: 1, wait_limit_minutes: 45 } },
  { id: "W5", label: "α=1, β=1, γ=0,2, L=30", params: { alpha: 1, beta: 1, gamma: 0.2, wait_limit_minutes: 30 } }
];

const fmt = v => (Math.round(v * 10) / 10).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const seq = (scenario, order) => "Loja → " + order.map(i => scenario.stops[i].key).join(" → ");

export function evaluateScenario(scenario) {
  const minutes = syntheticMatrix(scenario.stops);
  const ages = scenario.stops.map(s => s.age);
  const evalWith = (order, params) => evaluateSequence(order, { minutes, ages, params: normalizePlannerParams(params) });
  const reference = normalizePlannerParams(WEIGHT_SETS.find(w => w.id === "W3").params);
  const rows = WEIGHT_SETS.map(w => {
    const plan = planRoute({ stops: scenario.stops.map(s => ({ key: s.key, age_minutes: s.age })), minutes, params: w.params });
    return { id: w.id, label: w.label, order: plan.best.order, metrics: evalWith(plan.best.order, reference) };
  });
  const oldest = scenario.stops.map((s, i) => i).sort((a, b) => scenario.stops[b].age - scenario.stops[a].age || a - b);
  const nearest = greedySequence(scenario.stops.length, (prev, next) => minutes[prev][next + 1]);
  rows.push({ id: "B1", label: "Mais antigo primeiro (regra simples)", order: oldest, metrics: evalWith(oldest, reference) });
  rows.push({ id: "B2", label: "Vizinho mais próximo (guloso)", order: nearest, metrics: evalWith(nearest, reference) });
  return { minutes, rows };
}

export function renderScenario(scenario) {
  const { minutes, rows } = evaluateScenario(scenario);
  const lines = [];
  lines.push(`### ${scenario.id} — ${scenario.title}`, "");
  lines.push("| Pedido | Posição (km L/N) | Idade na saída (min) | Loja → pedido (min) |", "|---|---|---|---|");
  scenario.stops.forEach((s, i) => lines.push(`| ${s.key} | ${s.x}, ${s.y} | ${s.age} | ${fmt(minutes[0][i + 1])} |`));
  lines.push("", "Métricas medidas sempre com a fórmula escolhida (W3) para comparar sequências no mesmo critério:", "");
  lines.push("| Critério | Sequência | Duração D | Σ esperas | Maior espera | Acima de 45 min | Custo W3 |", "|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const m = r.metrics;
    lines.push(`| ${r.id} ${r.label} | ${seq(scenario, r.order)} | ${fmt(m.duration_minutes)} | ${fmt(m.total_wait_minutes)} | ${fmt(m.max_wait_minutes)} | ${m.over_limit_count} | ${fmt(m.cost)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function render120(scenario = SCENARIOS.find(s => s.id === "S4")) {
  const minutes = syntheticMatrix(scenario.stops);
  const plan = planRoute({ stops: scenario.stops.map(s => ({ key: s.key, age_minutes: s.age })), minutes, keepCandidates: true });
  const lines = [`### Todas as ${plan.evaluated} sequências de ${scenario.id} (${scenario.title}), parâmetros padrão`, ""];
  lines.push("Matriz de tempos (min), linha = origem, coluna = destino; 0 = loja:", "");
  lines.push("| | " + ["Loja", ...scenario.stops.map(s => s.key)].join(" | ") + " |", "|---|" + minutes.map(() => "---").join("|") + "|");
  minutes.forEach((row, i) => lines.push(`| ${i ? scenario.stops[i - 1].key : "Loja"} | ${row.map(fmt).join(" | ")} |`));
  lines.push("", "| # | Sequência | Chegadas (min) | Esperas W (min) | D | Σ W | Σ E² | Custo |", "|---|---|---|---|---|---|---|---|");
  plan.candidates.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.sequence.join(" → ")} | ${c.stops.map(s => fmt(s.arrival_minutes)).join(" / ")} | ${c.stops.map(s => fmt(s.wait_minutes)).join(" / ")} | ${fmt(c.duration_minutes)} | ${fmt(c.total_wait_minutes)} | ${fmt(c.penalty)} | ${fmt(c.cost)} |`);
  });
  return { text: lines.join("\n"), plan };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  const out = ["# Simulações do motor de sequência", "",
    "Gerado por `node scripts/simulate-route-planner.js --write`. Matrizes **sintéticas** (não são dados do Google): " +
    `tempo = ${FIXED} min + ${ROAD_FACTOR} × distância reta × ${MIN_PER_KM} min/km. Idade = minutos desde a criação do pedido na plataforma no momento do cálculo.`,
    "", `Parâmetros padrão: α=${ROUTE_PLANNER_DEFAULTS.alpha}, β=${ROUTE_PLANNER_DEFAULTS.beta}, γ=${ROUTE_PLANNER_DEFAULTS.gamma}, L=${ROUTE_PLANNER_DEFAULTS.wait_limit_minutes} min, parada=${ROUTE_PLANNER_DEFAULTS.stop_minutes} min, retorno à loja ${ROUTE_PLANNER_DEFAULTS.include_return ? "incluído" : "não incluído"}.`, ""];
  for (const s of SCENARIOS) out.push(renderScenario(s));
  out.push(render120().text, "");
  const text = out.join("\n");
  const at = process.argv.indexOf("--write");
  if (at > 0) fs.writeFileSync(process.argv[at + 1] || "docs/ROTEIRIZACAO_SIMULACOES.md", text);
  else console.log(text);
}
