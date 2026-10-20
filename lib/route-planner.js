// Sequência de entrega de 1 a 5 pedidos: avalia TODAS as permutações (até 5! = 120)
// sobre a matriz de tempos pelas vias e escolhe a de menor custo. Determinístico e puro:
// a mesma entrada sempre devolve a mesma sequência.
//
// Unidades: minutos. Para a sequência π = (π1..πn), com π0 = loja:
//   chegada  a_k = Σ_{m=1..k} t(π_{m-1}, π_m) + (k-1)·s          (s = tempo de parada)
//   duração  D   = a_n + s  (+ t(π_n, loja) se include_return)
//   espera   W_k = idade_k + a_k   (idade = minutos desde a criação do pedido na plataforma)
//   excesso  E_k = max(0, W_k − L)                                 (L = limite de espera)
//   custo    C   = α·D + β·Σ W_k + γ·Σ E_k²
// Desempate: menor maior espera → menor duração → menor sequência lexicográfica (posições
// digitadas). Sem a matriz completa não há rota: nada de tempo inventado.

export const ROUTE_MAX_STOPS = 5;

export const ROUTE_PLANNER_DEFAULTS = Object.freeze({
  alpha: 1,
  beta: 1,
  gamma: 0.2,
  wait_limit_minutes: 45,
  stop_minutes: 0,
  include_return: false
});

const PARAM_RANGES = Object.freeze({
  alpha: [0, 10],
  beta: [0, 10],
  gamma: [0, 10],
  wait_limit_minutes: [5, 240],
  stop_minutes: [0, 15]
});

const EPSILON = 1e-9;

function plannerError(message, code, extra = {}) {
  return Object.assign(new Error(message), { status: 422, code, ...extra });
}

export function factorial(n) {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

export function normalizePlannerParams(input = {}) {
  const out = { ...ROUTE_PLANNER_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(PARAM_RANGES)) {
    if (input[key] === undefined || input[key] === null || input[key] === "") continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw plannerError(`Parâmetro ${key} deve estar entre ${min} e ${max}.`, "ROUTE_PARAM_INVALID", { param: key });
    }
    out[key] = value;
  }
  if (input.include_return !== undefined) out.include_return = input.include_return === true || input.include_return === "true";
  if (out.alpha + out.beta <= 0) throw plannerError("α e β não podem ser ambos zero.", "ROUTE_PARAM_INVALID", { param: "alpha" });
  return Object.freeze(out);
}

// Permutações em ordem lexicográfica dos índices 0..n-1 (ordem estável = desempate estável).
export function permutations(n) {
  if (!Number.isInteger(n) || n < 1 || n > ROUTE_MAX_STOPS) {
    throw plannerError(`Uma saída tem de 1 a ${ROUTE_MAX_STOPS} entregas.`, "ROUTE_STOP_LIMIT");
  }
  const out = [];
  const used = new Array(n).fill(false);
  const current = [];
  const walk = () => {
    if (current.length === n) { out.push(current.slice()); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true; current.push(i);
      walk();
      current.pop(); used[i] = false;
    }
  };
  walk();
  return out;
}

// Matriz (n+1)×(n+1) em minutos; índice 0 = loja, 1..n = paradas. Diagonal ignorada.
export function validateMatrix(minutes, n, { needReturn = false } = {}) {
  if (!Array.isArray(minutes) || minutes.length !== n + 1) {
    throw plannerError("Matriz de tempos incompleta.", "ROUTE_MATRIX_INCOMPLETE");
  }
  const missing = [];
  for (let i = 0; i <= n; i++) {
    if (!Array.isArray(minutes[i]) || minutes[i].length !== n + 1) {
      throw plannerError("Matriz de tempos incompleta.", "ROUTE_MATRIX_INCOMPLETE");
    }
    for (let j = 0; j <= n; j++) {
      if (i === j || j === 0 && (!needReturn || i === 0)) continue;
      const v = minutes[i][j];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) missing.push([i, j]);
    }
  }
  if (missing.length) {
    throw plannerError("Sem tempo pelas vias para todos os trechos: a rota não foi calculada.", "ROUTE_MATRIX_INCOMPLETE", { missing });
  }
}

