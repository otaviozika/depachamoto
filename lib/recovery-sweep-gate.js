// Avoid repeatedly scanning all AnotaAI links when no post-crash
// reconciliation is due. The durable worker still processes pending jobs at
// its original cadence; this gate only throttles the recovery sweep.
export function createRecoverySweepGate({ intervalMs = 60_000, now = () => Date.now() } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000 || intervalMs > 120_000) {
    throw new RangeError("Recovery sweep interval outside safe range");
  }
  let lastSuccess = -Infinity;
  return async function sweepIfDue(task) {
    const currentTime = now();
    if (currentTime - lastSuccess < intervalMs) return false;
    await task();
    lastSuccess = now();
    return true;
  };
}
