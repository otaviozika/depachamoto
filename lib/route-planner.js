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
export function planRoute({ stops, minutes, params: rawParams = {}, keepCandidates = false, requiredFirstIndex = null }) {
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
  // Regra da OLD MAN: a primeira parada deve ser a mais próxima da loja pelas VIAS.
  // Um caixa pode autorizar outra ordem somente pela exceção administrativa auditada.
  // A restrição é opcional para preservar os comparadores e simulações legadas.
  if (requiredFirstIndex !== null && (!Number.isInteger(requiredFirstIndex) || requiredFirstIndex < 0 || requiredFirstIndex >= n)) {
    throw plannerError('Primeira parada obrigatória inválida.', 'ROUTE_PRIORITY_INVALID');
  }
  const candidates = permutations(n).map(order => evaluateSequence(order, { minutes, ages, params }));
  const eligible = requiredFirstIndex === null ? candidates : candidates.filter(c => c.order[0] === requiredFirstIndex);
  const ranked = eligible.slice().sort(compareCandidates);
  const best = ranked[0];
  const typed = candidates[0];
  const withKeys = c => ({
    ...c,
    sequence: c.order.map(i => list[i].key),
    stops: c.stops.map(s => ({ ...s, key: list[s.stop].key, age_minutes: ages[s.stop] }))
  });
  return {
    evaluated: candidates.length,
    eligible_evaluated: eligible.length,
    required_first_index: requiredFirstIndex,
    params,
    best: withKeys(best),
    typed_order: withKeys(typed),
    runner_up: ranked[1] ? withKeys(ranked[1]) : null,
    candidates: keepCandidates ? ranked.map(withKeys) : undefined
  };
}

// Politica operacional FASTEST_VIABLE: a rota tem de ficar muito proxima da mais
// rapida possivel, mas entre alternativas quase tao rapidas favorecemos os
// clientes que aguardam ha mais tempo e reduzimos o total de esperas.
// O limite impede que um pedido antigo force um desvio excessivo aos demais.
export const FASTEST_VIABLE_POLICY = Object.freeze({
  max_extra_minutes: 3,
  max_extra_ratio: 0.10
});

// Minimum complete tour. Age is reported, never used for selection or ties.
// With a distinct origin, the caller supplies each stop's travel time to the store.
export function planFastestRoute({ stops, minutes, params = {}, returnToStoreMinutes = null, keepCandidates = false }) {
  let matrix = minutes;
  if (returnToStoreMinutes !== null) {
    validateMatrix(minutes, stops.length);
    if (!Array.isArray(returnToStoreMinutes) || returnToStoreMinutes.length !== stops.length ||
        returnToStoreMinutes.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw plannerError('Sem tempo pelas vias para retornar à loja.', 'ROUTE_MATRIX_INCOMPLETE');
    }
    matrix = minutes.map(row => row.slice());
    returnToStoreMinutes.forEach((v, i) => { matrix[i + 1][0] = v; });
  }
  const all = planRoute({ stops, minutes: matrix, params: { ...params, alpha: 1, beta: 0, gamma: 0, include_return: true }, keepCandidates: true });
  const ranked = all.candidates.slice().sort((a, b) => {
    if (a.duration_minutes !== b.duration_minutes) return a.duration_minutes - b.duration_minutes;
    for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    return 0;
  });
  return { ...all, best: ranked[0], runner_up: ranked[1] || null,
    strategy: 'FASTEST_RETURN', fastest_duration_minutes: ranked[0].duration_minutes,
    max_extra_minutes: 0, extra_minutes: 0,
    saved_minutes_vs_typed: all.typed_order.duration_minutes - ranked[0].duration_minutes,
    candidates: keepCandidates ? ranked : undefined };
}

export const NEAREST_DELAY_POLICY = Object.freeze({ risk_margin_minutes: 5, max_extra_minutes: 3, max_extra_ratio: 0.10 });

