import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const begin = html.indexOf("// O iFood pode concluir a entrega");
const end = html.indexOf("\nlet courierActiveDispatch=null;", begin);
assert.ok(begin !== -1 && end > begin, "Fluxo de reconciliação ausente");
const confirmationFunctions = html.slice(begin, end);

async function simulate({ code = "123456", post, deliveries, refreshFails = false, extraSubmits = 0 }) {
  const output = [];
  const fields = { deliveryConfirmCode: { value: code }, deliveryConfirmBtn: { disabled: false } };
  const target = { orderId: "order-fixture", displayId: "1234" };
  let posts = 0;
  let getRequests = 0;
  const context = {
    deliveryConfirmationTarget: target,
    $: id => fields[id],
    message: (_id, text, type) => output.push({ text, type }),
    api: async (url, options) => {
      if (options?.method === "POST") {
        posts += 1;
        return post();
      }
      getRequests += 1;
      return deliveries();
    },
    loadCourier: async () => {
      if (refreshFails) throw new Error("dashboard fetch failed");
    },
    loadCourierDeliveries: async () => {},
    closeDeliveryConfirmModal: () => {},
    setTimeout: (callback, ms) => { if (ms >= 1000) queueMicrotask(callback); }
  };
  vm.runInNewContext(confirmationFunctions +
    "\nglobalThis.__submit = submitDeliveryConfirmation;", context);
  const requests = [context.__submit({ preventDefault() {} })];
  for (let n = 0; n < extraSubmits; n++) requests.push(context.__submit({ preventDefault() {} }));
  await Promise.all(requests);
  return { output, fields, posts, getRequests };
}

test("POST accepted: failed dashboard refresh is not a code error", async () => {
  const s = await simulate({
    post: () => ({ message: "Código aceito pelo iFood." }),
    deliveries: () => ({ current: [] }),
    refreshFails: true
  });
  assert.equal(s.posts, 1);
  assert.ok(s.output.some(x => x.type === "ok"));
  assert.ok(!s.output.some(x => x.type === "err"));
});


test("five rapid taps cause exactly one iFood verification call", async () => {
  const s = await simulate({
    extraSubmits: 4,
    post: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { message: "Código aceito pelo iFood." };
    },
    deliveries: () => ({ current: [] })
  });
  assert.equal(s.posts, 1);
  assert.ok(s.output.some(x => x.type === "ok"));
  assert.equal(s.fields.deliveryConfirmBtn.disabled, true,
    "after a successful POST the button must remain locked until the modal closes");
});

test("after a failed validation the button can be used once more", async () => {
  const s = await simulate({
    post: () => { throw Object.assign(new Error("Código incorreto"), { code: "DELIVERY_CODE_INVALID", status: 422 }); },
    deliveries: () => ({ current: [{ order_id: "order-fixture", state: "FAILED" }] })
  });
  assert.equal(s.posts, 1);
  assert.equal(s.fields.deliveryConfirmBtn.disabled, false);
  assert.equal(s.fields.deliveryConfirmCode.value, "123456");
});

test("422 followed by CONCLUDED is reconciled without another POST", async () => {
  const s = await simulate({
    post: () => { throw Object.assign(new Error("upstream rejected"), { status: 422, code: "IFOOD_VERIFY_REJECTED" }); },
    deliveries: () => ({ current: [{ order_id: "order-fixture", state: "CONCLUDED" }] })
  });
  assert.equal(s.posts, 1);
  assert.ok(s.output.some(x => x.type === "ok"));
  assert.equal(s.fields.deliveryConfirmCode.value, "");
});

test("422 without confirmation keeps the code and reports an error", async () => {
  const s = await simulate({
    post: () => { throw Object.assign(new Error("iFood não confirmou"), { status: 422, code: "IFOOD_VERIFY_REJECTED" }); },
    deliveries: () => ({ current: [{ order_id: "order-fixture", state: "FAILED" }] })
  });
  assert.equal(s.posts, 1);
  assert.equal(s.fields.deliveryConfirmCode.value, "123456");
  assert.equal(s.output.at(-1).type, "err");
});

test("network failure never means success without verified status", async () => {
  const s = await simulate({
    post: () => { throw Object.assign(new Error("connection lost"), { code: "NETWORK_ERROR" }); },
    deliveries: () => { throw new Error("offline"); }
  });
  assert.equal(s.posts, 1);
  assert.equal(s.output.at(-1).type, "err");
  assert.match(s.output.at(-1).text, /Conexão interrompida/);
});

test("invalid code format never reaches API", async () => {
  const s = await simulate({
    code: "123",
    post: () => { throw new Error("unexpected POST"); },
    deliveries: () => ({ current: [] })
  });
  assert.equal(s.posts, 0);
  assert.equal(s.output.at(-1).type, "err");
});

test("backend preserves completed state under concurrent confirmation errors", () => {
  assert.match(server, /WHERE ifood_order_id=\$1 AND status='PROCESSING'/);
  assert.match(server, /SET status=CASE WHEN status='CONCLUDED' THEN status ELSE 'VERIFIED' END/);
  assert.match(server, /alreadyConcluded/);
  assert.match(server, /code: clearlyWrongCode \? "DELIVERY_CODE_INVALID" : "IFOOD_VERIFY_REJECTED"/);
});
