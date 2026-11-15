const pendingMessage = "Aguardando a confirmação do iFood. Você pode consultar o status ou seguir para outra entrega.";
const ineligibleMessage = "O iFood ainda não liberou a confirmação desse pedido. Confira o status ou avise o caixa.";

// A fresh polling cycle must have started after the uncertain attempt. A stale
// PROCESSING row may be the result of a restart after sending the POST.
const retryable = `
  (c.status IN ('PENDING','FAILED')
  OR (c.status='RECONCILING' AND COALESCE(c.last_http_status,0) IN (400,422)
    AND c.last_response->>'provider_reason' IS DISTINCT FROM 'ALREADY_VERIFIED')
  OR (
    (c.status='RECONCILING' AND c.last_attempt_at < NOW()-INTERVAL '35 seconds')
    OR (c.status='PROCESSING' AND c.processing_started_at < NOW()-INTERVAL '2 minutes')
  ) AND EXISTS (
    SELECT 1 FROM ifood_sync_state s WHERE s.singleton=1
      AND s.last_successful_poll_started_at > c.last_attempt_at + INTERVAL '5 seconds'
  ))
`;

const orderJoins = `
  FROM ifood_dispatch_links l
  JOIN ifood_orders o ON o.order_id=l.ifood_order_id
  JOIN dispatches d ON d.id=l.dispatch_id
`;
const assignedOrder = `
  WHERE l.ifood_order_id=$1 AND d.courier_id=$2
    AND d.departed_at >= NOW()-INTERVAL '48 hours'
`;

export const ifoodDeliveryConfirmationSchema = `
  ALTER TABLE ifood_delivery_confirmations ADD COLUMN IF NOT EXISTS effects_due_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS ifood_delivery_effects_due_idx
    ON ifood_delivery_confirmations(effects_due_at) WHERE effects_due_at IS NOT NULL;
  ALTER TABLE ifood_sync_state ADD COLUMN IF NOT EXISTS last_successful_poll_started_at TIMESTAMPTZ;
`;

function boolVerdict(body) {
  const { valid, success } = body ?? {};
  if (typeof valid === "boolean") {
    return typeof success === "boolean" && valid !== success ? null : valid;
  }
  return typeof success === "boolean" && valid === undefined ? success : null;
}

function providerCodeReason(body) {
  const entries = [body,body?.error,...(Array.isArray(body?.errors) ? body.errors.slice(0,5) : [])];
  const detail = entries.flatMap(entry => typeof entry === "string" ? [entry] :
    [entry?.code,entry?.errorCode,entry?.message,entry?.errorMessage])
    .filter(value => typeof value === "string").map(value => value.slice(0,300).replace(/_/g," ")).join(" ");
  if (/already (?:been )?(?:verified|validated|confirmed|concluded|delivered)|já (?:foi |está )?(?:validado|verificado|confirmado|concluído|entregue)/i.test(detail)) return "ALREADY_VERIFIED";
  if (/invalid (?:delivery |drop )?code|incorrect (?:delivery |drop )?code|(?:delivery |drop )code (?:invalid|incorrect)|code does not match|código (?:inválido|incorreto)/i.test(detail)) return "INVALID_CODE";
  return "UNSPECIFIED";
}

export function classifyIfoodDeliveryReply(status, body, reason = providerCodeReason(body)) {
  // The delivery endpoint also returns an empty successful response in production.
  if (status >= 200 && status < 300) {
    const accepted = typeof body?.valid === "boolean" ? body.valid : body?.success;
    return accepted === false ? "INVALID" : "VERIFIED";
  }
  if (status === 400 || status === 422) {
    if (reason === "ALREADY_VERIFIED") return "UNCERTAIN";
    if (reason === "INVALID_CODE" || (body?.valid === false && boolVerdict(body) === false)) return "INVALID";
    return "REJECTED";
  }
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if ([404,409,412].includes(status)) return "INELIGIBLE";
  return "UNCERTAIN";
}