// Strict nearest-by-road-time baseline at every stop. Only a delay risk can
// authorize a different sequence; return to store counts in the detour budget.
export function planNearestDelayRoute(input) {
  const all = planFastestRoute({ ...input, keepCandidates: true });
  const order = greedySequence(input.stops.length, (prev, next) => input.minutes[prev][next + 1]);
  const baseline = all.candidates.find(c => c.order.every((v, i) => v === order[i]));
  const threshold = all.params.wait_limit_minutes - NEAREST_DELAY_POLICY.risk_margin_minutes;
  const atRisk = baseline.stops.filter(s => s.wait_minutes >= threshold).map(s => s.stop);
  const cap = Math.min(NEAREST_DELAY_POLICY.max_extra_minutes, baseline.duration_minutes * NEAREST_DELAY_POLICY.max_extra_ratio);
  const byStop = new Map(baseline.stops.map(s => [s.stop, s]));
  const burden = c => c.stops.reduce((sum, s) => sum + Math.max(0, s.wait_minutes - threshold), 0);
  const excess = c => c.stops.reduce((sum, s) => sum + s.excess_minutes, 0);
  // Do not create another late customer or worsen an already risky customer's ETA.
  const alternatives = atRisk.length ? all.candidates.filter(c =>
    c.duration_minutes <= baseline.duration_minutes + cap + EPSILON &&
    c.stops.every(s => {
      const before = byStop.get(s.stop);
      return !(before.excess_minutes === 0 && s.excess_minutes > 0) &&
        (!atRisk.includes(s.stop) || s.wait_minutes <= before.wait_minutes + EPSILON);
    }) && c.stops.some(s => atRisk.includes(s.stop) && s.wait_minutes < byStop.get(s.stop).wait_minutes - EPSILON)
  ) : [];
  alternatives.sort((a,b) => a.over_limit_count - b.over_limit_count || excess(a)-excess(b) || burden(a)-burden(b) || a.duration_minutes-b.duration_minutes ||
    a.order.join(',').localeCompare(b.order.join(',')));
  const best = alternatives[0] || baseline;
  return { ...all, best, strategy: 'NEAREST_DELAY', runner_up: null,
    nearest_baseline: baseline, risk_stop_indices: atRisk,
    risk_margin_minutes: NEAREST_DELAY_POLICY.risk_margin_minutes,
    delay_exception: best !== baseline, eligible_evaluated: alternatives.length + 1,
    max_extra_minutes: cap, extra_minutes: Math.max(0, best.duration_minutes - baseline.duration_minutes),
    saved_minutes_vs_typed: all.typed_order.duration_minutes - best.duration_minutes,
    candidates: input.keepCandidates ? [baseline, ...alternatives] : undefined };
}

// Usa a mesma matriz real e a mesma formula de espera do motor historico, mas
// nao obriga o primeiro pedido a ser o mais proximo em metros. Isso evita
// trajetos ruins em malhas assimetricas (ruas de mao unica, pontes, retornos).
// Maximo 120 permutacoes. Sem heuristica gulosa e sem tempos inventados.
export function planFastestViableRoute({ stops, minutes, params = {}, keepCandidates = false }) {
  const all = planRoute({ stops, minutes, params, keepCandidates: true });
  const fastestDuration = Math.min(...all.candidates.map(c => c.duration_minutes));
  const maxExtra = Math.min(FASTEST_VIABLE_POLICY.max_extra_minutes, fastestDuration * FASTEST_VIABLE_POLICY.max_extra_ratio);
  const bound = fastestDuration + maxExtra;
  const viable = all.candidates.filter(c => c.duration_minutes <= bound + EPSILON).sort(compareCandidates);
  const best = viable[0];
  const { candidates: ignored, ...rest } = all;
  return {
    ...rest,
    best,
    runner_up: viable[1] || null,
    eligible_evaluated: viable.length,
    required_first_index: null,
    strategy: "FASTEST_VIABLE",
    fastest_duration_minutes: fastestDuration,
    max_extra_minutes: maxExtra,
    extra_minutes: Math.max(0, best.duration_minutes - fastestDuration),
    saved_minutes_vs_typed: all.typed_order.duration_minutes - best.duration_minutes,
    candidates: keepCandidates ? viable : undefined
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
