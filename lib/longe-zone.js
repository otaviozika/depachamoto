// Regra LONGE: entregas fora da zona de 6,7 km pela rota do Google, partindo da loja.
// A zona é gerada uma única vez com a Routes API (sem trânsito ao vivo) e salva no banco;
// a classificação de cada pedido é feita localmente contra o polígono salvo.

export const LONGE_RADIUS_METERS = 6700;
export const LONGE_MULTIPLIER = 2;
export const LONGE_MODES = Object.freeze(["OFF", "TEST", "ACTIVE"]);

export const LONGE_STORE = Object.freeze({
  name: "Old Man",
  address: "R. Tapajós, 846 - Barcelona, São Caetano do Sul - SP, 09551-230, Brasil",
  // Estimativa pelos pedidos já entregues na própria R. Tapajós (nº 738 e 946).
  // Serve só para conferir a geocodificação do Google antes de gerar a zona.
  approx: Object.freeze({ latitude: -23.62446, longitude: -46.55491 }),
  maxGeocodeDriftMeters: 400
});

export const LONGE_ROUTE_SETTINGS = Object.freeze({
  travelMode: "DRIVE",
  routingPreference: "TRAFFIC_UNAWARE"
});

export const LONGE_ZONE_DEFAULTS = Object.freeze({
  bearings: 96,
  minRadiusMeters: 1000,
  maxRadiusMeters: 7600,
  stepMeters: 200,
  refineIterations: 4,
  confirmSamples: 2
});

const EARTH_RADIUS_METERS = 6371008.8;
const ROUTES_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const ROUTES_DIRECTIONS_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX_MAX_DESTINATIONS = 500;
const MATRIX_MAX_ORIGINS = 25;
const radians = value => value * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;

export function routesApiKey(env = process.env) {
  return String(env.GOOGLE_ROUTES_API_KEY || "").trim();
}

