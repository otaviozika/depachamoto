import crypto from "crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

// Aceita a chave privada colada no Render nos formatos comuns: PEM com quebras,
// o valor copiado do .json (com \n literais, inclusive duplamente escapados),
// com aspas/vírgula em volta, o JSON inteiro da conta de serviço, ou com as
// quebras de linha perdidas. O conteúdo é reconstruído no PEM padrão.
function normalizePrivateKey(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.private_key === "string") raw = parsed.private_key.trim();
    } catch { /* não é JSON válido: segue com o texto original */ }
  }
  raw = raw.replace(/,\s*$/, "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  raw = raw.replace(/\\+n/g, "\n").replace(/\\+r/g, "").replace(/\r/g, "");
  const pem = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!pem) return raw.trim();
  const body = pem[2].replace(/[^A-Za-z0-9+/=]/g, "");
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${pem[1]}-----\n${lines.join("\n")}\n-----END ${pem[1]}-----\n`;
}

export function googleSheetsConfig(env = process.env) {
  let clientEmail = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim().replace(/,\s*$/, "").replace(/^["']|["']$/g, "").trim();
  if (!clientEmail && String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").trim().startsWith("{")) {
    try { clientEmail = String(JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).client_email || "").trim(); } catch { /* ignora */ }
  }
  const privateKey = normalizePrivateKey(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const spreadsheetId = String(env.GOOGLE_SHEETS_SPREADSHEET_ID || "").trim();
  return {
    configured: Boolean(clientEmail && privateKey && spreadsheetId),
    clientEmail,
    privateKey,
    spreadsheetId,
    spreadsheetUrl: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit` : null,
    tabPrefix: String(env.GOOGLE_SHEETS_TAB_PREFIX || "Pagamentos").trim().slice(0, 40) || "Pagamentos"
  };
}

export function googleSheetsCredentialsConfigured(env = process.env) {
  const config = googleSheetsConfig(env);
  return Boolean(config.clientEmail && config.privateKey);
}

export function paymentDaySheetTitle(date, shiftCode) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(String(date || ""))) {
    throw Object.assign(new Error("Data inválida para o fechamento."), { status: 400, code: "PAYMENT_DAY_INVALID" });
  }
  const shift = String(shiftCode || "").trim().toUpperCase();
  if (!["LUNCH", "DINNER"].includes(shift)) {
    throw Object.assign(new Error("Selecione almoço ou janta para fechar o dia."), { status: 400, code: "PAYMENT_SHIFT_INVALID" });
  }
  const [year, month, day] = String(date).split("-").map(Number);
  const base = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  const letter = ["D", "S", "T", "Q", "Q", "S", "S"][new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
  return `${base} ${letter}`;
}

// As planilhas usam dois formatos de aba: "13/10 T" (janta, com a inicial do
// dia da semana) e "13/10" (almoço). A busca aceita os dois, sempre ancorada no
// dia/mês exato, e nunca escolhe entre duas abas candidatas por conta própria.
export function findPaymentDayTab(sheets, date, shiftCode) {
  const expected = paymentDaySheetTitle(date, shiftCode);
  const dayMonth = expected.slice(0, 5);
  const list = (Array.isArray(sheets) ? sheets : []).map(item => item?.properties || item).filter(p => typeof p?.title === "string");
  const exact = list.find(p => p.title === expected);
  if (exact) return exact;
  // Planilhas de novembro/2026 misturam DDMM X (ex.: 0311 T) e DD/MM X.
  // Preservar os titulos reais: nunca renomear abas nem escolher datas proximas.
  const day = dayMonth.slice(0, 2), month = dayMonth.slice(3, 5);
  const pattern = new RegExp(`^${day}/?${month}(?:\\s+[DSTQ])?$`, "i");
  const candidates = list.filter(p => pattern.test(p.title.trim().replace(/\s+/g, " ")));
  if (candidates.length > 1) {
    throw Object.assign(new Error(`Há mais de uma aba para ${dayMonth} na planilha (${candidates.map(p => p.title).join(", ")}). Deixe apenas uma.`), { status: 409, code: "PAYMENT_DAY_TAB_AMBIGUOUS" });
  }
  return candidates[0] || null;
}

