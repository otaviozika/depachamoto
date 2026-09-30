export const RESPONSE_CLASSIFICATION = Object.freeze({
  SUCCESS: "SUCCESS",
  EXPECTED_409: "EXPECTED_409",
  UNEXPECTED_409: "UNEXPECTED_409",
  SERVER_ERROR: "SERVER_ERROR",
  TIMEOUT: "TIMEOUT",
  AUTH_FAILURE: "AUTH_FAILURE",
  UNEXPECTED_RESPONSE: "UNEXPECTED_RESPONSE"
});

// These are the only business conflicts accepted by the deliberate same-order race.
// Both mean another concurrent departure already acquired the same AnotaAi order.
export const EXPECTED_RACE_409_CODES = Object.freeze([
  "ORDER_ALREADY_ACTIVE",
  "ANOTAAI_ORDER_ALREADY_LINKED"
]);

const expectedRaceCodes = new Set(EXPECTED_RACE_409_CODES);

function normalizedTags(tags = {}) {
  return {
    operation: String(tags.operation || "unknown"),
    scenario: String(tags.scenario || "unknown"),
    conflict_context: String(tags.conflict_context || "normal")
  };
}

function bodyCode(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = String(body.code || "").trim();
  return code || null;
}

export function classifyLoadResponse({ status = 0, body = null, tags = {}, transportError = null } = {}) {
  const normalizedStatus = Number(status || 0);
  const t = normalizedTags(tags);
  const code = bodyCode(body);
  const raceContext =
    t.operation === "concurrency_race" &&
    t.conflict_context === "expected";

  // k6/fetch transport failures have no valid HTTP response. Never let them
  // fall through to the HTTP conflict classifier.
  if (transportError || normalizedStatus === 0) {
    return {
      ok: false,
      classification: RESPONSE_CLASSIFICATION.TIMEOUT,
      status: normalizedStatus,
      code,
      expected: false,
      tags: t
    };
  }

  // Authentication is classified before generic 4xx.
  if (normalizedStatus === 401 || normalizedStatus === 403) {
    return {
      ok: false,
      classification: RESPONSE_CLASSIFICATION.AUTH_FAILURE,
      status: normalizedStatus,
      code,
      expected: false,
      tags: t
    };
  }

  if (normalizedStatus >= 500 && normalizedStatus <= 599) {
    return {
      ok: false,
      classification: RESPONSE_CLASSIFICATION.SERVER_ERROR,
      status: normalizedStatus,
      code,
      expected: false,
      tags: t
    };
  }

  if (normalizedStatus === 409) {
    const expected = raceContext && expectedRaceCodes.has(code);
    return {
      ok: expected,
      classification: expected
        ? RESPONSE_CLASSIFICATION.EXPECTED_409
        : RESPONSE_CLASSIFICATION.UNEXPECTED_409,
      status: normalizedStatus,
      code,
      expected,
      tags: t
    };
  }

  if (normalizedStatus >= 200 && normalizedStatus <= 299) {
    return {
      ok: true,
      classification: RESPONSE_CLASSIFICATION.SUCCESS,
      status: normalizedStatus,
      code,
      expected: true,
      tags: t
    };
  }

  return {
    ok: false,
    classification: RESPONSE_CLASSIFICATION.UNEXPECTED_RESPONSE,
    status: normalizedStatus,
    code,
    expected: false,
    tags: t
  };
}