const outcomes = {
  INVALID: [422, "DELIVERY_CODE_INVALID", "Código incorreto. Confira com o cliente e tente novamente."],
  REJECTED: [422, "IFOOD_VERIFY_REJECTED", "O iFood recusou a solicitação. Confira o código e tente novamente. Se continuar, avise o caixa."],
  AUTH: [503, "IFOOD_VERIFY_AUTH_FAILED", "A conexão com o iFood precisa ser restabelecida. Avise o caixa se persistir."],
  RATE_LIMIT: [503, "IFOOD_VERIFY_RATE_LIMIT", "O iFood limitou as confirmações. Aguarde antes de tentar novamente."],
  INELIGIBLE: [409, "DELIVERY_NOT_ELIGIBLE", ineligibleMessage],
  UNCERTAIN: [202, "IFOOD_VERIFY_PENDING", pendingMessage]
};

function stateOf(row, canonicalStatus) {
  const status = canonicalStatus(row.order_status);
  if (["CONCLUDED","DELIVERED"].includes(status) || row.confirmation_status === "CONCLUDED") return "CONCLUDED";
  if (status === "CANCELLED") return "CANCELLED";
  return row.confirmation_status || "PENDING";
}

export function createIfoodDeliveryConfirmation({
  pool, verifyCode, canonicalStatus, isMerchantAllowed, isConfigured, normalizeCode, assertExternalMutationAllowed,
  emitRealtime, onEffectsReady, notifyCourierHelp, logTiming = () => {}
}) {
  async function lookup(orderId, courierId) {
    const { rows } = await pool.query(`
      SELECT o.order_id,o.display_id,o.merchant_id,o.status AS order_status,o.order_type,o.delivered_by,
        l.ifood_dispatch_status,d.id AS dispatch_id,d.status AS dispatch_status,c.status AS confirmation_status,
        COALESCE(${retryable}, true) AS retry_allowed
      ${orderJoins}
      LEFT JOIN ifood_delivery_confirmations c ON c.ifood_order_id=o.order_id
      ${assignedOrder}
    `, [orderId,courierId]);
    return rows[0];
  }

  function accessError(row, res) {
    if (!row) {
      res.status(404).json({ error: "Essa entrega não está vinculada a você.", code: "DELIVERY_NOT_ASSIGNED" });
      return true;
    }
    if (String(row.order_type).toUpperCase() !== "DELIVERY" || String(row.delivered_by).toUpperCase() !== "MERCHANT") {
      res.status(409).json({ error: "Esse pedido não é uma entrega própria da loja.", code: "DELIVERY_NOT_MERCHANT" });
      return true;
    }
    if (!isMerchantAllowed(row.merchant_id)) {
      res.status(403).json({ error: "Essa loja não está autorizada para operações iFood neste ambiente.", code: "IFOOD_MERCHANT_BLOCKED" });
      return true;
    }
    return false;
  }

  function confirmed(res, row, state, message, alreadyConfirmed = true) {
    return res.json({
      ok:true, verified:true, concluded:state === "CONCLUDED", already_confirmed:alreadyConfirmed,
      state, message, order:{ order_id:row.order_id, display_id:row.display_id }
    });
  }

  function pending(res, state = "RECONCILING") {
    return res.status(202).json({ ok:true, verified:false, state, retry_allowed:false, code:"IFOOD_VERIFY_PENDING", message:pendingMessage });
  }

  async function status(req, res) {
    res.setHeader("Cache-Control", "no-store");
    const row = await lookup(req.params.orderId.trim(), req.session.user.id);
    if (accessError(row,res)) return;
    const state = stateOf(row,canonicalStatus);
    res.json({
      ok:true, state, verified:["VERIFIED","CONCLUDED"].includes(state),
      retry_allowed:row.retry_allowed && !["VERIFIED","CONCLUDED","CANCELLED"].includes(state)
    });
  }

  async function requestHelp(req, res) {
    const courierId = req.session.user.id;
    const row = await lookup(req.params.orderId.trim(),courierId);
    if (accessError(row,res)) return;
    const state = stateOf(row,canonicalStatus);
    if (["VERIFIED","CONCLUDED"].includes(state)) {
      return confirmed(res,row,state,"Esta entrega já consta como confirmada no iFood.");
    }
    if (state === "CANCELLED" || row.dispatch_status !== "ON_ROAD") {
      return res.status(409).json({error:"O pedido não está mais em uma saída ativa.",code:"DELIVERY_HELP_NOT_ACTIVE"});
    }

    await notifyCourierHelp({
      type:"IFOOD_CONFIRMATION_HELP",severity:"warning",title:"Motoboy precisa de ajuda para confirmar entrega",
      message:`Pedido #${row.display_id || row.order_id} (iFood) · confirme a situação com o motoboy #${courierId}.`,
      courierId,dispatchId:row.dispatch_id,uniqueKey:`ifood-confirmation-help:${row.dispatch_id}:${row.order_id}`
    });
    return res.json({ok:true,message:"Caixa avisado. A entrega continua pendente."});
  }

  async function verify(req, res) {
    const started = performance.now();
    const timing = {};
    const code = normalizeCode(req.body?.code);
    if (!/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ error:"Digite o código do cliente usando somente 4 a 8 números.", code:"DELIVERY_CODE_FORMAT" });
    }

    const orderId = req.params.orderId.trim();
    const courierId = req.session.user.id;
    const row = await lookup(orderId,courierId);
    if (accessError(row,res)) return;
    const state = stateOf(row,canonicalStatus);
    if (["CONCLUDED","VERIFIED"].includes(state)) {
      return confirmed(res,row,state,"Esta entrega já consta como confirmada no iFood.");
    }
    if (state === "CANCELLED") {
      return res.status(409).json({ error:"Esse pedido foi cancelado no iFood.", code:"DELIVERY_CANCELLED" });
    }
    if (!row.retry_allowed) return pending(res,state);
    if (!["API_ACCEPTED","DISPATCHED"].includes(row.ifood_dispatch_status) && canonicalStatus(row.order_status) !== "DISPATCHED") {
      const failed = row.ifood_dispatch_status === "FAILED";
      return res.status(409).json({
        error:failed ? "O despacho desse pedido está com erro no iFood. Avise o administrador." : ineligibleMessage,
        code:failed ? "IFOOD_DISPATCH_FAILED" : "IFOOD_DISPATCH_NOT_READY"
      });
    }

    assertExternalMutationAllowed("verificação de código de entrega no iFood");
    if (!isConfigured()) {
      return res.status(503).json({ error:"A integração com o iFood não está configurada.", code:"IFOOD_NOT_CONFIGURED" });
    }
    const claim = await pool.query(`
      INSERT INTO ifood_delivery_confirmations AS c
        (ifood_order_id,dispatch_id,courier_id,status,attempts,processing_started_at,last_attempt_at)
      SELECT o.order_id,d.id,d.courier_id,'PROCESSING',1,NOW(),NOW()
      ${orderJoins}
      ${assignedOrder}
        AND d.id=$3
        AND UPPER(COALESCE(o.status,'')) NOT IN ('CONCLUDED','CON','DELIVERED','CANCELLED','CAN')
        AND (l.ifood_dispatch_status IN ('API_ACCEPTED','DISPATCHED') OR UPPER(o.status) IN ('DISPATCHED','DSP'))
      ON CONFLICT(ifood_order_id) DO UPDATE
        SET status='PROCESSING',attempts=c.attempts+1,processing_started_at=NOW(),
            last_attempt_at=NOW(),last_http_status=NULL,last_error=NULL,last_response=NULL,updated_at=NOW()
        WHERE c.courier_id=EXCLUDED.courier_id AND c.dispatch_id=EXCLUDED.dispatch_id AND ${retryable}
      RETURNING attempts
    `, [orderId,courierId,row.dispatch_id]);
    timing.pre_claim = performance.now()-started;
    if (!claim.rowCount) {
      const latest = await lookup(orderId,courierId);
      if (accessError(latest,res)) return;
      const afterClaim = stateOf(latest,canonicalStatus);
      if (["CONCLUDED","VERIFIED"].includes(afterClaim)) {
        return confirmed(res,latest,afterClaim,"Esta entrega já consta como confirmada no iFood.");
      }
      if (afterClaim === "CANCELLED") return res.status(409).json({ error:"Pedido cancelado no iFood.", code:"DELIVERY_CANCELLED" });
      return pending(res,afterClaim);
    }

    let httpStatus, body, providerRequestId;
    const providerStarted = performance.now();
    try {
      const result = await verifyCode(orderId,code);
      httpStatus = result.response.status;
      body = result.body;
    } catch (err) {
      httpStatus = Number(err?.statusCode || 0);
      body = err?.ifoodBody;
      providerRequestId = err?.ifoodRequestId;
    }
    timing.ifood = performance.now()-providerStarted;
    const providerReason = [400,422].includes(httpStatus) ? providerCodeReason(body) : null;
    const outcome = classifyIfoodDeliveryReply(httpStatus,body,providerReason);
    const nextStatus = ["UNCERTAIN","INELIGIBLE"].includes(outcome) ? "RECONCILING" : outcome === "VERIFIED" ? "VERIFIED" : "FAILED";
    const bodyType = body == null ? "empty" : Array.isArray(body) ? "array" : typeof body;
    const summary = JSON.stringify({ type:bodyType, verdict:boolVerdict(body), outcome, provider_reason:providerReason, provider_request_id:providerRequestId });
    const persistStarted = performance.now();
    const saved = await pool.query(`
      UPDATE ifood_delivery_confirmations c
      SET status=CASE WHEN c.status='PROCESSING' THEN $3 ELSE c.status END,
          processing_started_at=NULL,last_http_status=$4,
          last_error=CASE WHEN c.status='PROCESSING' THEN $5 ELSE c.last_error END,last_response=$6,
          verified_at=CASE WHEN c.status='PROCESSING' AND $3='VERIFIED' THEN COALESCE(c.verified_at,NOW()) ELSE c.verified_at END,
          effects_due_at=CASE WHEN c.status='PROCESSING' AND $3='VERIFIED' THEN NOW() ELSE c.effects_due_at END,updated_at=NOW()
      FROM ifood_orders o
      WHERE c.ifood_order_id=$1 AND c.attempts=$2 AND c.status IN ('PROCESSING','VERIFIED','CONCLUDED')
        AND o.order_id=c.ifood_order_id
        AND (c.status<>'PROCESSING' OR UPPER(COALESCE(o.status,'')) NOT IN ('CONCLUDED','CON','DELIVERED','CANCELLED','CAN'))
      RETURNING c.status,c.dispatch_id,c.courier_id
    `, [orderId,claim.rows[0].attempts,nextStatus,httpStatus || null,outcomes[outcome]?.[1] || null,summary]);

    // Event processing may have won while the upstream request was still open.
    const latest = !saved.rowCount || outcome !== "VERIFIED" ? await lookup(orderId,courierId) : null;
    timing.persist = performance.now()-persistStarted;
    const total = performance.now()-started;
    res.setHeader("Server-Timing", Object.entries(timing).map(([k,v]) => `${k};dur=${v.toFixed(1)}`).join(", "));
    logTiming({ outcome, upstream_status:httpStatus, body_type:bodyType, provider_reason:providerReason, provider_request_id:providerRequestId, total_ms:Math.round(total),
      ...Object.fromEntries(Object.entries(timing).map(([k,v]) => [k+"_ms",Math.round(v)])) });

    if ((!saved.rowCount || outcome !== "VERIFIED") && accessError(latest,res)) return;
    const finalState = latest ? stateOf(latest,canonicalStatus) : saved.rows[0].status;
    if (["VERIFIED","CONCLUDED"].includes(finalState)) {
      if (saved.rows[0]?.status === "VERIFIED") {
        emitRealtime("delivery:changed", { courier_id:saved.rows[0].courier_id,order_id:orderId });
        onEffectsReady();
      }
      return confirmed(res,row,finalState,
        outcome === "VERIFIED" ? "Código aceito pelo iFood. Entrega confirmada." : "Esta entrega já consta como confirmada no iFood.",
        outcome !== "VERIFIED" || !saved.rowCount);
    }
    if (finalState === "CANCELLED") return res.status(409).json({ error:"Pedido cancelado no iFood.", code:"DELIVERY_CANCELLED" });
    if (!saved.rowCount || outcome === "UNCERTAIN") return pending(res,finalState);

    const [statusCode,errorCode,error] = outcomes[outcome];
    return res.status(statusCode).json({ error,code:errorCode });
  }

  return { status,verify,requestHelp };
}

