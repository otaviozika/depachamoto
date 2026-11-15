import assert from "node:assert/strict";
import test from "node:test";
import { classifyIfoodDeliveryReply, isIfoodDeliveryCodeVerifiedEvent } from "../lib/ifood-delivery-confirmation.js";

test("provider confirmation requires explicit, noncontradictory evidence", () => {
  for (const [http, body, expected] of [
    [200, {valid:true}, "VERIFIED"],
    [200, {success:true}, "VERIFIED"],
    [200, {valid:false}, "INVALID"],
    [200, {valid:true,success:false}, "UNCERTAIN"],
    [200, {valid:"true",success:true}, "UNCERTAIN"],
    [200, {status:"CONCLUDED"}, "UNCERTAIN"],
    [200, null, "UNCERTAIN"],
    [200, "OK", "UNCERTAIN"],
    [202, {}, "UNCERTAIN"],
    [202, {success:false}, "UNCERTAIN"],
    [400, {error:"Invalid delivery code"}, "INVALID"],
    [400, {success:false}, "UNCERTAIN"],
    [401, {valid:true}, "AUTH"],
    [409, {valid:true}, "INELIGIBLE"],
    [412, {}, "INELIGIBLE"],
    [422, {valid:true}, "UNCERTAIN"],
    [422, {message:"Code already verified"}, "UNCERTAIN"],
    [422, {error:{message:"Código incorreto"}}, "INVALID"],
    [429, null, "RATE_LIMIT"],
    [500, {valid:true}, "UNCERTAIN"],
    [0, null, "UNCERTAIN"]
  ]) {
    assert.equal(classifyIfoodDeliveryReply(http,body),expected,JSON.stringify([http,body]));
  }
});

test("only the iFood code validation success event provides positive code evidence", () => {
  assert.equal(isIfoodDeliveryCodeVerifiedEvent({code:"DDCS"}),true);
  assert.equal(isIfoodDeliveryCodeVerifiedEvent({fullCode:"DELIVERY_DROP_CODE_VALIDATION_SUCCESS"}),true);
  assert.equal(isIfoodDeliveryCodeVerifiedEvent({fullCode:"DELIVERY_DROP_CODE_REQUESTED"}),false);
  assert.equal(isIfoodDeliveryCodeVerifiedEvent({fullCode:"CONCLUDED"}),false);
});