function normalizedSheetPaymentMethod(value) {
  const method = String(value || "").trim();
  if (method.toUpperCase() === "DINHEIRO") return "Dinheiro";
  if (method.toUpperCase() === "DÉBITO" || method.toUpperCase() === "DEBITO") return "Débito";
  if (method.toUpperCase() === "CRÉDITO" || method.toUpperCase() === "CREDITO") return "Crédito";
  return method.toUpperCase() === "PIX" ? "PIX" : "";
}

export function paymentRowsToDailySheetData(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length > 197) {
    throw Object.assign(new Error("A aba diária comporta no máximo 197 motoboys."), { status: 400, code: "PAYMENT_DAY_ROW_LIMIT" });
  }
  return {
    names: source.map(row => [row.courier_name || ""]),
    pix: source.map(row => {
      const key = String(row.pix_key ?? "").trim();
      return [key, key ? String(row.pix_type ?? "").trim() : ""];
    }),
    payments: source.map(row => {
      const encosta = Number(row.base_amount || 0) + (row.rain ? Number(row.rain_bonus || 0) : 0) + Number(row.adjustment_amount || 0);
      return [
        Number(row.delivery_count || 0),
        Math.round(encosta * 100) / 100,
        Number(row.tip_amount || 0) || "",
        Number(row.discount_amount || 0) || "",
        normalizedSheetPaymentMethod(row.payment_method),
        row.status === "PAID" ? "Sim" : "Não"
      ];
    }),
    notes: source.map(row => [row.notes || ""]),
    // LONGE: colunas N:P ao lado das observações (Normais, Longas, Valor longa).
    longe: source.map(row => {
      const total = Number(row.delivery_count || 0), longe = Math.min(total, Number(row.longe_count || 0));
      const unit = Number(row.longe_unit_amount ?? Number(row.per_delivery || 0) * 2);
      return [total - longe, longe, Math.round(unit * 100) / 100];
    }),
    hasLonge: source.some(row => Number(row.longe_count || 0) > 0)
  };
}

// TOTAL PAGO com longas: valor por entrega = valor longa ÷ 2, sem separador de
// argumentos (a planilha usa ";" no pt-BR). Sem longas, a fórmula original fica.
export function paymentDayTotalFormula(row) {
  return `=N(E${row})*N(P${row})/2+N(O${row})*N(P${row})/2+N(F${row})+N(G${row})-N(H${row})`;
}

export function paymentSheetTitle(month, prefix = "Pagamentos") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) {
    throw Object.assign(new Error("Mês inválido para sincronização."), { status: 400, code: "PAYMENT_MONTH_INVALID" });
  }
  return `${String(prefix || "Pagamentos").trim().slice(0, 40) || "Pagamentos"} ${month}`.slice(0, 90);
}

export function paymentRowsToSheetValues(month, rows = []) {
  const header = [
    "Mês", "Data", "Motoboy", "Turno", "Entregas", "Normais", "Longas", "Valor longa", "Valor por entrega", "Base",
    "Chuva", "Adicional chuva", "Gorjeta", "Desconto", "Ajuste", "Total",
    "Forma de pagamento", "Status", "Titular PIX", "Chave PIX", "Tipo PIX",
    "Status PIX", "Observações", "Atualizado pelo DespacheFull"
  ];
  const now = new Date().toISOString();
  const values = (Array.isArray(rows) ? rows : []).map(row => [
    month,
    row.payment_date || "",
    row.courier_name || "",
    row.shift_label || "",
    Number(row.delivery_count || 0),
    Number(row.normal_count ?? row.delivery_count ?? 0),
    Number(row.longe_count || 0),
    Number(row.longe_unit_amount ?? Number(row.per_delivery || 0) * 2),
    Number(row.per_delivery || 0),
    Number(row.base_amount || 0),
    row.rain ? "SIM" : "NÃO",
    Number(row.rain_bonus || 0),
    Number(row.tip_amount || 0),
    Number(row.discount_amount || 0),
    Number(row.adjustment_amount || 0),
    Number(row.total_amount || 0),
    row.payment_method || "",
    row.status_label || row.status || "",
    row.pix_holder_name || "",
    row.pix_key || "",
    row.pix_type || "",
    row.pix_status_label || "",
    row.notes || "",
    now
  ]);
  return [header, ...values];
}