export function evaluateSequence(order, { minutes, ages, params }) {
  const p = params;
  let clock = 0, prev = 0, totalWait = 0, maxWait = -Infinity, penalty = 0, overCount = 0;
  const stops = order.map((stop, k) => {
    const node = stop + 1;
    const leg = minutes[prev][node];
    clock += (k ? p.stop_minutes : 0) + leg;
    const wait = (ages[stop] || 0) + clock;
    const excess = Math.max(0, wait - p.wait_limit_minutes);
    totalWait += wait;
    maxWait = Math.max(maxWait, wait);
    penalty += excess * excess;
    if (excess > 0) overCount += 1;
    prev = node;
    return { stop, position: k + 1, leg_minutes: leg, arrival_minutes: clock, wait_minutes: wait, excess_minutes: excess };
  });
  const returnMinutes = p.include_return ? minutes[prev][0] : 0;
  const duration = clock + p.stop_minutes + returnMinutes;
  const cost = p.alpha * duration + p.beta * totalWait + p.gamma * penalty;
  return {
    order: order.slice(),
    stops,
    duration_minutes: duration,
    return_minutes: p.include_return ? returnMinutes : null,
    total_wait_minutes: totalWait,
    max_wait_minutes: maxWait,
    penalty,
    over_limit_count: overCount,
    cost
  };
}

export function compareCandidates(a, b) {
  if (Math.abs(a.cost - b.cost) > EPSILON) return a.cost - b.cost;
  if (Math.abs(a.max_wait_minutes - b.max_wait_minutes) > EPSILON) return a.max_wait_minutes - b.max_wait_minutes;
  if (Math.abs(a.duration_minutes - b.duration_minutes) > EPSILON) return a.duration_minutes - b.duration_minutes;
  for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
  return 0;
}

// stops: [{ key, age_minutes }] na ordem digitada; minutes: matriz (n+1)×(n+1).
export function planRoute({ stops, minutes, params: rawParams = {}, keepCandidates = false }) {
  const list = Array.isArray(stops) ? stops : [];
  const n = list.length;
  if (n < 1 || n > ROUTE_MAX_STOPS) throw plannerError(`Uma saída tem de 1 a ${ROUTE_MAX_STOPS} entregas.`, "ROUTE_STOP_LIMIT");
  const params = normalizePlannerParams(rawParams);
  validateMatrix(minutes, n, { needReturn: params.include_return });
  const ages = list.map(s => {
    const raw = s?.age_minutes;
    const age = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(age) || age < 0) throw plannerError("Horário original do pedido ausente.", "ROUTE_ORDER_TIME_MISSING", { key: s?.key });
    return age;
  });
  const candidates = permutations(n).map(order => evaluateSequence(order, { minutes, ages, params }));
  const ranked = candidates.slice().sort(compareCandidates);
  const best = ranked[0];
  const typed = candidates[0];
  const withKeys = c => ({
    ...c,
    sequence: c.order.map(i => list[i].key),
    stops: c.stops.map(s => ({ ...s, key: list[s.stop].key, age_minutes: ages[s.stop] }))
  });
  return {
    evaluated: candidates.length,
    params,
    best: withKeys(best),
    typed_order: withKeys(typed),
    runner_up: ranked[1] ? withKeys(ranked[1]) : null,
    candidates: keepCandidates ? ranked.map(withKeys) : undefined
  };
}

// Recalcula só as paradas pendentes, partindo de uma origem confiável (loja ou a última
// entrega confirmada). Mesmo motor, mesma fórmula.
export function planPendingStops({ pending, minutes, params, elapsedMinutes = 0 }) {
  return planRoute({
    stops: pending.map(s => ({ key: s.key, age_minutes: Number(s.age_minutes) + Math.max(0, Number(elapsedMinutes) || 0) })),
    minutes,
    params
  });
}

// Comparadores usados nas simulações para justificar a fórmula.
export const BASELINES = Object.freeze({
  shortest: { alpha: 1, beta: 0, gamma: 0 },
  wait_only: { alpha: 0, beta: 1, gamma: 0 }
});

export function greedySequence(n, pick) {
  const left = Array.from({ length: n }, (_, i) => i);
  const out = [];
  let prev = 0;
  while (left.length) {
    left.sort((a, b) => pick(prev, a) - pick(prev, b) || a - b);
    const next = left.shift();
    out.push(next);
    prev = next + 1;
  }
  return out;
}
