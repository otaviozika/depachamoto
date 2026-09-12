import fs from "node:fs";

const serverPath = new URL("../server.js", import.meta.url);
let source = fs.readFileSync(serverPath, "utf8");

function fail(message) {
  throw new Error(`[step3] ${message}`);
}

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) fail(`marker not found: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) fail(`marker repeated: ${label}`);
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

function routeBlock(marker) {
  const start = source.indexOf(marker);
  if (start < 0) fail(`route not found: ${marker}`);
  const next = source.indexOf("\napp.", start + marker.length);
  if (next < 0) fail(`next route not found after: ${marker}`);
  return { start, end: next + 1, text: source.slice(start, next + 1) };
}

function replaceRoute(marker, transform) {
  const { start, end, text } = routeBlock(marker);
  const changed = transform(text);
  if (!changed || changed === text) fail(`route unchanged: ${marker}`);
  source = source.slice(0, start) + changed + source.slice(end);
}

function replaceInRoute(marker, search, replacement, label) {
  replaceRoute(marker, block => {
    const count = block.split(search).length - 1;
    if (count !== 1) fail(`${label}: expected 1 match, got ${count}`);
    return block.replace(search, replacement);
  });
}

// Step 2 central shift module becomes the only clock/schedule authority used here.
replaceOnce(
  'import webpush from "web-push";\n',
  'import webpush from "web-push";\nimport { getCurrentOperationalShift, getSPDateTime, normalizeShiftCode, shiftLabel } from "./lib/operational-shift.js";\n',
  "operational shift import"
);

// Keep fresh databases self-contained while preserving the old CREATE TABLE for backwards static tests.
replaceOnce(
  "  attendance_date DATE NOT NULL,\n  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
  "  attendance_date DATE NOT NULL,\n  shift_code TEXT,\n  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
  "attendance shift column in CREATE TABLE"
);

replaceOnce(
  "ON CONFLICT(courier_id,attendance_date) DO NOTHING;\n\nINSERT INTO app_settings(setting_key,setting_value)",
  "ON CONFLICT DO NOTHING;\n\nINSERT INTO app_settings(setting_key,setting_value)",
  "legacy attendance backfill conflict target"
);

const migrationMarker = "ON CONFLICT(setting_key) DO NOTHING;\n\nCREATE TABLE IF NOT EXISTS active_order_locks (";
const shiftMigration = `ON CONFLICT(setting_key) DO NOTHING;

-- v3.7: presença por turno. Histórico anterior continua nullable; novos fluxos
-- usam courier_id + attendance_date + shift_code.
ALTER TABLE courier_attendance
ADD COLUMN IF NOT EXISTS shift_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='courier_attendance'::regclass
      AND conname='courier_attendance_shift_code_check'
  ) THEN
    ALTER TABLE courier_attendance
      ADD CONSTRAINT courier_attendance_shift_code_check
      CHECK (shift_code IS NULL OR shift_code IN ('LUNCH','DINNER'));
  END IF;
END $$;

