const ANOTAAI_GATEWAY = "https://gateway-partners.anota.ai";
const ANOTAAI_AUTH_URL = `${ANOTAAI_GATEWAY}/integ/integ-oauth-api/oauth-client/token`;
const ANOTAAI_ORDERS_BASE = `${ANOTAAI_GATEWAY}/api-old/partnerauth/v2`;
const ANOTAAI_LINK_URL = `${ANOTAAI_GATEWAY}/integ/integ-public-core/v2/integration-partner/linkpage-by-token`;

export const ANOTAAI_ORDER_STATUS = Object.freeze({
  0: "ANALYSIS",
  1: "PRODUCTION",
  2: "READY",
  3: "FINISHED",
  4: "CANCELLED",
  5: "DENIED",
  6: "CANCELLATION_REQUESTED"
});

export function decodeAnotaAiJwt(token) {
  const value = String(token || "").trim();
  const parts = value.split(".");
  if (parts.length < 2 || !parts[1]) return null;

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(normalized + padding, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function anotaAiPageIdFromTokens(...tokens) {
  for (const token of tokens) {
    const payload = decodeAnotaAiJwt(token);
    const pageId = payload?.idpage ?? payload?.pageId ?? payload?.page_id;
    if (pageId !== null && pageId !== undefined && String(pageId).trim()) {
      return String(pageId).trim();
    }
  }
  return null;
}

function firstValue(...values) {
  return values.find(value => value !== null && value !== undefined && String(value).trim() !== "");
}

export function normalizeAnotaAiOrder(order, fallback = {}) {
  const source = order && typeof order === "object" ? order : {};
  const statusCodeRaw = firstValue(source.check, fallback.check);
  const statusCode = Number.isFinite(Number(statusCodeRaw)) ? Number(statusCodeRaw) : null;
  const orderId = String(firstValue(source._id, source.id, fallback._id, fallback.id) || "").trim();
  const displayId = String(firstValue(
    source.displayId,
    source.display_id,
    source.orderNumber,
    source.order_number,
    source.number,
    source.shortReference,
    source.reference,
    orderId
  ) || "").trim();
  const customer = source.customer && typeof source.customer === "object" ? source.customer : {};

  return {
    orderId,
    displayId,
    statusCode,
    status: ANOTAAI_ORDER_STATUS[statusCode] || "UNKNOWN",
    salesChannel: String(firstValue(source.salesChannel, source.sales_channel, source.from, fallback.salesChannel, "anotaai")),
    orderType: String(firstValue(source.type, source.orderType, source.order_type, fallback.type, "UNKNOWN")),
    customerName: String(firstValue(customer.name, source.customerName, source.customer_name, "")),
    remoteCreatedAt: firstValue(source.createdAt, source.created_at, fallback.createdAt, fallback.created_at) || null,
    remoteUpdatedAt: firstValue(source.updatedAt, source.updated_at, fallback.updatedAt, fallback.updated_at) || null,
    payload: source
  };
}

function safeBody(body) {
  if (typeof body === "string") return body.slice(0, 500);
  if (!body || typeof body !== "object") return body;
  const copy = { ...body };
  for (const key of ["accessToken", "access_token", "token", "client_secret", "clientSecret"]) {
    if (key in copy) copy[key] = "[REDACTED]";
  }
  return copy;
}

export function createAnotaAiClient({
  clientId,
  clientSecret,
  userAgent = "DespacheFull/3.6.1 (production; Node.js/22)",
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000
} = {}) {
  const credentials = {
    clientId: String(clientId || "").trim(),
    clientSecret: String(clientSecret || "").trim()
  };
  let tokenCache = { accessToken: null, expiresAt: 0 };

  function configured() {
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "User-Agent": userAgent,
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) {
      const error = new Error(`Anota AI HTTP ${response.status}`);
      error.statusCode = response.status;
      error.anotaAiBody = safeBody(body);
      throw error;
    }
    return { response, body };
  }

  async function getAccessToken(force = false) {
    if (!configured()) {
      const error = new Error("Credenciais do Anota AI não configuradas no servidor.");
      error.status = 503;
      throw error;
    }
    const now = Date.now();
    if (!force && tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
      return tokenCache.accessToken;
    }
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    });
    const { body } = await fetchJson(ANOTAAI_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    const accessToken = body?.accessToken ?? body?.access_token;
    const expiresIn = Number(body?.expiresIn ?? body?.expires_in ?? 3600);
    if (!accessToken) throw new Error("Anota AI autenticou sem retornar accessToken.");
    tokenCache = {
      accessToken: String(accessToken),
      expiresAt: now + Math.max(300, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000
    };
    return tokenCache.accessToken;
  }

  async function authorizedFetch(url, options = {}) {
    let accessToken = await getAccessToken(false);
    const run = token => fetchJson(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    try {
      return await run(accessToken);
    } catch (error) {
      if (error?.statusCode !== 401) throw error;
      accessToken = await getAccessToken(true);
      return run(accessToken);
    }
  }

  function pageHeaders(pageId) {
    const id = String(pageId || "").trim();
    if (!id) throw new Error("ID da página Anota AI não informado.");
    return { "x-page-id": id, "Content-Type": "application/json" };
  }

  async function listOrders(pageId, { currentPage = 1 } = {}) {
    const url = new URL(`${ANOTAAI_ORDERS_BASE}/ping/list`);
    url.searchParams.set("currentpage", String(Math.max(1, Number(currentPage) || 1)));
    const { body } = await authorizedFetch(url, { headers: pageHeaders(pageId) });
    return body;
  }

  async function getOrder(pageId, orderId) {
    const id = String(orderId || "").trim();
    if (!id) throw new Error("ID do pedido Anota AI não informado.");
    const { body } = await authorizedFetch(
      `${ANOTAAI_ORDERS_BASE}/ping/get/${encodeURIComponent(id)}`,
      { headers: pageHeaders(pageId) }
    );
    return body;
  }

  async function linkPage(pageToken) {
    const token = String(pageToken || "").trim();
    if (!token) throw new Error("Chave de integração da loja não informada.");
    const { body } = await authorizedFetch(ANOTAAI_LINK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageToken: token, active: true })
    });
    if (body?.success === false) throw new Error(String(body?.message || "O Anota AI recusou o vínculo da loja."));
    return {
      linked: true,
      pageId: anotaAiPageIdFromTokens(body?.info?.token, token),
      message: String(body?.message || "Loja vinculada com sucesso.")
    };
  }

  return {
    configured,
    getAccessToken,
    listOrders,
    getOrder,
    linkPage
  };
}

export const ANOTAAI_ENDPOINTS = Object.freeze({
  auth: ANOTAAI_AUTH_URL,
  orders: ANOTAAI_ORDERS_BASE,
  link: ANOTAAI_LINK_URL
});
