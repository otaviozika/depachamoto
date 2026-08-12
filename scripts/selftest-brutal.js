const COURIERS = 40;
const DEPARTURES_PER_COURIER = 50;
const activeByCourier = new Map();
const activeOrders = new Map();
const clientTokens = new Map();

let dispatchId = 0;
let created = 0;
let idempotentReplays = 0;
let blockedDuplicates = 0;
let released = 0;

function createDispatch(courierId, orders, token) {
  if (clientTokens.has(token)) {
    idempotentReplays++;
    return clientTokens.get(token);
  }

  for (const order of orders) {
    if (activeOrders.has(order)) {
      blockedDuplicates++;
      return null;
    }
  }

  const prev = activeByCourier.get(courierId);
  if (prev) {
    for (const o of prev.orders) activeOrders.delete(o);
    released++;
  }

  const d = { id: ++dispatchId, courierId, orders, token };
  activeByCourier.set(courierId, d);
  for (const o of orders) activeOrders.set(o, d.id);
  clientTokens.set(token, d);
  created++;
  return d;
}

const jobs = [];
for (let c=1;c<=COURIERS;c++) {
  jobs.push((async()=>{
    for (let i=1;i<=DEPARTURES_PER_COURIER;i++) {
      const base = `#T${String(c).padStart(2,'0')}${String(i).padStart(4,'0')}`;
      const orders = [base, `${base}B`];
      const token = `c${c}-d${i}`;

      createDispatch(c, orders, token);

      if (i % 5 === 0) createDispatch(c, orders, token);

      if (i % 10 === 0) {
        const other = c === 1 ? 2 : 1;
        const existing = activeByCourier.get(other);
        if (existing) createDispatch(c, [existing.orders[0]], `dup-${c}-${i}`);
      }

      await new Promise(r=>setImmediate(r));
    }
  })());
}

await Promise.all(jobs);

if (activeByCourier.size !== COURIERS) {
  throw new Error(`Esperado ${COURIERS} motoboys ativos; recebido ${activeByCourier.size}`);
}
if (activeOrders.size !== COURIERS * 2) {
  throw new Error(`Esperado ${COURIERS*2} pedidos ativos; recebido ${activeOrders.size}`);
}
if (created !== COURIERS * DEPARTURES_PER_COURIER) {
  throw new Error(`Criações inconsistentes: ${created}`);
}

console.log(JSON.stringify({
  result: "PASS",
  couriers: COURIERS,
  attemptedMainDepartures: COURIERS * DEPARTURES_PER_COURIER,
  createdDispatches: created,
  ordersProcessed: created * 2,
  releasedPreviousDispatches: released,
  activeCouriersAtEnd: activeByCourier.size,
  activeOrdersAtEnd: activeOrders.size,
  idempotentReplaysPrevented: idempotentReplays,
  activeDuplicateAttemptsBlocked: blockedDuplicates
}, null, 2));
