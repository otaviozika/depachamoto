import assert from "node:assert/strict";
import {
  classifyLoadResponse,
  RESPONSE_CLASSIFICATION,
  EXPECTED_RACE_409_CODES
} from "./k6-response-classifier.js";

const race = { operation: "concurrency_race", scenario: "l1_race", conflict_context: "expected" };
const normal = { operation: "dispatch", scenario: "l1_normal", conflict_context: "normal" };

const cases = [
  [{ status: 201, body: {}, tags: normal }, "SUCCESS", true],
  [{ status: 200, body: {}, tags: race }, "SUCCESS", true],
  [{ status: 409, body: { code: "ORDER_ALREADY_ACTIVE" }, tags: race }, "EXPECTED_409", true],
  [{ status: 409, body: { code: "ANOTAAI_ORDER_ALREADY_LINKED" }, tags: race }, "EXPECTED_409", true],
  [{ status: 409, body: { code: "ORDER_ALREADY_ACTIVE" }, tags: normal }, "UNEXPECTED_409", false],
  [{ status: 409, body: { code: "RETURN_CHECKIN_REQUIRED" }, tags: race }, "UNEXPECTED_409", false],
  [{ status: 409, body: { code: "RECENT_ORDER_CONFIRMATION" }, tags: race }, "UNEXPECTED_409", false],
  [{ status: 409, body: { code: "PENDING_DELIVERIES_BLOCK_NEW_DEPARTURE" }, tags: race }, "UNEXPECTED_409", false],
  [{ status: 409, body: {}, tags: race }, "UNEXPECTED_409", false],
  [{ status: 500, body: { code: "ORDER_ALREADY_ACTIVE" }, tags: race }, "SERVER_ERROR", false],
  [{ status: 503, body: {}, tags: normal }, "SERVER_ERROR", false],
  [{ status: 401, body: {}, tags: normal }, "AUTH_FAILURE", false],
  [{ status: 403, body: {}, tags: race }, "AUTH_FAILURE", false],
  [{ status: 0, body: {}, tags: race }, "TIMEOUT", false],
  [{ status: 201, body: {}, tags: normal, transportError: "request timeout" }, "TIMEOUT", false],
  [{ status: 429, body: {}, tags: normal }, "UNEXPECTED_RESPONSE", false]
];

for (const [input, classification, ok] of cases) {
  const got = classifyLoadResponse(input);
  assert.equal(got.classification, RESPONSE_CLASSIFICATION[classification], JSON.stringify(input));
  assert.equal(got.ok, ok, JSON.stringify(input));
}

assert.deepEqual(
  [...EXPECTED_RACE_409_CODES].sort(),
  ["ANOTAAI_ORDER_ALREADY_LINKED", "ORDER_ALREADY_ACTIVE"].sort()
);

console.log(`k6/load response classifier: ${cases.length + 1}/${cases.length + 1} checks passed`);