export function validCoordinate(point) {
  if ([point?.latitude, point?.longitude].some(v => v === null || v === undefined || v === "")) return false;
  const latitude = Number(point.latitude), longitude = Number(point.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
}

export function haversineMeters(a, b) {
  const dLat = radians(b.latitude - a.latitude), dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function destinationPoint(origin, bearingDegrees, distanceMeters) {
  const delta = distanceMeters / EARTH_RADIUS_METERS, theta = radians(bearingDegrees);
  const phi1 = radians(origin.latitude), lambda1 = radians(origin.longitude);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return { latitude: degrees(phi2), longitude: ((degrees(lambda2) + 540) % 360) - 180 };
}

// Polígono salvo como [[lat,lng], ...], sem repetir o primeiro vértice no fim.
export function normalizePolygon(polygon) {
  const list = (Array.isArray(polygon) ? polygon : []).map(vertex => Array.isArray(vertex)
    ? [Number(vertex[0]), Number(vertex[1])]
    : [Number(vertex?.latitude), Number(vertex?.longitude)]);
  if (list.length > 1) {
    const [first, last] = [list[0], list[list.length - 1]];
    if (first[0] === last[0] && first[1] === last[1]) list.pop();
  }
  if (list.length < 3 || list.some(([lat, lng]) => !validCoordinate({ latitude: lat, longitude: lng }))) {
    throw Object.assign(new Error("Polígono da zona LONGE inválido."), { code: "LONGE_ZONE_INVALID", status: 500 });
  }
  return list;
}

// Borda exata: um ponto sobre a linha do polígono fica DENTRO da zona (não é LONGE).
// A tolerância só absorve arredondamento de ponto flutuante (~1 cm), não é uma margem.
const BOUNDARY_EPSILON = 1e-7;
function onSegment(lat, lng, [aLat, aLng], [bLat, bLng]) {
  const cross = (bLat - aLat) * (lng - aLng) - (bLng - aLng) * (lat - aLat);
  const length = Math.hypot(bLat - aLat, bLng - aLng) || 1;
  if (Math.abs(cross) / length > BOUNDARY_EPSILON) return false;
  return lat >= Math.min(aLat, bLat) - BOUNDARY_EPSILON && lat <= Math.max(aLat, bLat) + BOUNDARY_EPSILON &&
    lng >= Math.min(aLng, bLng) - BOUNDARY_EPSILON && lng <= Math.max(aLng, bLng) + BOUNDARY_EPSILON;
}

export function pointPositionInPolygon(point, polygon) {
  const vertices = normalizePolygon(polygon);
  const lat = Number(point.latitude), lng = Number(point.longitude);
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    if (onSegment(lat, lng, a, b)) return "BOUNDARY";
    if ((a[1] > lng) !== (b[1] > lng)) {
      const crossingLat = a[0] + (lng - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (lat < crossingLat) inside = !inside;
    }
  }
  return inside ? "INSIDE" : "OUTSIDE";
}

export function classifyLongePoint(point, polygon) {
  if (!validCoordinate(point)) return { status: "NO_LOCATION", position: null };
  const position = pointPositionInPolygon(point, polygon);
  return { status: position === "OUTSIDE" ? "LONGE" : "NORMAL", position };
}

export function longeUnitAmount(perDelivery) {
  return Math.round((Number(perDelivery || 0) * LONGE_MULTIPLIER + Number.EPSILON) * 100) / 100;
}

// Agrupa endereços próximos numa grade fixa (padrão ~100 m) ancorada na loja, para
// consultar o Google uma vez por grupo. O ponto consultado é o centróide do grupo.
export function clusterPoints(points, { cellMeters = 100, anchor = LONGE_STORE.approx } = {}) {
  const latStep = cellMeters / 111320;
  const lngStep = cellMeters / (111320 * Math.cos(radians(anchor.latitude)));
  const clusters = new Map();
  (Array.isArray(points) ? points : []).forEach((point, index) => {
    if (!validCoordinate(point)) return;
    const row = Math.floor((point.latitude - anchor.latitude) / latStep);
    const col = Math.floor((point.longitude - anchor.longitude) / lngStep);
    const key = `${cellMeters}:${row}:${col}`;
    const cluster = clusters.get(key) || { key, latSum: 0, lngSum: 0, count: 0, members: [] };
    cluster.latSum += Number(point.latitude); cluster.lngSum += Number(point.longitude);
    cluster.count += 1; cluster.members.push(index);
    clusters.set(key, cluster);
  });
  return [...clusters.values()].map(c => ({ key: c.key, latitude: c.latSum / c.count, longitude: c.lngSum / c.count, count: c.count, members: c.members }));
}

function routesError(message, extra = {}) {
  return Object.assign(new Error(message), { status: 502, code: "GOOGLE_ROUTES_FAILED", ...extra });
}

function latLngWaypoint(point) {
  return { waypoint: { location: { latLng: { latitude: Number(point.latitude), longitude: Number(point.longitude) } } } };
}

async function readRoutesResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const detail = (Array.isArray(data) ? data[0] : data)?.error?.message || `HTTP ${response.status}`;
    throw routesError(`Google Routes recusou a consulta: ${detail}`, { status: response.status === 403 ? 503 : 502 });
  }
  return data;
}

