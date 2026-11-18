// Cache curto da conferência "esta conta continua válida?" feita a cada requisição.
//
// - Guarda só contas VÁLIDAS (ativa, aprovada, mesmo papel da sessão). Conta
//   inválida nunca é guardada: é sempre barrada consultando o banco.
// - Toda alteração feita por um admin chama invalidateAll(): desativar, aprovar,
//   recusar ou mudar o papel de alguém pelo painel vale na hora.
// - O contador de geração impede que uma leitura iniciada ANTES da alteração
//   (ainda com a conta válida) volte ao cache DEPOIS dela.
// - Só alterações feitas fora do app (direto no banco) esperam até ttlMs.
export const DEFAULT_ACCOUNT_CACHE_TTL_MS = 10_000;

export function accountCacheTtlFromEnv(value) {
  const text = String(value ?? "").trim();
  if (!text) return DEFAULT_ACCOUNT_CACHE_TTL_MS;
  const ms = Number(text);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 60_000) {
    throw new Error("ACCOUNT_CACHE_TTL_MS precisa ser um número inteiro de 0 a 60000 (0 desliga o cache).");
  }
  return ms;
}

export function createAccountCache({ ttlMs = DEFAULT_ACCOUNT_CACHE_TTL_MS, maxEntries = 5000, now = () => Date.now() } = {}) {
  const entries = new Map();
  let generation = 0;
  return {
    get enabled() { return ttlMs > 0; },
    generation() { return generation; },
    get(userId) {
      if (ttlMs <= 0) return null;
      const entry = entries.get(Number(userId));
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(Number(userId));
        return null;
      }
      return entry.account;
    },
    // generationAtRead: valor de generation() lido ANTES da consulta ao banco.
    set(userId, account, generationAtRead) {
      if (ttlMs <= 0 || generationAtRead !== generation || !account) return false;
      if (entries.size >= maxEntries) entries.clear();
      entries.set(Number(userId), {
        account: Object.freeze({ role: account.role, active: account.active, approval_status: account.approval_status }),
        expiresAt: now() + ttlMs
      });
      return true;
    },
    invalidateAll() {
      generation++;
      entries.clear();
    },
    size() { return entries.size; }
  };
}
