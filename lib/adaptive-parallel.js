// Roda consultas independentes em paralelo só quando o banco tem folga.
//
// Em paralelo, uma tela ocupa várias conexões do pool ao mesmo tempo. Isso a
// deixa mais rápida no uso normal, mas num pico (ex.: todos os celulares
// recarregando depois de um deploy) faria outras ações, como uma saída,
// esperarem por conexão. Por isso: se o pool está ocupado (há espera, ou mais
// de busyFraction das conexões em uso), as tarefas rodam em fila, exatamente
// como antes. Nunca fica pior do que a execução em fila.
export function createAdaptiveRunner(pool, { busyFraction = 0.5 } = {}) {
  function maxConnections() {
    const max = Number(pool?.options?.max);
    return Number.isFinite(max) && max > 0 ? max : 10;
  }

  function busy() {
    const total = Number(pool?.totalCount);
    const idle = Number(pool?.idleCount);
    const waiting = Number(pool?.waitingCount);
    if (![total, idle, waiting].every(Number.isFinite)) return false;
    const inUse = total - idle;
    return waiting > 0 || inUse >= Math.max(1, Math.floor(maxConnections() * busyFraction));
  }

  // tasks: funções que iniciam cada consulta (ex.: () => pool.query(...)).
  // A decisão vale para o grupo inteiro e preserva a ordem dos resultados.
  async function all(tasks) {
    if (!busy()) return Promise.all(tasks.map(task => task()));
    const results = [];
    for (const task of tasks) results.push(await task());
    return results;
  }

  return { all, busy };
}