export function isIfoodDeliveryCodeVerifiedEvent(event) {
  return event?.fullCode === "DELIVERY_DROP_CODE_VALIDATION_SUCCESS" || event?.code === "DDCS";
}

export async function recordIfoodDeliveryCodeVerifiedEvent(pool, orderId, eventAt) {
  return pool.query(`
    INSERT INTO ifood_delivery_confirmations AS c
      (ifood_order_id,dispatch_id,courier_id,status,verified_at,effects_due_at,concluded_at)
    SELECT o.order_id,d.id,d.courier_id,
      CASE WHEN UPPER(o.status) IN ('CONCLUDED','CON','DELIVERED') THEN 'CONCLUDED' ELSE 'VERIFIED' END,
      COALESCE($2::timestamptz,NOW()),NOW(),
      CASE WHEN UPPER(o.status) IN ('CONCLUDED','CON','DELIVERED') THEN NOW() END
    FROM ifood_dispatch_links l
    JOIN ifood_orders o ON o.order_id=l.ifood_order_id
    JOIN dispatches d ON d.id=l.dispatch_id
    WHERE o.order_id=$1 AND UPPER(o.order_type)='DELIVERY' AND UPPER(o.delivered_by)='MERCHANT'
      AND UPPER(COALESCE(o.status,'')) NOT IN ('CANCELLED','CAN')
    ON CONFLICT(ifood_order_id) DO UPDATE SET
      status=CASE WHEN c.status='CONCLUDED' THEN c.status ELSE 'VERIFIED' END,
      verified_at=COALESCE(c.verified_at,EXCLUDED.verified_at),
      last_error=NULL,processing_started_at=NULL,updated_at=NOW(),effects_due_at=NOW()
    WHERE c.verified_at IS NULL
    RETURNING c.dispatch_id,c.courier_id
  `, [orderId,eventAt || null]);
}

export async function claimIfoodDeliveryEffects(pool) {
  const result = await pool.query(`
    WITH due AS (
      SELECT ifood_order_id FROM ifood_delivery_confirmations
      WHERE effects_due_at<=NOW() ORDER BY effects_due_at LIMIT 8 FOR UPDATE SKIP LOCKED
    )
    UPDATE ifood_delivery_confirmations c SET effects_due_at=NOW()+INTERVAL '30 seconds'
    FROM due WHERE c.ifood_order_id=due.ifood_order_id
    RETURNING c.ifood_order_id,c.dispatch_id,c.courier_id,c.last_http_status,c.effects_due_at::text AS lease
  `);
  return result.rows;
}

export async function finishIfoodDeliveryEffects(pool, { ifood_order_id,dispatch_id,lease }) {
  return pool.query(`
    UPDATE ifood_delivery_confirmations SET effects_due_at=NULL
    WHERE ifood_order_id=$1 AND dispatch_id=$2 AND effects_due_at=$3
  `, [ifood_order_id,dispatch_id,lease]);
}
