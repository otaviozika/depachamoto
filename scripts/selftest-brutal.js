const COURIERS = 40;
const DEPARTURES_PER_COURIER = 50;
const activeByCourier = new Map();
const activeOrders = new Map();
const clientTokens = new Map();

let dispatchId = 0;
let created = 0;
let idempotentReplays = 0;
let blockedDuplicates = 0;
let blockedMissingCheckin = 0;
let completedReturns = 0;

function createDispatch(courierId, orders, token) {
  // Idempotência vem antes da trava operacional: repetir o MESMO request
  // continua seguro e não cria uma segunda saída.
  if (clientTokens.has(token)) {
    idempotentReplays++;
    return clientTokens.get(token);
  }

  // v2.8: uma saída ativa bloqueia qualquer NOVA saída do mesmo motoboy.
  if (activeByCourier.has(courierId)) {
    blockedMissingCheckin++;
    return null;
  }

  for (const order of orders) {
    if (activeOrders.has(order)) {
      blockedDuplicates++;
      return null;
    }
  }

  const d = { id: ++dispatchId, courierId, orders, token, stage: 'EN_ROUTE' };
  activeByCourier.set(courierId, d);
  for (const o of orders) activeOrders.set(o, d.id);
  clientTokens.set(token, d);
  created++;
  return d;
}

function startReturn(courierId) {
  const d = activeByCourier.get(courierId);
  if (!d) return false;
  d.stage = 'RETURNING';
  return true;
}

function arriveAtStore(courierId) {
  const d = activeByCourier.get(courierId);
  if (!d || d.stage !== 'RETURNING') return false;
  for (const o of d.orders) activeOrders.delete(o);
  activeByCourier.delete(courierId);
  completedReturns++;
  return true;
}

const jobs = [];
for (let c = 1; c <= COURIERS; c++) {
  jobs.push((async () => {
    for (let i = 1; i <= DEPARTURES_PER_COURIER; i++) {
      const base = `#T${String(c).padStart(2,'0')}${String(i).padStart(4,'0')}`;
      const orders = [base, `${base}B`];
      const token = `c${c}-d${i}`;

      const main = createDispatch(c, orders, token);
      if (!main) throw new Error(`Saída principal bloqueada inesperadamente: c${c} d${i}`);

      // Replay do mesmo request deve continuar idempotente mesmo com saída ativa.
      if (i % 5 === 0) createDispatch(c, orders, token);

      // Tenta deliberadamente uma OUTRA saída sem check-in: deve bloquear.
      const forbidden = createDispatch(c, [`#BLOCK-${c}-${i}`], `blocked-${c}-${i}`);
      if (forbidden) throw new Error(`Nova saída sem check-in foi aceita: c${c} d${i}`);

      // A cada 10 saídas, um motoboy livre fictício tenta usar um pedido ativo.
      if (i % 10 === 0) {
        const duplicate = createDispatch(100000 + c * 100 + i, [orders[0]], `dup-${c}-${i}`);
        if (duplicate) throw new Error(`Pedido ativo duplicado foi aceito: ${orders[0]}`);
      }

      // Mantém a última saída ativa para validar estado final; todas as anteriores
      // exigem RETORNANDO -> CHEGUEI NA LOJA antes da próxima.
      if (i < DEPARTURES_PER_COURIER) {
        if (!startReturn(c)) throw new Error(`Falha ao iniciar retorno: c${c} d${i}`);
        if (!arriveAtStore(c)) throw new Error(`Falha no check-in: c${c} d${i}`);
      }

      await new Promise(r => setImmediate(r));
    }
  })());
}

await Promise.all(jobs);

const expectedMain = COURIERS * DEPARTURES_PER_COURIER;
const expectedCompleted = COURIERS * (DEPARTURES_PER_COURIER - 1);
const expectedReplays = COURIERS * (DEPARTURES_PER_COURIER / 5);
const expectedCheckinBlocks = expectedMain;
const expectedDuplicateBlocks = COURIERS * (DEPARTURES_PER_COURIER / 10);

if (created !== expectedMain) throw new Error(`Criações inconsistentes: ${created}/${expectedMain}`);
if (completedReturns !== expectedCompleted) throw new Error(`Check-ins inconsistentes: ${completedReturns}/${expectedCompleted}`);
if (blockedMissingCheckin !== expectedCheckinBlocks) throw new Error(`Bloqueios de check-in: ${blockedMissingCheckin}/${expectedCheckinBlocks}`);
if (idempotentReplays !== expectedReplays) throw new Error(`Replays: ${idempotentReplays}/${expectedReplays}`);
if (blockedDuplicates !== expectedDuplicateBlocks) throw new Error(`Duplicidades: ${blockedDuplicates}/${expectedDuplicateBlocks}`);
if (activeByCourier.size !== COURIERS) throw new Error(`Ativos finais: ${activeByCourier.size}/${COURIERS}`);
if (activeOrders.size !== COURIERS * 2) throw new Error(`Pedidos ativos finais: ${activeOrders.size}/${COURIERS * 2}`);

console.log(JSON.stringify({
  result: 'PASS',
  version: '3.0.0',
  couriers: COURIERS,
  attemptedMainDepartures: expectedMain,
  createdDispatches: created,
  completedReturnCheckins: completedReturns,
  newDeparturesBlockedUntilCheckin: blockedMissingCheckin,
  idempotentReplaysPrevented: idempotentReplays,
  activeDuplicateAttemptsBlocked: blockedDuplicates,
  activeCouriersAtEnd: activeByCourier.size,
  activeOrdersAtEnd: activeOrders.size
}, null, 2));
