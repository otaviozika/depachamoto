import crypto from "crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

export function googleSheetsConfig(env = process.env) {
  const clientEmail = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
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
  if (shift === "LUNCH") return base;
  const letter = ["D", "S", "T", "Q", "Q", "S", "S"][new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
  return `${base} ${letter}`;
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
  if (source.length > 50) {
    throw Object.assign(new Error("A aba diária comporta no máximo 50 motoboys."), { status: 400, code: "PAYMENT_DAY_ROW_LIMIT" });
  }
  return {
    names: source.map(row => [row.courier_name || ""]),
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
    notes: source.map(row => [row.notes || ""])
  };
}

export function paymentSheetTitle(month, prefix = "Pagamentos") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) {
    throw Object.assign(new Error("Mês inválido para sincronização."), { status: 400, code: "PAYMENT_MONTH_INVALID" });
  }
  return `${String(prefix || "Pagamentos").trim().slice(0, 40) || "Pagamentos"} ${month}`.slice(0, 90);
}

export function paymentRowsToSheetValues(month, rows = []) {
  const header = [
    "Mês", "Data", "Motoboy", "Turno", "Entregas", "Valor por entrega", "Base",
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
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function readJson(response, fallbackMessage) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error_description || fallbackMessage;
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

export async function syncPaymentDayToGoogleSheets({ date, shiftCode, rows, spreadsheetId, env = process.env, fetchFn = fetch }) {
  const config = googleSheetsConfig(env);
  if (!config.clientEmail || !config.privateKey) {
    throw Object.assign(new Error("A conta de serviço do Google ainda não está configurada no Render."), { status: 503, code: "GOOGLE_SHEETS_NOT_CONFIGURED" });
  }
  const targetId = String(spreadsheetId || "").trim();
  if (!targetId) throw Object.assign(new Error("A planilha deste mês ainda não foi vinculada."), { status: 409, code: "PAYMENT_SHEET_NOT_LINKED" });
  const title = paymentDaySheetTitle(date, shiftCode);
  const escapedTitle = title.replace(/'/g, "''");
  const data = paymentRowsToDailySheetData(rows);
  const token = await getAccessToken(config, fetchFn);
  const metadata = await googleRequest(fetchFn, token, sheetsApiUrl(targetId, "?fields=properties.title,sheets.properties"));
  const sheet = (metadata.sheets || []).find(item => item?.properties?.title === title)?.properties;
  if (!Number.isInteger(sheet?.sheetId)) {
    throw Object.assign(new Error(`A aba ${title} não existe na planilha vinculada.`), { status: 404, code: "PAYMENT_DAY_TAB_NOT_FOUND" });
  }
  const clearRanges = [`'${escapedTitle}'!A4:A53`, `'${escapedTitle}'!E4:J53`, `'${escapedTitle}'!M4:M53`];
  await googleRequest(fetchFn, token, sheetsApiUrl(targetId, "/values:batchClear"), {
    method: "POST",
    body: JSON.stringify({ ranges: clearRanges })
  });
  if (data.names.length) {
    const endRow = data.names.length + 3;
    await googleRequest(fetchFn, token, sheetsApiUrl(targetId, "/values:batchUpdate"), {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: [
          { range: `'${escapedTitle}'!A4:A${endRow}`, majorDimension: "ROWS", values: data.names },
          { range: `'${escapedTitle}'!E4:J${endRow}`, majorDimension: "ROWS", values: data.payments },
          { range: `'${escapedTitle}'!M4:M${endRow}`, majorDimension: "ROWS", values: data.notes }
        ]
      })
    });
    const verifyRange = `'${escapedTitle}'!A4:A${endRow}`;
    const verified = await googleRequest(fetchFn, token, sheetsApiUrl(targetId, `/values/${encodeURIComponent(verifyRange)}?majorDimension=ROWS`));
    const verifiedNames = (verified.values || []).map(row => String(row?.[0] || ""));
    const expectedNames = data.names.map(row => String(row[0] || ""));
    if (verifiedNames.length !== expectedNames.length || verifiedNames.some((name, index) => name !== expectedNames[index])) {
      throw Object.assign(new Error("O Google Planilhas não confirmou todos os motoboys enviados."), { status: 502, code: "PAYMENT_DAY_VERIFY_FAILED" });
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

  const range = `'${title.replace(/'/g, "''")}'!A:U`;
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
      { autoResizeDimensions: { dimensions: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 21 } } }
    ] })
  });

  return {
    spreadsheetUrl: config.spreadsheetUrl,
    tabTitle: title,
    rows: Math.max(0, values.length - 1),
    syncedAt: new Date().toISOString()
  };
}