export function createRoutesClient({ apiKey = routesApiKey(), fetchFn = fetch, timeoutMs = 60000, settings = LONGE_ROUTE_SETTINGS } = {}) {
  if (!apiKey) throw Object.assign(new Error("Configure GOOGLE_ROUTES_API_KEY no Render para usar a rota do Google."), { status: 503, code: "GOOGLE_ROUTES_NOT_CONFIGURED" });
  let elements = 0;
  const post = async (url, fieldMask, body) => readRoutesResponse(await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  }));
  return {
    get elements() { return elements; },
    // Distância pela rota (metros) da origem até cada destino; null quando não há rota.
    async distancesFrom(origin, destinations) {
      const list = Array.isArray(destinations) ? destinations : [];
      const out = new Array(list.length).fill(null);
      for (let start = 0; start < list.length; start += MATRIX_MAX_DESTINATIONS) {
        const chunk = list.slice(start, start + MATRIX_MAX_DESTINATIONS);
        const data = await post(ROUTES_MATRIX_URL, "originIndex,destinationIndex,distanceMeters,duration,condition,status", {
          origins: [latLngWaypoint(origin)],
          destinations: chunk.map(latLngWaypoint),
          travelMode: settings.travelMode,
          routingPreference: settings.routingPreference
        });
        elements += chunk.length;
        for (const item of Array.isArray(data) ? data : []) {
          const index = Number(item?.destinationIndex ?? 0);
          if (!Number.isInteger(index) || index < 0 || index >= chunk.length) continue;
          const failed = item?.status?.code && Number(item.status.code) !== 0;
          const exists = !failed && (item?.condition === undefined || item.condition === "ROUTE_EXISTS");
          const meters = Number(item?.distanceMeters ?? (exists ? 0 : NaN));
          out[start + index] = exists && Number.isFinite(meters) ? meters : null;
        }
      }
      return out;
    },
    // Ponto de partida que o próprio Google usa para o endereço da loja.
    async resolveAddress(address, near) {
      return locate(address, near, "O Google não localizou o endereço da loja.", "GOOGLE_ROUTES_STORE_NOT_FOUND");
    },
    // Ponto de um endereço de entrega (validado depois por quem chamou).
    async geocodeAddress(address, near) {
      return locate(address, near, "O Google não localizou esse endereço.", "GOOGLE_ROUTES_ADDRESS_NOT_FOUND");
    },
    // Tempos (s) e distâncias (m) entre todos os pares de pontos, sem trânsito ao vivo.
    // null quando o Google não tem rota para o trecho; a diagonal é 0.
    async travelMatrix(points) {
      const list = Array.isArray(points) ? points : [];
      if (!list.length || list.length > MATRIX_MAX_ORIGINS) throw routesError("Matriz com quantidade de pontos inválida.", { code: "GOOGLE_ROUTES_MATRIX_SIZE" });
      const seconds = list.map((_, i) => list.map((__, j) => i === j ? 0 : null));
      const meters = list.map((_, i) => list.map((__, j) => i === j ? 0 : null));
      const data = await post(ROUTES_MATRIX_URL, "originIndex,destinationIndex,distanceMeters,duration,condition,status", {
        origins: list.map(latLngWaypoint),
        destinations: list.map(latLngWaypoint),
        travelMode: settings.travelMode,
        routingPreference: settings.routingPreference
      });
      elements += list.length * list.length;
      for (const item of Array.isArray(data) ? data : []) {
        const i = Number(item?.originIndex ?? 0), j = Number(item?.destinationIndex ?? 0);
        if (![i, j].every(k => Number.isInteger(k) && k >= 0 && k < list.length) || i === j) continue;
        const failed = item?.status?.code && Number(item.status.code) !== 0;
        const exists = !failed && (item?.condition === undefined || item.condition === "ROUTE_EXISTS");
        const duration = Number.parseFloat(String(item?.duration ?? ""));
        if (!exists || !Number.isFinite(duration)) continue;
        seconds[i][j] = duration;
        meters[i][j] = Number.isFinite(Number(item?.distanceMeters)) ? Number(item.distanceMeters) : null;
      }
      return { seconds, meters };
    }
  };
  async function locate(address, near, message, code) {
    const data = await post(ROUTES_DIRECTIONS_URL, "routes.legs.startLocation,routes.distanceMeters", {
      origin: { address },
      destination: latLngWaypoint(destinationPoint(near, 90, 300)).waypoint,
      travelMode: settings.travelMode,
      routingPreference: settings.routingPreference
    });
    elements += 1;
    const latLng = data?.routes?.[0]?.legs?.[0]?.startLocation?.latLng;
    const point = { latitude: Number(latLng?.latitude), longitude: Number(latLng?.longitude) };
    if (!validCoordinate(point)) throw routesError(message, { code });
    return point;
  }
}

export async function resolveStoreOrigin(client, store = LONGE_STORE) {
  const point = await client.resolveAddress(store.address, store.approx);
  const drift = haversineMeters(point, store.approx);
  if (drift > store.maxGeocodeDriftMeters) {
    throw Object.assign(new Error(`O Google localizou a loja a ${Math.round(drift)} m do esperado para ${store.address}. A zona não foi gerada.`), { status: 409, code: "LONGE_STORE_GEOCODE_DRIFT" });
  }
  return { ...point, drift_meters: Math.round(drift) };
}

