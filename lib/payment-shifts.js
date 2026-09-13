import { normalizeShiftCode, shiftLabel } from './operational-shift.js';

export function isFriSun(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 5 || day === 6 || day === 0;
}

export function paymentBaseForShift(date, shiftCode, rule) {
  const shift = normalizeShiftCode(shiftCode);
  if (!shift) throw Object.assign(new Error('Turno de pagamento inválido.'), { code: 'PAYMENT_SHIFT_INVALID', status: 400 });
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (shift === 'LUNCH' && day === 0) {
    throw Object.assign(new Error('Domingo não possui turno de almoço.'), { code: 'PAYMENT_SHIFT_NOT_AVAILABLE', status: 400 });
  }
  const weekend = day === 5 || day === 6 || day === 0;
  if (shift === 'LUNCH') return Number(weekend ? rule?.lunch_fri_sun : rule?.lunch_mon_thu) || 0;
  return Number(weekend ? rule?.dinner_fri_sun : rule?.dinner_mon_thu) || 0;
}

export function calculateShiftPayment({ date, shiftCode, deliveryCount, rule, worked = null, rain = false, tip = 0, discount = 0, adjustment = 0 }) {
  const shift = normalizeShiftCode(shiftCode);
  if (!shift) throw Object.assign(new Error('Turno de pagamento inválido.'), { code: 'PAYMENT_SHIFT_INVALID', status: 400 });
  const count = Math.max(0, Number(deliveryCount) || 0);
  const shiftWorked = worked === null ? count > 0 : !!worked;
  const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  const perDelivery = money(rule?.per_delivery);
  const base = shiftWorked ? money(paymentBaseForShift(date, shift, rule)) : 0;
  const rainBonus = shiftWorked && rain ? money(rule?.rain_bonus) : 0;
  const tipAmount = money(tip);
  const discountAmount = Math.max(0, money(discount));
  const adjustmentAmount = money(adjustment);
  const total = money(count * perDelivery + base + rainBonus + tipAmount - discountAmount + adjustmentAmount);
  return {
    shift_code: shift,
    shift_label: shiftLabel(shift),
    worked: shiftWorked,
    delivery_count: count,
    per_delivery: perDelivery,
    base_amount: base,
    rain: !!rain,
    rain_bonus: rainBonus,
    tip_amount: tipAmount,
    discount_amount: discountAmount,
    adjustment_amount: adjustmentAmount,
    total_amount: total
  };
}

export function defaultShiftPaymentRule() {
  return {
    per_delivery: 6,
    lunch_mon_thu: 45,
    lunch_fri_sun: 55,
    dinner_mon_thu: 60,
    dinner_fri_sun: 75,
    rain_bonus: 10
  };
}