function createJwt({ clientEmail, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  let signature;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  } catch {
    throw Object.assign(new Error("A chave privada do Google no Render está incompleta ou em formato inválido. Cole novamente em GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY o valor de private_key do arquivo .json, de -----BEGIN PRIVATE KEY----- até -----END PRIVATE KEY-----."), { status: 503, code: "GOOGLE_PRIVATE_KEY_INVALID" });
  }
  return `${unsigned}.${signature}`;
}

async function readJson(response, fallbackMessage) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error_description || fallbackMessage;
    // Erro 403 especificamente de acesso a uma planilha, comum ao trocar o mes.
    // Nao mascarar 403 de quota/API nem conceder acesso automaticamente.
    if (response.status === 403 &&
        fallbackMessage === "Falha ao acessar o Google Planilhas." &&
        /(?:caller does not have permission|permission denied|not have permission|permissão|acesso negado)/i.test(String(detail))) {
      throw Object.assign(new Error("O Google Planilhas negou acesso à planilha vinculada. Compartilhe as planilhas de Almoço e Janta com a conta de serviço do DespacheFull como Editor e execute 'Testar conexão Google' novamente."), {
        status: 502, code: "GOOGLE_SHEETS_PERMISSION_DENIED"
      });
    }
    throw Object.assign(new Error(detail), { status: 502, code: "GOOGLE_SHEETS_REQUEST_FAILED" });
  }
  return data;
}

async function getAccessToken(config, fetchFn) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: createJwt(config)
  });
  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const data = await readJson(response, "Não foi possível autenticar a conta de serviço do Google.");
  if (!data.access_token) throw Object.assign(new Error("O Google não retornou um token de acesso."), { status: 502, code: "GOOGLE_SHEETS_AUTH_FAILED" });
  return data.access_token;
}