// Fronteira de um raio: o último ponto ≤ limite seguido de `confirm` pontos acima do
// limite. Um ponto isolado acima (alça de viaduto) ou abaixo (atalho) não decide a borda.
export function rayBoundaryIndex(distances, limit, confirm = LONGE_ZONE_DEFAULTS.confirmSamples) {
  const known = distances.map((d, i) => ({ d, i })).filter(x => Number.isFinite(x.d));
  for (let k = 0; k < known.length; k++) {
    if (known[k].d > limit) continue;
    const next = known.slice(k + 1, k + 1 + confirm);
    if (next.length === 0) return { index: known[k].i, capped: true };
    if (next.every(x => x.d > limit)) return { index: known[k].i, capped: false, next: next[0].i };
  }
  return { index: -1, capped: false, next: known[0]?.i ?? 0 };
}

// Gera o polígono por raios a partir da loja. `distancesFn(points)` devolve a distância
// pela rota até cada ponto (null sem rota). Sem trânsito ao vivo fica a cargo do cliente.
export async function generateLongeZonePolygon({ origin, distancesFn, radiusMeters = LONGE_RADIUS_METERS, options = {}, onProgress = () => {} }) {
  const cfg = { ...LONGE_ZONE_DEFAULTS, ...options };
  const radii = [];
  for (let r = cfg.minRadiusMeters; r <= cfg.maxRadiusMeters + 1e-6; r += cfg.stepMeters) radii.push(r);
  const bearings = Array.from({ length: cfg.bearings }, (_, i) => i * 360 / cfg.bearings);
  const samples = bearings.flatMap(bearing => radii.map(radius => ({ bearing, radius, point: destinationPoint(origin, bearing, radius) })));
  onProgress({ phase: "SAMPLES", total: samples.length });
  const sampled = await distancesFn(samples.map(s => s.point));
  const rays = bearings.map((bearing, b) => {
    const distances = radii.map((_, r) => sampled[b * radii.length + r]);
    const found = rayBoundaryIndex(distances, radiusMeters, cfg.confirmSamples);
    if (found.index < 0) return { bearing, lo: { r: 0, d: 0 }, hi: { r: radii[found.next], d: distances[found.next] }, capped: false, inner: true };
    if (found.capped) return { bearing, lo: { r: radii[found.index], d: distances[found.index] }, hi: null, capped: true };
    return { bearing, lo: { r: radii[found.index], d: distances[found.index] }, hi: { r: radii[found.next], d: distances[found.next] }, capped: false };
  });
  for (let round = 0; round < cfg.refineIterations; round++) {
    const open = rays.filter(ray => ray.hi && ray.hi.r - ray.lo.r > 1);
    if (!open.length) break;
    onProgress({ phase: "REFINE", round: round + 1, total: open.length });
    const mids = open.map(ray => (ray.lo.r + ray.hi.r) / 2);
    const distances = await distancesFn(open.map((ray, i) => destinationPoint(origin, ray.bearing, mids[i])));
    open.forEach((ray, i) => {
      const d = distances[i];
      if (!Number.isFinite(d)) return;
      if (d <= radiusMeters) ray.lo = { r: mids[i], d }; else ray.hi = { r: mids[i], d };
    });
  }
  const boundary = rays.map(ray => {
    let radius = ray.lo.r;
    if (ray.hi && Number.isFinite(ray.hi.d) && ray.hi.d > ray.lo.d) {
      radius = ray.lo.r + (radiusMeters - ray.lo.d) / (ray.hi.d - ray.lo.d) * (ray.hi.r - ray.lo.r);
      radius = Math.min(ray.hi.r, Math.max(ray.lo.r, radius));
    }
    return { bearing: ray.bearing, radius_meters: Math.round(radius), capped: !!ray.capped };
  });
  const polygon = boundary.map(ray => {
    const p = destinationPoint(origin, ray.bearing, ray.radius_meters);
    return [Math.round(p.latitude * 1e6) / 1e6, Math.round(p.longitude * 1e6) / 1e6];
  });
  return { polygon: normalizePolygon(polygon), rays: boundary, settings: cfg };
}

