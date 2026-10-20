// Serviço de rotas da conferência de sacolas: tempos pelas vias (matriz) e localização de
// endereços. Sem trânsito ao vivo nos dois serviços.
// - openrouteservice (OpenStreetMap): plano gratuito com chave, sem cartão.
// - Google Routes: usado automaticamente quando GOOGLE_ROUTES_API_KEY existe.
import { createRoutesClient, routesApiKey, validCoordinate } from "./longe-zone.js";

const ORS_BASE_URL = "https://api.openrouteservice.org";
const ORS_MAX_LOCATIONS = 50;
export const ORS_ATTRIBUTION = "© openrouteservice.org by HeiGIT · dados © OpenStreetMap";

export function openRouteServiceKey(env = process.env) {
  return String(env.OPENROUTESERVICE_API_KEY || "").trim();
}

export function configuredRouteProvider(env = process.env) {
  if (routesApiKey(env)) return "google";
  if (openRouteServiceKey(env)) return "openrouteservice";
  return null;
}

function providerError(message, extra = {}) {
  return Object.assign(new Error(message), { status: 503, ...extra });
}

export function createTravelClient({ env = process.env, fetchFn = fetch } = {}) {
  const provider = configuredRouteProvider(env);
  if (provider === "google") {
    return Object.assign(createRoutesClient({ apiKey: routesApiKey(env), fetchFn }), { provider, label: "Google Routes", attribution: null });
  }
  if (provider === "openrouteservice") return createOpenRouteServiceClient({ apiKey: openRouteServiceKey(env), fetchFn });
  throw providerError("Rota indisponível: configure OPENROUTESERVICE_API_KEY (gratuita) ou GOOGLE_ROUTES_API_KEY no Render.", { code: "ROUTES_NOT_CONFIGURED" });
}

export function createOpenRouteServiceClient({ apiKey, fetchFn = fetch, timeoutMs = 20000, baseUrl = ORS_BASE_URL } = {}) {
  if (!apiKey) throw providerError("Configure OPENROUTESERVICE_API_KEY no Render para calcular rotas.", { code: "ROUTES_NOT_CONFIGURED" });
  let elements = 0;
  const hide = text => String(text || "").split(apiKey).join("[chave]");

  async function call(url, options = {}) {
    let response;
    try {
      response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw providerError(`openrouteservice não respondeu: ${hide(e.message)}`, { code: "ROUTES_SERVICE_FAILED" });
    }
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok) {
      const detail = hide(data?.error?.message || data?.error || data?.message || raw).slice(0, 200);
      throw providerError(`openrouteservice recusou (${response.status}): ${detail}`, {
        code: response.status === 429 ? "ROUTES_RATE_LIMITED" : response.status === 401 || response.status === 403 ? "ROUTES_KEY_REJECTED" : "ROUTES_SERVICE_FAILED"
      });
    }
    return data;
  }

  async function geocode(address, near) {
    const params = new URLSearchParams({ api_key: apiKey, text: String(address || ""), "boundary.country": "BR", size: "1" });
    if (validCoordinate(near)) {
      params.set("focus.point.lat", String(near.latitude));
      params.set("focus.point.lon", String(near.longitude));
    }
    const data = await call(`${baseUrl}/geocode/search?${params}`, { headers: { Accept: "application/json" } });
    elements += 1;
    const feature = Array.isArray(data?.features) ? data.features[0] : null;
    const [longitude, latitude] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates.map(Number) : [];
    const point = { latitude, longitude };
    if (!feature || !validCoordinate(point)) {
      throw providerError("O serviço de rotas não localizou esse endereço.", { code: "ROUTES_ADDRESS_NOT_FOUND" });
    }
    const p = feature.properties || {};
    // Preciso = número da casa (ou estabelecimento) com confiança alta; rua ou bairro não serve.
    const precise = ["address", "venue"].includes(p.layer) && Number(p.confidence || 0) >= 0.8 && p.match_type !== "fallback";
    return { latitude, longitude, precise, label: p.label || null, layer: p.layer || null, confidence: p.confidence ?? null };
  }

  return {
    provider: "openrouteservice",
    label: "openrouteservice (OpenStreetMap)",
    attribution: ORS_ATTRIBUTION,
    get elements() { return elements; },
    // Tempos (s) e distâncias (m) entre todos os pares; null quando não há rota.
    async travelMatrix(points) {
      const list = Array.isArray(points) ? points : [];
      if (!list.length || list.length > ORS_MAX_LOCATIONS) throw providerError("Matriz com quantidade de pontos inválida.", { code: "ROUTES_MATRIX_SIZE" });
      const data = await call(`${baseUrl}/v2/matrix/driving-car`, {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ locations: list.map(p => [Number(p.longitude), Number(p.latitude)]), metrics: ["duration", "distance"], units: "m" })
      });
      elements += list.length * list.length;
      const cell = (matrix, i, j) => {
        if (i === j) return 0;
        const v = matrix?.[i]?.[j];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      return {
        seconds: list.map((_, i) => list.map((__, j) => cell(data?.durations, i, j))),
        meters: list.map((_, i) => list.map((__, j) => cell(data?.distances, i, j)))
      };
    },
    async geocodeAddress(address, near) {
      return geocode(address, near);
    },
    // Loja: só aceita localização precisa; senão o admin confirma o ponto no mapa.
    async resolveAddress(address, near) {
      const found = await geocode(address, near);
      if (!found.precise) throw providerError("O serviço de rotas não achou o número da loja com precisão. Confirme o local da loja no mapa.", { code: "ROUTES_STORE_IMPRECISE" });
      return { latitude: found.latitude, longitude: found.longitude };
    }
  };
}