function sheetsApiUrl(spreadsheetId, suffix = "") {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${suffix}`;
}

async function googleRequest(fetchFn, token, url, options = {}) {
  const response = await fetchFn(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  return readJson(response, "Falha ao acessar o Google Planilhas.");
}

async function ensureSheet(fetchFn, token, spreadsheetId, title) {
  const metadata = await googleRequest(fetchFn, token, sheetsApiUrl(spreadsheetId, "?fields=sheets.properties"));
  const found = (metadata.sheets || []).find(item => item?.properties?.title === title)?.properties;
  if (found) return found;
  const created = await googleRequest(fetchFn, token, sheetsApiUrl(spreadsheetId, ":batchUpdate"), {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
  });
  return created.replies?.[0]?.addSheet?.properties;
}

function expectedPaymentTabsForMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) {
    throw Object.assign(new Error("Mês inválido para teste da conexão."), { status: 400, code: "PAYMENT_MONTH_INVALID" });
  }
  const [year, monthNumber] = String(month).split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => paymentDaySheetTitle(`${month}-${String(index + 1).padStart(2, "0")}`, "LUNCH"));
}

export async function testGoogleSheetsConnection({ month, lunchSpreadsheetId, dinnerSpreadsheetId, env = process.env, fetchFn = fetch }) {
  const config = googleSheetsConfig(env);
  if (!config.clientEmail || !config.privateKey) {
    throw Object.assign(new Error("A conta de serviço do Google ainda não está configurada no Render."), { status: 503, code: "GOOGLE_SHEETS_NOT_CONFIGURED" });
  }
  const lunchId = String(lunchSpreadsheetId || "").trim();
  const dinnerId = String(dinnerSpreadsheetId || "").trim();
  if (!lunchId || !dinnerId) {
    throw Object.assign(new Error("Vincule as planilhas de almoço e janta antes de testar a conexão."), { status: 409, code: "PAYMENT_SHEETS_NOT_LINKED" });
  }

  const expectedTabs = expectedPaymentTabsForMonth(month);
  const [year, monthNumber] = String(month).split("-").map(Number);
  const monthDates = Array.from({ length: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const token = await getAccessToken(config, fetchFn);
  const check = async (spreadsheetId, label) => {
    const metadata = await googleRequest(fetchFn, token, sheetsApiUrl(spreadsheetId, "?fields=properties.title,sheets.properties(title)"));
    const missingTabs = [];
    monthDates.forEach((date, index) => {
      let found = null;
      try { found = findPaymentDayTab(metadata.sheets, date, "LUNCH"); } catch { found = null; }
      if (!found) missingTabs.push(expectedTabs[index]);
    });
    return {
      label,
      ok: missingTabs.length === 0,
      spreadsheetTitle: metadata.properties?.title || null,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
      tabsFound: expectedTabs.length - missingTabs.length,
      tabsExpected: expectedTabs.length,
      missingTabs
    };
  };

  const lunch = await check(lunchId, "Almoço");
  const dinner = await check(dinnerId, "Janta");
  return {
    ok: lunch.ok && dinner.ok,
    mode: "READ_ONLY",
    serviceAccountEmail: config.clientEmail,
    month,
    lunch,
    dinner,
    checkedAt: new Date().toISOString()
  };
}

export async function syncPaymentDayToGoogleSheets({ date, shiftCode, rows, spreadsheetId, env = process.env, fetchFn = fetch }) {
  const config = googleSheetsConfig(env);
  if (!config.clientEmail || !config.privateKey) {
    throw Object.assign(new Error("A conta de serviço do Google ainda não está configurada no Render."), { status: 503, code: "GOOGLE_SHEETS_NOT_CONFIGURED" });
  }
  const targetId = String(spreadsheetId || "").trim();
  if (!targetId) throw Object.assign(new Error("A planilha deste mês ainda não foi vinculada."), { status: 409, code: "PAYMENT_SHEET_NOT_LINKED" });
  const expectedTitle = paymentDaySheetTitle(date, shiftCode);
  const data = paymentRowsToDailySheetData(rows);
  const token = await getAccessToken(config, fetchFn);
  const metadata = await googleRequest(fetchFn, token, sheetsApiUrl(targetId, "?fields=properties.title,sheets.properties"));
  const sheet = findPaymentDayTab(metadata.sheets, date, shiftCode);
  if (!Number.isInteger(sheet?.sheetId)) {
    throw Object.assign(new Error(`A aba ${expectedTitle} (ou ${expectedTitle.slice(0, 5)}) não existe na planilha vinculada.`), { status: 404, code: "PAYMENT_DAY_TAB_NOT_FOUND" });
  }
  const title = sheet.title;
  const tab = `'${title.replace(/'/g, "''")}'`;
  const valuesUrl = range => sheetsApiUrl(targetId, `/values/${encodeURIComponent(`${tab}!${range}`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const headers = await googleRequest(fetchFn, token, valuesUrl("C3:D3"));
  const [keyHeader, typeHeader] = (headers.values?.[0] || []).map(value => String(value).trim().toUpperCase());
  if (keyHeader !== "CHAVE PIX" || typeHeader !== "TIPO PIX") {
    throw Object.assign(new Error("Confira se a aba diária tem CHAVE PIX em C3 e TIPO PIX em D3."), { status: 409, code: "PAYMENT_DAY_PIX_COLUMNS_INVALID" });
  }
  const hasCadastro = (metadata.sheets || []).some(item => item.properties?.title === "Cadastro");
  const update = (startColumnIndex, endColumnIndex, values, startRowIndex = 3, endRowIndex = 200) => ({
    updateCells: {
      range: { sheetId: sheet.sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
      rows: values.map(row => ({ values: row.map(value => {
        if (value === "") return {};
        if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
        return { userEnteredValue: typeof value === "string" ? { stringValue: value } : value };
      }) })),
      fields: "userEnteredValue"
    }
  });
  const pixCells = hasCadastro ? Array.from({ length: 197 }, (_, i) => {
    if (data.pix[i]?.[0]) return data.pix[i];
    const row = i + 4;
    return ["C", "D"].map(column => ({
      formulaValue: `=IF(A${row}="";"";IFERROR(XLOOKUP(A${row};Cadastro!$A$2:$A$200;Cadastro!$${column}$2:$${column}$200;"");""))`
    }));
  }) : data.pix;
  const endRow = data.names.length + 3;
  // Retire as âncoras das ARRAYFORMULA antes de gravar C:D. O lote inteiro é atômico.
  const requests = [
    update(2, 4, [], 3, 4),
    update(0, 1, data.names),
    update(2, 4, pixCells),
    update(4, 10, data.payments),
    update(12, 13, data.notes),
    update(13, 16, data.longe)
  ];
  if (data.names.length) {
    requests.push(update(13, 16, [["NORMAIS", "LONGAS", "VALOR LONGA"]], 2, 3));
    if (data.hasLonge) {
      requests.push(update(11, 12, data.names.map((_, i) => [{ formulaValue: paymentDayTotalFormula(i + 4) }]), 3, endRow));
    }
  }
  await googleRequest(fetchFn, token, sheetsApiUrl(targetId, ":batchUpdate"), {
    method: "POST",
    body: JSON.stringify({ requests })
  });
  if (data.names.length) {
    const verified = await googleRequest(fetchFn, token, valuesUrl(`A4:D${endRow}`));
    const confirmed = verified.values || [];
    if (confirmed.length !== data.names.length || data.names.some(([name], i) => {
      const [actualName, , actualKey, actualType] = confirmed[i] || [];
      const [key, type] = data.pix[i];
      return actualName !== name || (key && (actualKey !== key || (actualType ?? "") !== type));
    })) {
      throw Object.assign(new Error("O Google Planilhas não confirmou todos os nomes e chaves Pix enviados."), { status: 502, code: "PAYMENT_DAY_VERIFY_FAILED" });
    }
  }
  return {
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(targetId)}/edit#gid=${sheet.sheetId}`,
    spreadsheetTitle: metadata.properties?.title || null,
    tabTitle: title,
    rows: data.names.length,
    syncedAt: new Date().toISOString()
  };
}