// Janela de teste: o primeiro fim de semana completo (sexta 11:00 até segunda 02:00,
// horário de Brasília) depois do início do teste. Só então o pagamento pode ser ativado.
const SP_OFFSET = "-03:00";
function spDateParts(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday) };
}

export function longeTestWeekend(testStartedAt) {
  const start = new Date(testStartedAt);
  if (Number.isNaN(start.getTime())) return null;
  const { date, weekday } = spDateParts(start);
  let friday = new Date(`${date}T11:00:00${SP_OFFSET}`);
  friday = new Date(friday.getTime() + ((5 - weekday + 7) % 7) * 86400000);
  if (friday < start) friday = new Date(friday.getTime() + 7 * 86400000);
  return { starts_at: friday.toISOString(), ends_at: new Date(friday.getTime() + 63 * 3600000).toISOString() };
}

export function modeAt(history, at) {
  const time = new Date(at).getTime();
  let current = "OFF";
  for (const entry of [...(history || [])].sort((a, b) => new Date(a.effective_at) - new Date(b.effective_at) || Number(a.id || 0) - Number(b.id || 0))) {
    if (new Date(entry.effective_at).getTime() <= time) current = entry.mode;
  }
  return current;
}

// Prévia: quantas entregas teriam sido LONGE por mês e quais bairros ficam na borda.
export function summarizeLongePreview(deliveries, distanceFor, { radiusMeters = LONGE_RADIUS_METERS, borderBandMeters = 500 } = {}) {
  const months = new Map(), hoods = new Map();
  for (const delivery of deliveries) {
    const month = String(delivery.month || "").slice(0, 7);
    const m = months.get(month) || { month, deliveries: 0, located: 0, longe: 0, normal: 0, no_route: 0 };
    m.deliveries += 1;
    const distance = validCoordinate(delivery) ? distanceFor(delivery) : undefined;
    if (distance !== undefined) m.located += 1;
    if (Number.isFinite(distance)) {
      if (distance > radiusMeters) m.longe += 1; else m.normal += 1;
      const name = String(delivery.neighborhood || "").trim() || "(sem bairro)";
      const city = String(delivery.city || "").trim();
      const key = `${name.toLocaleLowerCase("pt-BR")}|${city.toLocaleLowerCase("pt-BR")}`;
      const h = hoods.get(key) || { neighborhood: name, city, deliveries: 0, normal: 0, longe: 0, in_band: 0, distances: [] };
      h.deliveries += 1; h.distances.push(distance);
      if (distance > radiusMeters) h.longe += 1; else h.normal += 1;
      if (Math.abs(distance - radiusMeters) <= borderBandMeters) h.in_band += 1;
      hoods.set(key, h);
    } else if (distance === null) m.no_route += 1;
    months.set(month, m);
  }
  const monthRows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ ...m, longe_pct: m.normal + m.longe ? Math.round(m.longe * 1000 / (m.normal + m.longe)) / 10 : 0 }));
  const border = [...hoods.values()].filter(h => h.in_band > 0 || (h.normal > 0 && h.longe > 0)).map(h => {
    const sorted = h.distances.sort((a, b) => a - b);
    return { neighborhood: h.neighborhood, city: h.city, deliveries: h.deliveries, normal: h.normal, longe: h.longe, in_band: h.in_band,
      min_meters: Math.round(sorted[0]), median_meters: Math.round(sorted[Math.floor(sorted.length / 2)]), max_meters: Math.round(sorted[sorted.length - 1]) };
  }).sort((a, b) => b.in_band - a.in_band || b.deliveries - a.deliveries);
  const totals = monthRows.reduce((t, m) => ({ deliveries: t.deliveries + m.deliveries, located: t.located + m.located, longe: t.longe + m.longe, normal: t.normal + m.normal, no_route: t.no_route + m.no_route }),
    { deliveries: 0, located: 0, longe: 0, normal: 0, no_route: 0 });
  return { radius_meters: radiusMeters, border_band_meters: borderBandMeters, months: monthRows, totals, border_neighborhoods: border };
}