-- Classifica somente registros a partir do cutover quando o horário é inequívoco.
UPDATE courier_attendance
SET shift_code = CASE
  WHEN EXTRACT(ISODOW FROM attendance_date) BETWEEN 1 AND 4
       AND (checked_in_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN TIME '11:30' AND TIME '14:30'
    THEN 'LUNCH'
  WHEN EXTRACT(ISODOW FROM attendance_date) BETWEEN 1 AND 4
       AND (checked_in_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN TIME '18:00' AND TIME '23:32'
    THEN 'DINNER'
  WHEN EXTRACT(ISODOW FROM attendance_date) IN (5,6)
       AND (checked_in_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN TIME '11:00' AND TIME '15:00'
    THEN 'LUNCH'
  WHEN EXTRACT(ISODOW FROM attendance_date) IN (5,6)
       AND (checked_in_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN TIME '18:00' AND TIME '23:30'
    THEN 'DINNER'
  WHEN EXTRACT(ISODOW FROM attendance_date)=7
       AND (checked_in_at AT TIME ZONE 'America/Sao_Paulo')::time BETWEEN TIME '18:00' AND TIME '23:30'
    THEN 'DINNER'
  ELSE NULL
END
WHERE shift_code IS NULL
  AND attendance_date >= DATE '2026-09-12';

ALTER TABLE courier_attendance
DROP CONSTRAINT IF EXISTS courier_attendance_courier_id_attendance_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS courier_attendance_date_shift_unique_idx
ON courier_attendance(courier_id,attendance_date,shift_code)
WHERE shift_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS courier_attendance_shift_lookup_idx
ON courier_attendance(attendance_date,shift_code,courier_id);

INSERT INTO app_settings(setting_key,setting_value,updated_at)
VALUES('work_shift_cutover_date','2026-09-12',NOW())
ON CONFLICT(setting_key) DO UPDATE
SET setting_value=EXCLUDED.setting_value,updated_at=NOW();

CREATE TABLE IF NOT EXISTS active_order_locks (`;
replaceOnce(migrationMarker, shiftMigration, "attendance shift migration");

// Replace the old day-only QR/attendance helpers as one atomic source transformation.
const helperStart = source.indexOf("function createAttendanceQrToken(attendanceDate) {");
const helperEnd = source.indexOf("function validDate(v) {", helperStart);
if (helperStart < 0 || helperEnd < 0) fail("attendance helper range not found");

const newHelpers = `const WORK_SHIFT_CUTOVER_DATE = "2026-09-12";

function createAttendanceQrToken(attendanceDate, shiftCode) {
  const normalizedShift = normalizeShiftCode(shiftCode);
  if (!normalizedShift) {
    const err = new Error("Turno inválido para gerar o QR de presença.");
    err.status = 400;
    err.code = "ATTENDANCE_SHIFT_INVALID";
    throw err;
  }

  const now = Date.now();
  const payload = {
    v: 2,
    p: "courier_attendance",
    d: attendanceDate,
    s: normalizedShift,
    iat: now,
    exp: now + ATTENDANCE_QR_TTL_MS,
    n: crypto.randomUUID()
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", attendanceQrSecret())
    .update(body)
    .digest("base64url");
  return { token: \`${'${body}.${signature}'}\`, payload };
}

async function verifyAttendanceQrToken(token) {
  const value = String(token || "").trim();
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  const expected = crypto
    .createHmac("sha256", attendanceQrSecret())
    .update(body)
    .digest("base64url");

  const givenBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (givenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(givenBuf, expectedBuf)) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  const payloadShift = normalizeShiftCode(payload?.s);
  if (payload?.v !== 2 || payload?.p !== "courier_attendance" || !validDate(payload?.d) || !payloadShift) {
    const err = new Error("QR de presença inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_QR_INVALID";
    throw err;
  }

  if (!Number.isFinite(Number(payload.exp)) || Date.now() > Number(payload.exp)) {
    const err = new Error("Este QR de presença expirou. Escaneie o QR atual exibido na loja.");
    err.status = 410;
    err.code = "ATTENDANCE_QR_EXPIRED";
    throw err;
  }

  const today = await getSPDate();
  if (payload.d !== today) {
    const err = new Error("Este QR pertence a outro dia de operação.");
    err.status = 409;
    err.code = "ATTENDANCE_QR_WRONG_DAY";
    throw err;
  }

  const currentShift = getCurrentOperationalShift();
  if (!currentShift || currentShift.operational_date !== payload.d || currentShift.shift_code !== payloadShift) {
    const err = new Error("Este QR pertence a outro turno. Escaneie o QR do turno atual.");
    err.status = 409;
    err.code = "ATTENDANCE_QR_WRONG_SHIFT";
    throw err;
  }

  payload.s = payloadShift;
  return payload;
}

function resolveAttendanceViewShift(attendanceDate, requestedShift = null, now = new Date()) {
  const requestedText = String(requestedShift || "").trim();
  const requested = normalizeShiftCode(requestedText);
  if (requestedText && !requested) {
    const err = new Error("Turno inválido.");
    err.status = 400;
    err.code = "ATTENDANCE_SHIFT_INVALID";
    throw err;
  }

  if (!requested && attendanceDate < WORK_SHIFT_CUTOVER_DATE) {
    return { operational_date: attendanceDate, shift_code: null, shift_label: "Legado", legacy: true };
  }

  if (requested) {
    return {
      operational_date: attendanceDate,
      shift_code: requested,
      shift_label: shiftLabel(requested),
      legacy: false
    };
  }

  const sp = getSPDateTime(now);
  if (attendanceDate === sp.date) {
    const active = getCurrentOperationalShift(now);
    if (active) return { ...active, legacy: false };

    const [hour, minute] = sp.time.split(":").map(Number);
    const minutes = hour * 60 + minute;
    const fallbackCode = sp.weekday === 7
      ? "DINNER"
      : minutes < 18 * 60 ? "LUNCH" : "DINNER";

    return {
      operational_date: attendanceDate,
      shift_code: fallbackCode,
      shift_label: shiftLabel(fallbackCode),
      legacy: false
    };
  }

  return {
    operational_date: attendanceDate,
    shift_code: "DINNER",
    shift_label: shiftLabel("DINNER"),
    legacy: false
  };
}

async function getCourierAttendance(courierId, attendanceDate = null, shiftCode = null) {
  const date = attendanceDate || await getSPDate();
  const view = resolveAttendanceViewShift(date, shiftCode);

  if (!view.shift_code) {
    return (await pool.query(\`
      SELECT a.id,a.courier_id,a.attendance_date,a.shift_code,a.checked_in_at,a.checkin_method,
             a.checked_in_by,a.admin_reason,a.checked_out_at,a.checked_out_by,a.checkout_reason
      FROM courier_attendance a
      WHERE a.courier_id=$1 AND a.attendance_date=$2::date AND a.shift_code IS NULL
      ORDER BY a.checked_in_at DESC,a.id DESC
      LIMIT 1
    \`, [courierId, date])).rows[0] || null;
  }

  return (await pool.query(\`
    SELECT a.id,a.courier_id,a.attendance_date,a.shift_code,a.checked_in_at,a.checkin_method,
           a.checked_in_by,a.admin_reason,a.checked_out_at,a.checked_out_by,a.checkout_reason
    FROM courier_attendance a
    WHERE a.courier_id=$1 AND a.attendance_date=$2::date AND a.shift_code=$3
    LIMIT 1
  \`, [courierId, date, view.shift_code])).rows[0] || null;
}

async function requireCourierAttendance(courierId, at = new Date()) {
  const shift = getCurrentOperationalShift(at);
  if (!shift) {
    const err = new Error("A hamburgueria está entre turnos. Novas saídas ficam bloqueadas até o próximo turno.");
    err.status = 409;
    err.code = "OUTSIDE_OPERATIONAL_SHIFT";
    throw err;
  }

  const attendance = await getCourierAttendance(courierId, shift.operational_date, shift.shift_code);
  if (!attendance) {
    const err = new Error(\`Confirme sua presença no turno de ${'${shift.shift_label}'} antes de registrar uma saída.\`);
    err.status = 403;
    err.code = "ATTENDANCE_REQUIRED";
    err.attendance_date = shift.operational_date;
    err.shift_code = shift.shift_code;
    throw err;
  }
  if (attendance.checked_out_at) {
    const err = new Error(\`Seu expediente de ${'${shift.shift_label}'} foi encerrado pelo Admin. Novas saídas estão bloqueadas neste turno.\`);
    err.status = 403;
    err.code = "SHIFT_ENDED";
    err.attendance_date = shift.operational_date;
    err.shift_code = shift.shift_code;
    err.checked_out_at = attendance.checked_out_at;
    throw err;
  }
  return attendance;
}

`;
source = source.slice(0, helperStart) + newHelpers + source.slice(helperEnd);

// QR generation: only an active operational shift can mint a valid token.
replaceRoute('app.get("/api/admin/attendance/qr"', () => `app.get("/api/admin/attendance/qr", auth, adminOnly, asyncRoute(async (req, res) => {
  const shift = getCurrentOperationalShift();
  if (!shift) {
    return res.status(409).json({
      error: "Nenhum turno de operação está aberto neste momento.",
      code: "OUTSIDE_OPERATIONAL_SHIFT",
      server_now: new Date().toISOString()
    });
  }

  const { token, payload } = createAttendanceQrToken(shift.operational_date, shift.shift_code);
  const baseUrl = \`${'${req.protocol}://${req.get("host")}'}\`;
  const checkinUrl = new URL("/", baseUrl);
  checkinUrl.searchParams.set("attendance_token", token);

  res.json({
    date: shift.operational_date,
    shift_code: shift.shift_code,
    shift_label: shift.shift_label,
    starts_at: shift.starts_at,
    ends_at: shift.ends_at,
    url: checkinUrl.toString(),
    expires_at: new Date(payload.exp).toISOString(),
    refresh_after_ms: 30000,
    server_now: new Date().toISOString()
  });
}));
`);

// Admin attendance list is scoped to one shift, with legacy-null support before cutover.
replaceRoute('app.get("/api/admin/attendance",', block => {
  block = block.replace(
    '  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();\n\n  const rows = (await pool.query(`',
    '  const date = validDate(req.query.date) ? String(req.query.date) : await getSPDate();\n  let attendanceView;\n  try {\n    attendanceView = resolveAttendanceViewShift(date, req.query.shift_code || req.query.shift || null);\n  } catch (err) {\n    return res.status(err.status || 400).json({ error: err.message, code: err.code || "ATTENDANCE_SHIFT_INVALID" });\n  }\n\n  const rows = (await pool.query(`'
  );
  block = block.replace(
    '    LEFT JOIN courier_attendance a\n      ON a.courier_id=u.id AND a.attendance_date=$1::date',
    '    LEFT JOIN courier_attendance a\n      ON a.courier_id=u.id AND a.attendance_date=$1::date\n     AND (($2::text IS NULL AND a.shift_code IS NULL) OR a.shift_code=$2::text)'
  );
  block = block.replace('  `, [date])).rows.map(r => ({', '  `, [date, attendanceView.shift_code])).rows.map(r => ({');
  block = block.replace(
    '  res.json({\n    date,\n    summary:',
    '  res.json({\n    date,\n    shift_code: attendanceView.shift_code,\n    shift_label: attendanceView.shift_label,\n    legacy: attendanceView.legacy,\n    summary:'
  );
  return block;
});

// Admin manual check-in always belongs to the active shift.
replaceRoute('app.post("/api/admin/attendance/checkin"', () => `app.post("/api/admin/attendance/checkin", auth, adminOnly, asyncRoute(async (req, res) => {
  const courierId = Number(req.body.courier_id);
  const reason = String(req.body.reason || "").trim().slice(0, 250);
  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Selecione um motoboy." });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: "Informe o motivo da presença manual." });
  }

  const shift = getCurrentOperationalShift();
  if (!shift) {
    return res.status(409).json({
      error: "Nenhum turno está aberto para registrar presença agora.",
      code: "OUTSIDE_OPERATIONAL_SHIFT"
    });
  }

  const courier = (await pool.query(\`
    SELECT id,name,active,approval_status
    FROM users
    WHERE id=$1 AND role='courier'
    LIMIT 1
  \`, [courierId])).rows[0];

  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });
  if (!courier.active || courier.approval_status !== "APPROVED") {
    return res.status(409).json({ error: "O motoboy precisa estar ativo e aprovado." });
  }

  const inserted = await pool.query(\`
    INSERT INTO courier_attendance(
      courier_id,attendance_date,shift_code,checked_in_at,checkin_method,checked_in_by,admin_reason
    )
    VALUES($1,$2::date,$3,NOW(),'ADMIN_MANUAL',$4,$5)
    ON CONFLICT DO NOTHING
    RETURNING *
  \`, [courierId, shift.operational_date, shift.shift_code, req.session.user.id, reason]);

  const attendance = inserted.rows[0] || await getCourierAttendance(courierId, shift.operational_date, shift.shift_code);
  if (!inserted.rowCount && attendance?.checked_out_at) {
    return res.status(409).json({
      error: \`${'${courier.name}'} teve o expediente de ${'${shift.shift_label}'} encerrado. A presença manual não reabre turno encerrado.\`,
      code: "SHIFT_ENDED",
      shift_code: shift.shift_code,
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }

  if (inserted.rowCount) {
    await auditBestEffort(req.session.user.id, "ATTENDANCE_MANUAL_CHECKIN", "courier_attendance", attendance.id, {
      courier_id: courierId,
      courier_name: courier.name,
      attendance_date: shift.operational_date,
      shift_code: shift.shift_code,
      reason
    });
    io.emit("attendance:changed", {
      courier_id: courierId,
      attendance_date: shift.operational_date,
      shift_code: shift.shift_code
    });
  }

  res.status(inserted.rowCount ? 201 : 200).json({
    attendance,
    shift_code: shift.shift_code,
    shift_label: shift.shift_label,
    duplicate: !inserted.rowCount,
    message: inserted.rowCount
      ? \`Presença de ${'${courier.name}'} confirmada no turno de ${'${shift.shift_label}'}.\`
      : \`${'${courier.name}'} já possui presença registrada no turno de ${'${shift.shift_label}'}.\`,
    server_now: new Date().toISOString()
  });
}));
`);

// Checkout can explicitly target a shift; without a selector it uses the active/most-recent shift of today.
replaceRoute('app.post("/api/admin/attendance/:courierId/checkout"', () => `app.post("/api/admin/attendance/:courierId/checkout", auth, adminOnly, asyncRoute(async (req, res) => {
  const courierId = Number(req.params.courierId);
  const reason = String(req.body.reason || "").trim().slice(0, 250);
  if (!Number.isInteger(courierId) || courierId < 1) {
    return res.status(400).json({ error: "Motoboy inválido." });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: "Informe o motivo do encerramento do expediente." });
  }

  const courier = (await pool.query(\`
    SELECT id,name,active,approval_status
    FROM users
    WHERE id=$1 AND role='courier'
    LIMIT 1
  \`, [courierId])).rows[0];
  if (!courier) return res.status(404).json({ error: "Motoboy não encontrado." });

  const date = await getSPDate();
  let attendanceView;
  try {
    attendanceView = resolveAttendanceViewShift(date, req.body.shift_code || req.body.shift || null);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code || "ATTENDANCE_SHIFT_INVALID" });
  }

  const attendance = await getCourierAttendance(courierId, date, attendanceView.shift_code);
  if (!attendance) {
    return res.status(409).json({
      error: \`${'${courier.name}'} não possui presença registrada no turno de ${'${attendanceView.shift_label}'}.\`,
      code: "ATTENDANCE_NOT_FOUND",
      shift_code: attendanceView.shift_code
    });
  }
  if (attendance.checked_out_at) {
    return res.status(409).json({
      error: \`O expediente de ${'${attendanceView.shift_label}'} de ${'${courier.name}'} já foi encerrado.\`,
      code: "SHIFT_ALREADY_ENDED",
      shift_code: attendanceView.shift_code,
      checked_out_at: attendance.checked_out_at
    });
  }

  const activeDispatch = (await pool.query(\`
    SELECT id,dispatch_code,operational_stage,departed_at
    FROM dispatches
    WHERE courier_id=$1 AND status='ON_ROAD'
    ORDER BY departed_at DESC,id DESC
    LIMIT 1
  \`, [courierId])).rows[0];

  if (activeDispatch) {
    return res.status(409).json({
      error: \`${'${courier.name}'} ainda está ${'${activeDispatch.operational_stage === "RETURNING" ? "retornando para a loja" : "em rota"}'}. Finalize a saída antes de encerrar o expediente.\`,
      code: "SHIFT_HAS_ACTIVE_DISPATCH",
      dispatch_id: activeDispatch.id,
      operational_stage: activeDispatch.operational_stage
    });
  }

  const updated = (await pool.query(\`
    UPDATE courier_attendance
    SET checked_out_at=NOW(),checked_out_by=$1,checkout_reason=$2
    WHERE id=$3 AND checked_out_at IS NULL
    RETURNING *
  \`, [req.session.user.id, reason, attendance.id])).rows[0];

  if (!updated) {
    return res.status(409).json({ error: "O expediente já foi encerrado.", code: "SHIFT_ALREADY_ENDED" });
  }

  await auditBestEffort(req.session.user.id, "ATTENDANCE_ADMIN_CHECKOUT", "courier_attendance", updated.id, {
    courier_id: courierId,
    courier_name: courier.name,
    attendance_date: date,
    shift_code: attendanceView.shift_code,
    checked_in_at: attendance.checked_in_at,
    checked_out_at: updated.checked_out_at,
    reason
  });

  io.emit("attendance:changed", {
    courier_id: courierId,
    attendance_date: date,
    shift_code: attendanceView.shift_code,
    shift_ended: true
  });
  io.emit("dashboard:changed");

  res.json({
    attendance: updated,
    shift_code: attendanceView.shift_code,
    shift_label: attendanceView.shift_label,
    message: \`Expediente de ${'${attendanceView.shift_label}'} de ${'${courier.name}'} encerrado pelo Admin.\`,
    server_now: new Date().toISOString()
  });
}));
`);

// Courier QR check-in is keyed by courier + date + shift.
replaceRoute('app.post("/api/courier/attendance/checkin"', () => `app.post("/api/courier/attendance/checkin", auth, courierOnly, asyncRoute(async (req, res) => {
  await touchPresence(req.session.user.id, "COURIER_WEB");

  const user = await currentUser(req.session.user.id);
  if (!user || !user.active || user.approval_status !== "APPROVED") {
    return res.status(403).json({ error: "Seu acesso não está ativo e aprovado." });
  }

  let payload;
  try {
    payload = await verifyAttendanceQrToken(req.body.token);
  } catch (err) {
    return res.status(err.status || 400).json({
      error: err.message || "QR de presença inválido.",
      code: err.code || "ATTENDANCE_QR_INVALID",
      server_now: new Date().toISOString()
    });
  }

  const inserted = await pool.query(\`
    INSERT INTO courier_attendance(
      courier_id,attendance_date,shift_code,checked_in_at,checkin_method
    )
    VALUES($1,$2::date,$3,NOW(),'QR')
    ON CONFLICT DO NOTHING
    RETURNING *
  \`, [req.session.user.id, payload.d, payload.s]);

  const attendance = inserted.rows[0] || await getCourierAttendance(req.session.user.id, payload.d, payload.s);
  if (!inserted.rowCount && attendance?.checked_out_at) {
    return res.status(409).json({
      error: \`Seu expediente de ${'${shiftLabel(payload.s)}'} foi encerrado pelo Admin. O QR não pode reativar seu turno.\`,
      code: "SHIFT_ENDED",
      shift_code: payload.s,
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }

  if (inserted.rowCount) {
    await auditBestEffort(req.session.user.id, "ATTENDANCE_QR_CHECKIN", "courier_attendance", attendance.id, {
      attendance_date: payload.d,
      shift_code: payload.s,
      checkin_method: "QR"
    });
    io.emit("attendance:changed", {
      courier_id: req.session.user.id,
      attendance_date: payload.d,
      shift_code: payload.s
    });
  }

  res.status(inserted.rowCount ? 201 : 200).json({
    attendance,
    shift_code: payload.s,
    shift_label: shiftLabel(payload.s),
    duplicate: !inserted.rowCount,
    message: inserted.rowCount
      ? \`Presença confirmada no turno de ${'${shiftLabel(payload.s)}'}.\`
      : \`Sua presença de ${'${shiftLabel(payload.s)}'} já estava confirmada.\`,
    server_now: new Date().toISOString()
  });
}));
`);

// Courier dashboard now exposes the selected/current shift while preserving the response shape.
replaceInRoute(
  'app.get("/api/courier/dashboard"',
  '  const attendanceDate = await getSPDate();\n  const attendanceRow = await getCourierAttendance(req.session.user.id, attendanceDate);',
  '  const attendanceDate = await getSPDate();\n  const attendanceView = resolveAttendanceViewShift(attendanceDate);\n  const attendanceRow = await getCourierAttendance(req.session.user.id, attendanceDate, attendanceView.shift_code);',
  "courier dashboard attendance lookup"
);
replaceInRoute(
  'app.get("/api/courier/dashboard"',
  '    attendance: {\n      date: attendanceDate,\n      present:',
  '    attendance: {\n      date: attendanceDate,\n      shift_code: attendanceView.shift_code,\n      shift_label: attendanceView.shift_label,\n      present:',
  "courier dashboard shift metadata"
);

// Route additions require presence in the active shift.
replaceOnce(
  "  if (!completedAssignment) {\n    const attendance = await getCourierAttendance(courierId, await getSPDate());\n    if (!attendance || attendance.checked_out_at) return res.status(403).json({error:'É necessário estar com presença confirmada e expediente aberto.'});\n  }",
  "  if (!completedAssignment) {\n    const routeShift = getCurrentOperationalShift();\n    if (!routeShift) return res.status(409).json({error:'A hamburgueria está entre turnos. Aguarde o próximo turno para adicionar uma entrega.',code:'OUTSIDE_OPERATIONAL_SHIFT'});\n    const attendance = await getCourierAttendance(courierId, routeShift.operational_date, routeShift.shift_code);\n    if (!attendance || attendance.checked_out_at) return res.status(403).json({error:'É necessário estar com presença confirmada e expediente aberto neste turno.',code:'ATTENDANCE_REQUIRED',shift_code:routeShift.shift_code});\n  }",
  "route order attendance"
);

// Courier departure must use the active shift, never a day-only presence row.
replaceRoute('app.post("/api/courier/depart"', block => {
  const old = `  const attendanceDate = await getSPDate();
  const attendance = await getCourierAttendance(req.session.user.id, attendanceDate);
  if (!attendance) {
    return res.status(403).json({
      error: "Confirme sua presença pelo QR da loja antes de registrar uma saída.",
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate,
      server_now: new Date().toISOString()
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: "Seu expediente foi encerrado pelo Admin. Você não pode registrar novas saídas hoje.",
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }`;
  const replacement = `  const departureShift = getCurrentOperationalShift();
  if (!departureShift) {
    return res.status(409).json({
      error: "A hamburgueria está entre turnos. Aguarde o próximo turno para registrar uma saída.",
      code: "OUTSIDE_OPERATIONAL_SHIFT",
      server_now: new Date().toISOString()
    });
  }

  const attendanceDate = departureShift.operational_date;
  const attendance = await getCourierAttendance(req.session.user.id, attendanceDate, departureShift.shift_code);
  if (!attendance) {
    return res.status(403).json({
      error: \`Confirme sua presença no turno de ${'${departureShift.shift_label}'} antes de registrar uma saída.\`,
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate,
      shift_code: departureShift.shift_code,
      server_now: new Date().toISOString()
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: \`Seu expediente de ${'${departureShift.shift_label}'} foi encerrado pelo Admin. Você não pode registrar novas saídas neste turno.\`,
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      shift_code: departureShift.shift_code,
      checked_out_at: attendance.checked_out_at,
      server_now: new Date().toISOString()
    });
  }`;
  if (!block.includes(old)) fail("courier departure attendance block not found");
  return block.replace(old, replacement);
});

// Admin manual departure gets the same current-shift attendance gate.
replaceRoute('app.post("/api/admin/dispatches/manual"', block => {
  const old = `  const attendanceDate = await getSPDate();
  const attendance = await getCourierAttendance(courierId, attendanceDate);
  if (!attendance) {
    return res.status(409).json({
      error: "Este motoboy ainda não confirmou presença hoje. Confirme pelo QR ou registre a presença manualmente antes da saída.",
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: "O expediente deste motoboy já foi encerrado pelo Admin. Nova saída bloqueada.",
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      checked_out_at: attendance.checked_out_at
    });
  }`;
  const replacement = `  const departureShift = getCurrentOperationalShift();
  if (!departureShift) {
    return res.status(409).json({
      error: "A hamburgueria está entre turnos. Aguarde o próximo turno para registrar uma saída manual.",
      code: "OUTSIDE_OPERATIONAL_SHIFT"
    });
  }
  const attendanceDate = departureShift.operational_date;
  const attendance = await getCourierAttendance(courierId, attendanceDate, departureShift.shift_code);
  if (!attendance) {
    return res.status(409).json({
      error: \`Este motoboy ainda não confirmou presença no turno de ${'${departureShift.shift_label}'}.\`,
      code: "ATTENDANCE_REQUIRED",
      attendance_date: attendanceDate,
      shift_code: departureShift.shift_code
    });
  }
  if (attendance.checked_out_at) {
    return res.status(403).json({
      error: \`O expediente de ${'${departureShift.shift_label}'} deste motoboy já foi encerrado pelo Admin. Nova saída bloqueada neste turno.\`,
      code: "SHIFT_ENDED",
      attendance_date: attendanceDate,
      shift_code: departureShift.shift_code,
      checked_out_at: attendance.checked_out_at
    });
  }`;
  if (!block.includes(old)) fail("admin manual departure attendance block not found");
  return block.replace(old, replacement);
});

fs.writeFileSync(serverPath, source);
console.log("Step 3 source transform applied.");