export async function syncPaymentsToGoogleSheets({ month, rows, env = process.env, fetchFn = fetch }) {
  const config = googleSheetsConfig(env);
  if (!config.configured) {
    throw Object.assign(new Error("Google Drive ainda não está configurado no Render."), { status: 503, code: "GOOGLE_SHEETS_NOT_CONFIGURED" });
  }
  const title = paymentSheetTitle(month, config.tabPrefix);
  const values = paymentRowsToSheetValues(month, rows);
  const token = await getAccessToken(config, fetchFn);
  const sheet = await ensureSheet(fetchFn, token, config.spreadsheetId, title);
  if (!Number.isInteger(sheet?.sheetId)) throw Object.assign(new Error("Não foi possível localizar a aba da planilha."), { status: 502, code: "GOOGLE_SHEETS_TAB_FAILED" });

  const range = `'${title.replace(/'/g, "''")}'!A:X`;
  await googleRequest(fetchFn, token, sheetsApiUrl(config.spreadsheetId, `/values/${encodeURIComponent(range)}:clear`), {
    method: "POST",
    body: "{}"
  });
  await googleRequest(fetchFn, token, sheetsApiUrl(config.spreadsheetId, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`), {
    method: "PUT",
    body: JSON.stringify({ range, majorDimension: "ROWS", values })
  });
  await googleRequest(fetchFn, token, sheetsApiUrl(config.spreadsheetId, ":batchUpdate"), {
    method: "POST",
    body: JSON.stringify({ requests: [
      { updateSheetProperties: { properties: { sheetId: sheet.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.09, green: 0.11, blue: 0.15 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
      { autoResizeDimensions: { dimensions: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 24 } } }
    ] })
  });

  return {
    spreadsheetUrl: config.spreadsheetUrl,
    tabTitle: title,
    rows: Math.max(0, values.length - 1),
    syncedAt: new Date().toISOString()
  };
}

