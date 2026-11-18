// Tela inicial do motoboy: as consultas independentes rodam em paralelo só com
// folga no pool; com o pool ocupado, em fila como antes (nunca pior num pico).
// A equivalência da resposta com a versão anterior foi medida antes da publicação
// (mesmo banco, três cenários, respostas idênticas byte a byte; ver o PR).
import fs from "node:fs";
import assert from "node:assert/strict";
import { createAdaptiveRunner } from "../lib/adaptive-parallel.js";

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log("PASS", name); };

function tracker() {
  let running = 0, peak = 0;
  const task = (value, ms = 15) => async () => {
    running++; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, ms));
    running--; return value;
  };
  return { task, peak: () => peak };
}
const pool = (over = {}) => ({ options: { max: 20 }, totalCount: 4, idleCount: 4, waitingCount: 0, ...over });

await test("pool com folga: tarefas em paralelo, resultados na ordem", async () => {
  const t = tracker(), runner = createAdaptiveRunner(pool());
  const out = await runner.all([t.task("a"), t.task("b", 5), t.task("c"), t.task("d", 1), t.task("e")]);
  assert.deepEqual(out, ["a", "b", "c", "d", "e"]);
  assert.equal(t.peak(), 5);
});

await test("alguém esperando conexão: em fila, uma de cada vez", async () => {
  const t = tracker(), runner = createAdaptiveRunner(pool({ totalCount: 20, idleCount: 0, waitingCount: 3 }));
  assert.deepEqual(await runner.all([t.task(1), t.task(2), t.task(3)]), [1, 2, 3]);
  assert.equal(t.peak(), 1);
});

await test("metade ou mais das conexões em uso: em fila", async () => {
  for (const inUse of [10, 15, 19]) {
    const t = tracker(), runner = createAdaptiveRunner(pool({ totalCount: 20, idleCount: 20 - inUse }));
    await runner.all([t.task(1), t.task(2)]);
    assert.equal(t.peak(), 1, `${inUse} em uso`);
  }
  const t = tracker(), runner = createAdaptiveRunner(pool({ totalCount: 9, idleCount: 0 }));
  await runner.all([t.task(1), t.task(2)]);
  assert.equal(t.peak(), 2, "9 de 20 em uso ainda tem folga");
});

await test("erro numa consulta propaga como antes; pool sem métricas roda em paralelo", async () => {
  const runner = createAdaptiveRunner(pool());
  await assert.rejects(runner.all([async () => 1, async () => { throw new Error("falha"); }]), /falha/);
  const busyRunner = createAdaptiveRunner(pool({ waitingCount: 1 }));
  await assert.rejects(busyRunner.all([async () => { throw new Error("falha em fila"); }, async () => 2]), /falha em fila/);
  const t = tracker();
  await createAdaptiveRunner({ query() {} }).all([t.task(1), t.task(2)]);
  assert.equal(t.peak(), 2);
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
await test("tela inicial usa o executor adaptativo com as mesmas consultas", async () => {
  const start = server.indexOf('app.get("/api/courier/dashboard"');
  const route = server.slice(start, server.indexOf("\n}));", start));
  assert.equal((route.match(/await adaptiveQueries\.all\(\[/g) || []).length, 2, "duas rodadas");
  assert.doesNotMatch(route, /Promise\.all\(/, "nenhum paralelo sem controle");
  assert.equal((route.match(/\(\) => /g) || []).length, 10, "cada consulta é iniciada pelo executor");
  for (const fragment of [
    "WHERE d.courier_id=$1 AND d.status='ON_ROAD'\n    ORDER BY d.id DESC LIMIT 1",
    "date_trunc('week', NOW() AT TIME ZONE 'America/Sao_Paulo')",
    "ORDER BY d.id DESC LIMIT 30",
    "WHERE courier_id=$1 AND status='RELEASED' AND released_at IS NOT NULL\n    ORDER BY released_at DESC,id DESC LIMIT 1",
    'touchPresence(courierId, "COURIER_WEB")', "currentUser(courierId)", "getSPDate()", "getOperationalSlaSettings()",
    "getCourierAttendance(courierId, attendanceDate, attendanceView.shift_code)", "getDispatchProgressMap([activeRow.id])"
  ]) assert.ok(route.includes(fragment), `consulta preservada: ${fragment.slice(0, 50)}`);
  assert.match(server, /const adaptiveQueries = createAdaptiveRunner\(pool\);/);
});

console.log(JSON.stringify({ result: "PASS", feature: "courier_dashboard_parallel", cases: count }));
