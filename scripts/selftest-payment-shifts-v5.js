import assert from 'node:assert/strict';
import { calculateShiftPayment, defaultShiftPaymentRule, paymentBaseForShift } from '../lib/payment-shifts.js';
const rule=defaultShiftPaymentRule();
assert.equal(paymentBaseForShift('2026-09-14','LUNCH',rule),45); // segunda
assert.equal(paymentBaseForShift('2026-09-14','DINNER',rule),60);
assert.equal(paymentBaseForShift('2026-09-18','LUNCH',rule),55); // sexta
assert.equal(paymentBaseForShift('2026-09-18','DINNER',rule),75);
assert.equal(paymentBaseForShift('2026-09-19','LUNCH',rule),55); // sábado
assert.equal(paymentBaseForShift('2026-09-20','DINNER',rule),75); // domingo
const lunch=calculateShiftPayment({date:'2026-09-14',shiftCode:'LUNCH',deliveryCount:10,rule});
assert.equal(lunch.total_amount,105); // 10*6 + 45
const rainyDinner=calculateShiftPayment({date:'2026-09-18',shiftCode:'DINNER',deliveryCount:10,rule,rain:true});
assert.equal(rainyDinner.total_amount,145); // 10*6 + 75 + 10
const empty=calculateShiftPayment({date:'2026-09-18',shiftCode:'DINNER',deliveryCount:0,rule,rain:true});
assert.equal(empty.base_amount,0); assert.equal(empty.rain_bonus,0); assert.equal(empty.total_amount,0);
const adjusted=calculateShiftPayment({date:'2026-09-18',shiftCode:'LUNCH',deliveryCount:2,rule,rain:true,tip:5,discount:2,adjustment:-1});
assert.equal(adjusted.total_amount,79); // 12+55+10+5-2-1
console.log(JSON.stringify({result:'PASS',feature:'payments_by_shift',cases:10}));