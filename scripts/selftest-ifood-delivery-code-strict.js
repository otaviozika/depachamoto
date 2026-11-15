import assert from "node:assert/strict";
import test from "node:test";
import { classifyIfoodDeliveryReply, isIfoodDeliveryCodeVerifiedEvent } from "../lib/ifood-delivery-confirmation.js";

test("legacy iFood success responses confirm unless the provider explicitly rejects the code", () => {
  for (const [http, body, expected] of [
    [200, {valid:true}, "VERIFIED"],
    [200, {success:true}, "VERIFIED"],
    [200, {valid:false}, "INVALID"],
    [200, {valid:true,success:false}, "VERIFIED"],
    [200, {valid:"true",success:true}, "VERIFIED"],
    [200, {status:"CONCLUDED"}, "VERIFIED"],
    [200, null, "VERIFIED"],
    [200, "OK", "VERIFIED"],
    [202, {}, "VERIFIED"],
    [202, {success:false}, "INVALID"],
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
