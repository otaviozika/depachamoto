// Desempenho do algoritmo puro de roteirizacao: 40 motoboys, 5 destinos cada.
// Somente dados ficticios, zero acesso a banco/rede. NAO mede a latencia ORS,
// geocodificacao, carga HTTP, ou atendimento de cota do fornecedor.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { planFastestViableRoute, FASTEST_VIABLE_POLICY } from "../lib/route-planner.js";

function fixture(seed) {
  const stops = Array.from({ length: 5 }, (_, i) => ({
    key: `courier-${seed}-stop-${i}`,
    age_minutes: ((seed * 11 + i * 19) % 82) + 1
  }));
  const minutes = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => i === j ? 0 :
      Math.round((2 + Math.abs(i - j) * 1.7 + ((i * 13 + j * 17 + seed * 7) % 11) * 0.36) * 10) / 10));
  return { stops, minutes };
}
const durations = [];
const runs = [];
for (let round = 0; round < 3; round++) {
  const batch = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
    const input = fixture(i);
    const start = performance.now();
    const out = planFastestViableRoute(input);
    const ms = performance.now() - start;
    assert.equal(out.strategy, "FASTEST_VIABLE");
    assert.equal(out.evaluated, 120);
    assert.ok(out.eligible_evaluated >= 1 && out.eligible_evaluated <= 120);
    assert.equal(new Set(out.best.sequence).size, 5);
    assert.ok(out.extra_minutes >= -1e-9);
    assert.ok(out.extra_minutes <= FASTEST_VIABLE_POLICY.max_extra_minutes + 1e-9);
    assert.ok(out.extra_minutes <= out.fastest_duration_minutes * FASTEST_VIABLE_POLICY.max_extra_ratio + 1e-9);
    assert.ok(out.best.stops.every(s => Number.isFinite(s.arrival_minutes) && s.arrival_minutes >= 0));
    return { ms, sequence: out.best.sequence, first: out.best.stops[0].key };
  }));
  batch.forEach(result => durations.push(result.ms));
  runs.push(batch.map(x => x.sequence.join(",")));
}
assert.deepEqual(runs[0], runs[1], "Sequencias devem ser estaveis entre execucoes");
assert.deepEqual(runs[0], runs[2], "Sequencias devem ser estaveis entre execucoes");
const sorted = durations.slice().sort((a,b) => a - b);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
const max = sorted.at(-1);
assert.ok(p95 < 1000, `Algoritmo puro excedeu 1s p95: ${p95}ms`);
console.log(JSON.stringify({
  result: "PASS", synthetic_only: true, couriers: 40,
  passes_per_courier: 3, routes_evaluated: 40 * 3 * 120,
  p95_compute_ms: Number(p95.toFixed(3)),
  max_compute_ms: Number(max.toFixed(3)),
  stable_sequences: true, external_api_requests: 0, database_queries: 0
}));
