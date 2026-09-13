import assert from 'node:assert/strict';
import { calculateShiftPayment, defaultShiftPaymentRule, paymentBaseForShift } from '../lib/payment-shifts.js';
const rule=defaultShiftPaymentRule();
assert.equal(paymentBaseForShift('2026-09-14','LUNCH',rule),45); // segunda
assert.equal(paymentBaseForShift('2026-09-14','DINNER',rule),60);
assert.equal(paymentBaseForShift('2026-09-18','LUNCH',rule),55); // sexta
assert.equal(paymentBaseForShift('2026-09-18','DINNER',rule),75);
assert.equal(paymentBaseForShift('2026-09-19','LUNCH',rule),55); // sábado
assert.equal(paymentBaseForShift('2026-09-20','DINNER',rule),75); // domingo
assert.throws(() => paymentBaseForShift('2026-09-20','LUNCH',rule), e => e?.code === 'PAYMENT_SHIFT_NOT_AVAILABLE');
const lunch=calculateShiftPayment({date:'2026-09-14',shiftCode:'LUNCH',deliveryCount:10,rule,worked:true});
assert.equal(lunch.total_amount,105); // 10*6 + 45
const rainyDinner=calculateShiftPayment({date:'2026-09-18',shiftCode:'DINNER',deliveryCount:10,rule,rain:true,worked:true});
assert.equal(rainyDinner.total_amount,145); // 10*6 + 75 + 10
const attendedNoDeliveries=calculateShiftPayment({date:'2026-09-18',shiftCode:'DINNER',deliveryCount:0,rule,rain:true,worked:true});
assert.equal(attendedNoDeliveries.base_amount,75); assert.equal(attendedNoDeliveries.rain_bonus,10); assert.equal(attendedNoDeliveries.total_amount,85);
const absent=calculateShiftPayment({date:'2026-09-18',shiftCode:'DINNER',deliveryCount:0,rule,rain:true,worked:false});
assert.equal(absent.base_amount,0); assert.equal(absent.rain_bonus,0); assert.equal(absent.total_amount,0);
const adjusted=calculateShiftPayment({date:'2026-09-18',shiftCode:'LUNCH',deliveryCount:2,rule,rain:true,tip:5,discount:2,adjustment:-1,worked:true});
assert.equal(adjusted.total_amount,79); // 12+55+10+5-2-1
console.log(JSON.stringify({result:'PASS',feature:'payments_by_shift',cases:12}));