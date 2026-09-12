from pathlib import Path
import re

server_path=Path('server.js')
ui_path=Path('public/index.html')
s=server_path.read_text()
u=ui_path.read_text()

def sub(pattern,repl,text,count=1):
    out,n=re.subn(pattern,repl,text,count=count,flags=re.S)
    if n!=count: raise SystemExit(f'replacement failed: {pattern[:80]} expected {count} got {n}')
    return out

s=s.replace(
'import { getCurrentOperationalShift, getSPDateTime, normalizeShiftCode, shiftLabel } from "./lib/operational-shift.js";',
'import { getCurrentOperationalShift, getSPDateTime, normalizeShiftCode, operationalShiftAt, shiftLabel } from "./lib/operational-shift.js";\nimport { calculateShiftPayment, defaultShiftPaymentRule } from "./lib/payment-shifts.js";'
)

schema_anchor="""CREATE INDEX IF NOT EXISTS courier_payments_status_idx
ON courier_payments(status,payment_date DESC);

INSERT INTO payment_rate_rules(
  effective_from,per_delivery,base_mon_thu,base_fri_sun
)
VALUES('2000-01-01',6.00,60.00,75.00)
ON CONFLICT(effective_from) DO NOTHING;"""
schema_new="""CREATE INDEX IF NOT EXISTS courier_payments_status_idx
ON courier_payments(status,payment_date DESC);

-- v3.8: financeiro por motoboy + data + turno.
ALTER TABLE payment_rate_rules ADD COLUMN IF NOT EXISTS lunch_mon_thu NUMERIC(12,2);
ALTER TABLE payment_rate_rules ADD COLUMN IF NOT EXISTS lunch_fri_sun NUMERIC(12,2);
ALTER TABLE payment_rate_rules ADD COLUMN IF NOT EXISTS dinner_mon_thu NUMERIC(12,2);
ALTER TABLE payment_rate_rules ADD COLUMN IF NOT EXISTS dinner_fri_sun NUMERIC(12,2);
ALTER TABLE payment_rate_rules ADD COLUMN IF NOT EXISTS rain_bonus NUMERIC(12,2) NOT NULL DEFAULT 10;

ALTER TABLE courier_payments ADD COLUMN IF NOT EXISTS shift_code TEXT;
ALTER TABLE courier_payments ADD COLUMN IF NOT EXISTS rain BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE courier_payments ADD COLUMN IF NOT EXISTS rain_bonus_snapshot NUMERIC(12,2);
DO $$ BEGIN
  ALTER TABLE courier_payments ADD CONSTRAINT courier_payments_shift_code_check
    CHECK (shift_code IS NULL OR shift_code IN ('LUNCH','DINNER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS courier_payments_shift_lookup_idx
ON courier_payments(payment_date,shift_code,courier_id);
CREATE UNIQUE INDEX IF NOT EXISTS courier_payments_date_shift_unique_idx
ON courier_payments(payment_date,courier_id,shift_code) WHERE shift_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS courier_payments_legacy_date_unique_idx
ON courier_payments(payment_date,courier_id) WHERE shift_code IS NULL;
ALTER TABLE courier_payments DROP CONSTRAINT IF EXISTS courier_payments_payment_date_courier_id_key;

INSERT INTO payment_rate_rules(
  effective_from,per_delivery,base_mon_thu,base_fri_sun,
  lunch_mon_thu,lunch_fri_sun,dinner_mon_thu,dinner_fri_sun,rain_bonus
)
VALUES('2000-01-01',6.00,60.00,75.00,45.00,55.00,60.00,75.00,10.00)
ON CONFLICT(effective_from) DO UPDATE SET
  lunch_mon_thu=COALESCE(payment_rate_rules.lunch_mon_thu,EXCLUDED.lunch_mon_thu),
  lunch_fri_sun=COALESCE(payment_rate_rules.lunch_fri_sun,EXCLUDED.lunch_fri_sun),
  dinner_mon_thu=COALESCE(payment_rate_rules.dinner_mon_thu,EXCLUDED.dinner_mon_thu),
  dinner_fri_sun=COALESCE(payment_rate_rules.dinner_fri_sun,EXCLUDED.dinner_fri_sun),
  rain_bonus=COALESCE(payment_rate_rules.rain_bonus,EXCLUDED.rain_bonus);

INSERT INTO payment_rate_rules(
  effective_from,per_delivery,base_mon_thu,base_fri_sun,
  lunch_mon_thu,lunch_fri_sun,dinner_mon_thu,dinner_fri_sun,rain_bonus
)
VALUES('2026-09-12',6.00,0.00,65.00,45.00,55.00,60.00,75.00,10.00)
ON CONFLICT(effective_from) DO UPDATE SET
  lunch_mon_thu=45.00,lunch_fri_sun=55.00,dinner_mon_thu=60.00,dinner_fri_sun=75.00,rain_bonus=10.00;"""
if schema_anchor not in s: raise SystemExit('schema anchor missing')
s=s.replace(schema_anchor,schema_new,1)

payment_block=r"function isFriSun\(date\) \{.*?\napp\.get\(\"/api/public/config\""
new_payment=r'''function isFriSun(date) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 5 || d === 6 || d === 0;
}

function paymentShiftForRequest(date, requestedShift = null) {
  if (date < WORK_SHIFT_CUTOVER_DATE) return null;
  const raw = String(requestedShift || '').trim();
  if (!raw) return null;
  const shift = normalizeShiftCode(raw);
  if (!shift) throw Object.assign(new Error('Turno de pagamento inválido.'), { status:400, code:'PAYMENT_SHIFT_INVALID' });
  if (shift === 'LUNCH' && new Date(`${date}T12:00:00Z`).getUTCDay() === 0) {
    throw Object.assign(new Error('Domingo não possui turno de almoço.'), { status:400, code:'PAYMENT_SHIFT_NOT_AVAILABLE' });
  }
  return shift;
}

async function getPaymentRateRule(date) {
  const q = await pool.query(`
    SELECT id,effective_from,per_delivery,base_mon_thu,base_fri_sun,
           lunch_mon_thu,lunch_fri_sun,dinner_mon_thu,dinner_fri_sun,rain_bonus,created_at
    FROM payment_rate_rules WHERE effective_from <= $1::date
    ORDER BY effective_from DESC,id DESC LIMIT 1
  `,[date]);
  const fallback={ id:null,effective_from:'2000-01-01',...defaultShiftPaymentRule(),base_mon_thu:60,base_fri_sun:75,created_at:null };
  const r=q.rows[0]||fallback;
  return {
    id:r.id,effective_from:r.effective_from,per_delivery:Number(r.per_delivery ?? 6),
    base_mon_thu:Number(r.base_mon_thu ?? 60),base_fri_sun:Number(r.base_fri_sun ?? 75),
    lunch_mon_thu:Number(r.lunch_mon_thu ?? 45),lunch_fri_sun:Number(r.lunch_fri_sun ?? 55),
    dinner_mon_thu:Number(r.dinner_mon_thu ?? 60),dinner_fri_sun:Number(r.dinner_fri_sun ?? 75),
    rain_bonus:Number(r.rain_bonus ?? 10),created_at:r.created_at||null
  };
}

function calculatePaymentAmounts({ date, shiftCode=null, deliveryCount, rule, worked=null, rain=false, tip=0, discount=0, adjustment=0 }) {
  if (shiftCode) return calculateShiftPayment({date,shiftCode,deliveryCount,rule,worked,rain,tip,discount,adjustment});
  const count=Math.max(0,Number(deliveryCount)||0);
  const perDelivery=roundMoney(rule?.per_delivery||0);
  const base=count>0?roundMoney(isFriSun(date)?rule?.base_fri_sun||0:rule?.base_mon_thu||0):0;
  const tipAmount=roundMoney(tip),discountAmount=Math.max(0,roundMoney(discount)),adjustmentAmount=roundMoney(adjustment);
  return {shift_code:null,shift_label:'Legado',worked:count>0,delivery_count:count,per_delivery:perDelivery,base_amount:base,rain:false,rain_bonus:0,
    tip_amount:tipAmount,discount_amount:discountAmount,adjustment_amount:adjustmentAmount,
    total_amount:roundMoney(count*perDelivery+base+tipAmount-discountAmount+adjustmentAmount)};
}

async function getCourierDeliveryCount(courierId,date,shiftCode=null,client=pool) {
  const shift=normalizeShiftCode(shiftCode);
  const q=shift?await client.query(`SELECT COUNT(o.id)::int AS c FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE d.courier_id=$1 AND d.operational_date=$2::date AND d.shift_code=$3`,[courierId,date,shift])
    :await client.query(`SELECT COUNT(o.id)::int AS c FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
    WHERE d.courier_id=$1 AND (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$2::date`,[courierId,date]);
  return Number(q.rows[0]?.c||0);
}

async function courierWorkedShift(courierId,date,shiftCode,liveCount=0,client=pool) {
  if (!shiftCode) return Number(liveCount)>0;
  if (Number(liveCount)>0) return true;
  const q=await client.query(`SELECT 1 FROM courier_attendance WHERE courier_id=$1 AND attendance_date=$2::date AND shift_code=$3 LIMIT 1`,[courierId,date,shiftCode]);
  return q.rowCount>0;
}

async function buildPaymentRow(courier,payment,date,rule,liveCount=null,shiftCode=null,worked=null) {
  const shift=normalizeShiftCode(payment?.shift_code||shiftCode);
  const status=payment?.status||'OPEN',locked=status==='REVIEWED'||status==='PAID',pixLocked=status==='PAID';
  const count=locked&&payment?.delivery_count_snapshot!=null?Number(payment.delivery_count_snapshot):Number(liveCount??await getCourierDeliveryCount(courier.id,date,shift));
  const didWork=worked===null?await courierWorkedShift(courier.id,date,shift,count):!!worked;
  const calc=locked&&payment?.total_snapshot!=null?{
    shift_code:shift,shift_label:shift?shiftLabel(shift):'Legado',worked:didWork,delivery_count:count,
    per_delivery:Number(payment.per_delivery_snapshot||0),base_amount:Number(payment.base_snapshot||0),
    rain:!!payment.rain,rain_bonus:Number(payment.rain_bonus_snapshot||0),tip_amount:Number(payment.tip_amount||0),
    discount_amount:Number(payment.discount_amount||0),adjustment_amount:Number(payment.adjustment_amount||0),total_amount:Number(payment.total_snapshot||0)
  }:calculatePaymentAmounts({date,shiftCode:shift,deliveryCount:count,rule,worked:didWork,rain:!!payment?.rain,tip:payment?.tip_amount||0,discount:payment?.discount_amount||0,adjustment:payment?.adjustment_amount||0});
  const currentPixStatus=normalizedPixStatus(courier.pix_status,!!courier.pix_key);
  const lockedPixStatus=normalizedPixStatus(payment?.pix_status_snapshot,!!payment?.pix_key_snapshot);
  return {id:payment?.id||null,payment_date:date,courier_id:courier.id,courier_name:courier.name,nickname:courier.nickname||null,username:courier.username,
    shift_code:shift,shift_label:shift?shiftLabel(shift):'Legado',
    pix_key:pixLocked?(payment?.pix_key_snapshot??courier.pix_key??null):(courier.pix_key||null),pix_type:pixLocked?(payment?.pix_type_snapshot??courier.pix_type??null):(courier.pix_type||null),
    pix_holder_name:pixLocked?(payment?.pix_holder_name_snapshot??courier.pix_holder_name??null):(courier.pix_holder_name||null),
    pix_status:pixLocked?lockedPixStatus:currentPixStatus,pix_status_label:pixStatusLabel(pixLocked?lockedPixStatus:currentPixStatus),...calc,
    payment_method:payment?.payment_method||'',status,status_label:paymentStatusLabel(status),notes:payment?.notes||'',reviewed_at:payment?.reviewed_at||null,paid_at:payment?.paid_at||null,
    locked,rate_effective_from:rule?.effective_from||null};
}

async function getCourierPaymentPeriodShifts(courier,startDate,endDate) {
  const rows=(await pool.query(`WITH deliveries AS (
      SELECT d.operational_date AS payment_date,d.shift_code,COUNT(o.id)::int delivery_count FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE d.courier_id=$1 AND d.operational_date BETWEEN $2::date AND $3::date AND d.shift_code IS NOT NULL GROUP BY 1,2
    ), worked AS (
      SELECT attendance_date AS payment_date,shift_code FROM courier_attendance WHERE courier_id=$1 AND attendance_date BETWEEN $2::date AND $3::date AND shift_code IS NOT NULL
      UNION SELECT payment_date,shift_code FROM deliveries
      UNION SELECT payment_date,shift_code FROM courier_payments WHERE courier_id=$1 AND payment_date BETWEEN $2::date AND $3::date AND shift_code IS NOT NULL
    ) SELECT to_char(w.payment_date,'YYYY-MM-DD') summary_date,w.shift_code,COALESCE(d.delivery_count,0)::int live_delivery_count,p.*
      FROM worked w LEFT JOIN deliveries d ON d.payment_date=w.payment_date AND d.shift_code=w.shift_code
      LEFT JOIN courier_payments p ON p.courier_id=$1 AND p.payment_date=w.payment_date AND p.shift_code=w.shift_code ORDER BY w.payment_date,w.shift_code`,[courier.id,startDate,endDate])).rows;
  const rules=(await pool.query(`SELECT id,to_char(effective_from,'YYYY-MM-DD') effective_from,per_delivery,base_mon_thu,base_fri_sun,lunch_mon_thu,lunch_fri_sun,dinner_mon_thu,dinner_fri_sun,rain_bonus,created_at
    FROM payment_rate_rules WHERE effective_from <= $1::date ORDER BY effective_from DESC,id DESC`,[endDate])).rows.map(r=>({
      ...r,per_delivery:Number(r.per_delivery),base_mon_thu:Number(r.base_mon_thu),base_fri_sun:Number(r.base_fri_sun),lunch_mon_thu:Number(r.lunch_mon_thu??45),lunch_fri_sun:Number(r.lunch_fri_sun??55),dinner_mon_thu:Number(r.dinner_mon_thu??60),dinner_fri_sun:Number(r.dinner_fri_sun??75),rain_bonus:Number(r.rain_bonus??10)}));
  const out=[]; for(const row of rows){const rule=rules.find(r=>r.effective_from<=row.summary_date)||{effective_from:'2000-01-01',...defaultShiftPaymentRule(),base_mon_thu:60,base_fri_sun:75};
    out.push(await buildPaymentRow(courier,row.id?row:null,row.summary_date,rule,Number(row.live_delivery_count||0),row.shift_code,true));}
  return out;
}

function summarizeCourierPaymentShifts(rows){
  return {total_amount:roundMoney(rows.reduce((s,r)=>s+Number(r.total_amount||0),0)),delivery_count:rows.reduce((s,r)=>s+Number(r.delivery_count||0),0),
    worked_shifts:rows.filter(r=>r.worked).length,worked_days:new Set(rows.filter(r=>r.worked).map(r=>r.payment_date)).size,paid_shifts:rows.filter(r=>r.status==='PAID').length};
}

async function getPaymentRows(date,requestedShift=null){
  const shift=paymentShiftForRequest(date,requestedShift),rule=await getPaymentRateRule(date);
  if(date<WORK_SHIFT_CUTOVER_DATE){
    const rows=(await pool.query(`WITH deliveries AS (SELECT d.courier_id,COUNT(o.id)::int delivery_count FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE (d.departed_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date GROUP BY d.courier_id)
      SELECT u.*,COALESCE(del.delivery_count,0)::int live_delivery_count,p.id payment_id,p.* FROM users u LEFT JOIN deliveries del ON del.courier_id=u.id
      LEFT JOIN courier_payments p ON p.courier_id=u.id AND p.payment_date=$1::date AND p.shift_code IS NULL WHERE u.role='courier' AND (COALESCE(del.delivery_count,0)>0 OR p.id IS NOT NULL) ORDER BY u.name`,[date])).rows;
    const out=[];for(const r of rows)out.push(await buildPaymentRow(r,r.payment_id?r:null,date,rule,Number(r.live_delivery_count||0),null));return {rule,rows:out,shift_code:null,shift_label:'Legado'};
  }
  const params=[date,shift];
  const rows=(await pool.query(`WITH deliveries AS (SELECT d.courier_id,d.shift_code,COUNT(o.id)::int delivery_count FROM dispatches d JOIN dispatch_orders o ON o.dispatch_id=d.id
      WHERE d.operational_date=$1::date AND ($2::text IS NULL OR d.shift_code=$2) GROUP BY d.courier_id,d.shift_code),
    worked AS (SELECT courier_id,shift_code FROM courier_attendance WHERE attendance_date=$1::date AND shift_code IS NOT NULL AND ($2::text IS NULL OR shift_code=$2)
      UNION SELECT courier_id,shift_code FROM deliveries UNION SELECT courier_id,shift_code FROM courier_payments WHERE payment_date=$1::date AND shift_code IS NOT NULL AND ($2::text IS NULL OR shift_code=$2))
    SELECT u.id,u.name,u.username,u.nickname,u.pix_key,u.pix_type,u.pix_holder_name,u.pix_status,w.shift_code,COALESCE(d.delivery_count,0)::int live_delivery_count,
      p.id payment_id,p.tip_amount,p.discount_amount,p.adjustment_amount,p.payment_method,p.status,p.notes,p.rain,p.delivery_count_snapshot,p.per_delivery_snapshot,p.base_snapshot,p.rain_bonus_snapshot,p.total_snapshot,
      p.pix_key_snapshot,p.pix_type_snapshot,p.pix_holder_name_snapshot,p.pix_status_snapshot,p.reviewed_at,p.paid_at
    FROM worked w JOIN users u ON u.id=w.courier_id LEFT JOIN deliveries d ON d.courier_id=w.courier_id AND d.shift_code=w.shift_code
    LEFT JOIN courier_payments p ON p.courier_id=w.courier_id AND p.payment_date=$1::date AND p.shift_code=w.shift_code WHERE u.role='courier' ORDER BY u.name,w.shift_code`,params)).rows;
  const out=[];for(const r of rows)out.push(await buildPaymentRow(r,r.payment_id?r:null,date,rule,Number(r.live_delivery_count||0),r.shift_code,true));
  return {rule,rows:out,shift_code:shift,shift_label:shift?shiftLabel(shift):'Todos os turnos'};
}

app.get("/api/public/config"'''
s=sub(payment_block,new_payment,s)

courier_block=r'app\.get\("/api/courier/payment/today".*?\n\}\)\);\n\n\napp\.get\("/api/courier/pix"'
new_courier=r'''app.get("/api/courier/payment/today", auth, courierOnly, asyncRoute(async (req,res)=>{
  await touchPresence(req.session.user.id,'COURIER_WEB');
  const date=await getSPDate(),rule=await getPaymentRateRule(date);
  const courier=(await pool.query(`SELECT id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status FROM users WHERE id=$1 AND role='courier'`,[req.session.user.id])).rows[0];
  if(!courier)return res.status(404).json({error:'Motoboy não encontrado.'});
  const current=getCurrentOperationalShift();
  const fallback=resolveAttendanceViewShift(date,null);
  const currentShift=current?.shift_code||fallback.shift_code;
  const todayRows=(await getPaymentRows(date)).rows.filter(x=>Number(x.courier_id)===Number(courier.id));
  let row=todayRows.find(x=>x.shift_code===currentShift)||await buildPaymentRow(courier,null,date,rule,0,currentShift,false);
  const boundaries=(await pool.query(`SELECT to_char(date_trunc('week',$1::date)::date,'YYYY-MM-DD') week_start,to_char(date_trunc('month',$1::date)::date,'YYYY-MM-DD') month_start`,[date])).rows[0];
  const periodStart=boundaries.week_start<boundaries.month_start?boundaries.week_start:boundaries.month_start;
  const period=await getCourierPaymentPeriodShifts(courier,periodStart,date),week=period.filter(x=>x.payment_date>=boundaries.week_start),month=period.filter(x=>x.payment_date>=boundaries.month_start);
  res.json({payment:row,summary:{today:summarizeCourierPaymentShifts(todayRows),week:summarizeCourierPaymentShifts(week),month:summarizeCourierPaymentShifts(month),week_start:boundaries.week_start,month_start:boundaries.month_start,through:date},
    formula:'entregas × valor por entrega + base do turno + chuva + gorjeta - desconto + ajuste',server_now:new Date().toISOString()});
}));


app.get("/api/courier/pix"'''
s=sub(courier_block,new_courier,s)

admin_block=r'app\.get\("/api/admin/payments".*?\n\}\)\);\n\napp\.get\("/api/admin/dashboard"'
new_admin=r'''app.get("/api/admin/payments", auth, adminOnly, asyncRoute(async (req,res)=>{
  const date=validDate(req.query.date)?String(req.query.date):await getSPDate();
  const requested=String(req.query.shift_code||req.query.shift||'').trim()||null;
  const {rule,rows,shift_code,shift_label}=await getPaymentRows(date,requested);
  const summary=rows.reduce((a,r)=>{a.deliveries+=Number(r.delivery_count||0);a.total=roundMoney(a.total+Number(r.total_amount||0));a.courier_ids.add(Number(r.courier_id));a.shifts+=1;
    if(r.status==='PAID'){a.paid=roundMoney(a.paid+Number(r.total_amount||0));a.paid_count++}else a.pending=roundMoney(a.pending+Number(r.total_amount||0));if(r.status==='REVIEWED')a.reviewed_count++;return a},
    {courier_ids:new Set(),shifts:0,deliveries:0,total:0,paid:0,pending:0,paid_count:0,reviewed_count:0});
  summary.couriers=summary.courier_ids.size;delete summary.courier_ids;
  res.json({date,shift_code,shift_label,day_group:isFriSun(date)?'SEX_DOM':'SEG_QUI',rule,formula:'entregas × valor por entrega + base do turno + chuva + gorjeta - desconto + ajuste',rows,summary,server_now:new Date().toISOString()});
}));

app.get("/api/admin/payments/rules", auth, adminOnly, asyncRoute(async (req,res)=>{
  const date=validDate(req.query.date)?String(req.query.date):await getSPDate(),current=await getPaymentRateRule(date);
  const history=(await pool.query(`SELECT r.id,r.effective_from,r.per_delivery,r.base_mon_thu,r.base_fri_sun,r.lunch_mon_thu,r.lunch_fri_sun,r.dinner_mon_thu,r.dinner_fri_sun,r.rain_bonus,r.created_at,u.name created_by_name
    FROM payment_rate_rules r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.effective_from DESC,r.id DESC LIMIT 30`)).rows.map(r=>({...r,...Object.fromEntries(['per_delivery','base_mon_thu','base_fri_sun','lunch_mon_thu','lunch_fri_sun','dinner_mon_thu','dinner_fri_sun','rain_bonus'].map(k=>[k,Number(r[k]||0)]))}));
  res.json({current,history,date,server_now:new Date().toISOString()});
}));

app.put("/api/admin/payments/rules", auth, adminOnly, asyncRoute(async (req,res)=>{
  const effectiveFrom=validDate(req.body.effective_from)?String(req.body.effective_from):await getSPDate();
  const values=['per_delivery','lunch_mon_thu','lunch_fri_sun','dinner_mon_thu','dinner_fri_sun','rain_bonus'].map(k=>parseMoneyValue(req.body[k],NaN));
  if(!values.every(Number.isFinite)||values.some(x=>x<0||x>100000))return res.status(400).json({error:'Informe valores válidos e positivos para todos os turnos.'});
  const [per,lm,lf,dm,df,rain]=values;
  const q=await pool.query(`INSERT INTO payment_rate_rules(effective_from,per_delivery,base_mon_thu,base_fri_sun,lunch_mon_thu,lunch_fri_sun,dinner_mon_thu,dinner_fri_sun,rain_bonus,created_by)
    VALUES($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(effective_from) DO UPDATE SET per_delivery=EXCLUDED.per_delivery,lunch_mon_thu=EXCLUDED.lunch_mon_thu,lunch_fri_sun=EXCLUDED.lunch_fri_sun,
    dinner_mon_thu=EXCLUDED.dinner_mon_thu,dinner_fri_sun=EXCLUDED.dinner_fri_sun,rain_bonus=EXCLUDED.rain_bonus,created_by=EXCLUDED.created_by,created_at=NOW() RETURNING *`,
    [effectiveFrom,per,dm,df,lm,lf,dm,df,rain,req.session.user.id]);
  await audit(req.session.user.id,'PAYMENT_RULE_UPDATED','payment_rule',q.rows[0].id,{effective_from:effectiveFrom,per_delivery:per,lunch_mon_thu:lm,lunch_fri_sun:lf,dinner_mon_thu:dm,dinner_fri_sun:df,rain_bonus:rain});
  io.emit('payment:changed',{all:true,change:'RULE_UPDATED'});res.json({rule:await getPaymentRateRule(effectiveFrom),message:'Regra de pagamento por turno salva.'});
}));

app.put("/api/admin/payments/:date/:courierId", auth, adminOnly, asyncRoute(async (req,res)=>{
  const date=String(req.params.date||''),courierId=Number(req.params.courierId);if(!validDate(date))return res.status(400).json({error:'Data inválida.'});if(!Number.isInteger(courierId)||courierId<1)return res.status(400).json({error:'Motoboy inválido.'});
  const shift=paymentShiftForRequest(date,req.body.shift_code||req.query.shift_code||null);if(date>=WORK_SHIFT_CUTOVER_DATE&&!shift)return res.status(400).json({error:'Informe o turno do pagamento.',code:'PAYMENT_SHIFT_REQUIRED'});
  const courier=(await pool.query(`SELECT id,name,username,nickname,pix_key,pix_type,pix_holder_name,pix_status FROM users WHERE id=$1 AND role='courier'`,[courierId])).rows[0];if(!courier)return res.status(404).json({error:'Motoboy não encontrado.'});
  const existing=(await pool.query(`SELECT * FROM courier_payments WHERE payment_date=$1::date AND courier_id=$2 AND (($3::text IS NULL AND shift_code IS NULL) OR shift_code=$3) LIMIT 1`,[date,courierId,shift])).rows[0]||null;
  const tip=parseMoneyValue(req.body.tip_amount,0),discount=parseMoneyValue(req.body.discount_amount,0),adjustment=parseMoneyValue(req.body.adjustment_amount,0),rain=!!req.body.rain;
  const paymentMethod=String(req.body.payment_method||'').trim().slice(0,40)||null,notes=String(req.body.notes||'').trim().slice(0,600)||null,status=String(req.body.status||'OPEN').trim().toUpperCase();
  if(!['OPEN','REVIEWED','PAID'].includes(status))return res.status(400).json({error:'Status de pagamento inválido.'});if(![tip,discount,adjustment].every(Number.isFinite)||tip<0||discount<0)return res.status(400).json({error:'Gorjeta, desconto ou ajuste inválido.'});
  if(existing?.status==='PAID'&&status!=='PAID'&&req.body.confirm_reopen_paid!==true)return res.status(409).json({error:'Este pagamento já está marcado como PAGO. Confirme explicitamente para reabrir.',code:'PAYMENT_REOPEN_CONFIRMATION'});
  const liveCount=await getCourierDeliveryCount(courierId,date,shift),worked=await courierWorkedShift(courierId,date,shift,liveCount),rule=await getPaymentRateRule(date);
  const preserve=!!existing&&['REVIEWED','PAID'].includes(existing.status)&&['REVIEWED','PAID'].includes(status),finalTip=preserve?Number(existing.tip_amount||0):tip,finalDiscount=preserve?Number(existing.discount_amount||0):discount,finalAdjustment=preserve?Number(existing.adjustment_amount||0):adjustment,finalRain=preserve?!!existing.rain:rain;
  const calc=preserve?{delivery_count:Number(existing.delivery_count_snapshot||0),per_delivery:Number(existing.per_delivery_snapshot||0),base_amount:Number(existing.base_snapshot||0),rain_bonus:Number(existing.rain_bonus_snapshot||0),total_amount:Number(existing.total_snapshot||0)}:
    calculatePaymentAmounts({date,shiftCode:shift,deliveryCount:liveCount,rule,worked,rain:finalRain,tip:finalTip,discount:finalDiscount,adjustment:finalAdjustment});
  const currentPixStatus=normalizedPixStatus(courier.pix_status,!!courier.pix_key),existingPixStatus=normalizedPixStatus(existing?.pix_status_snapshot,!!existing?.pix_key_snapshot),preservingPaidPix=existing?.status==='PAID'&&status==='PAID';
  if(status==='PAID'&&String(paymentMethod||'').toUpperCase()==='PIX'&&!((preservingPaidPix?existingPixStatus==='VERIFIED'&&!!existing?.pix_key_snapshot:currentPixStatus==='VERIFIED'&&!!courier.pix_key&&!!courier.pix_type&&!!courier.pix_holder_name)))
    return res.status(409).json({error:'O PIX deste motoboy ainda não foi confirmado.',code:'PIX_NOT_VERIFIED'});
  const lock=status==='REVIEWED'||status==='PAID',reviewedAt=lock?(existing?.reviewed_at||new Date()):null,paidAt=status==='PAID'?(existing?.paid_at||new Date()):null;
  const pix=lock?(preservingPaidPix?{key:existing.pix_key_snapshot,type:existing.pix_type_snapshot,holder:existing.pix_holder_name_snapshot,status:existingPixStatus}:{key:courier.pix_key,type:courier.pix_type,holder:courier.pix_holder_name,status:currentPixStatus}):{key:null,type:null,holder:null,status:null};
  let q;if(shift){q=await pool.query(`INSERT INTO courier_payments(payment_date,courier_id,shift_code,rain,tip_amount,discount_amount,adjustment_amount,payment_method,status,notes,delivery_count_snapshot,per_delivery_snapshot,base_snapshot,rain_bonus_snapshot,total_snapshot,pix_key_snapshot,pix_type_snapshot,pix_holder_name_snapshot,pix_status_snapshot,reviewed_at,reviewed_by,paid_at,paid_by,updated_at)
    VALUES($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()) ON CONFLICT(payment_date,courier_id,shift_code) WHERE shift_code IS NOT NULL DO UPDATE SET rain=EXCLUDED.rain,tip_amount=EXCLUDED.tip_amount,discount_amount=EXCLUDED.discount_amount,adjustment_amount=EXCLUDED.adjustment_amount,payment_method=EXCLUDED.payment_method,status=EXCLUDED.status,notes=EXCLUDED.notes,delivery_count_snapshot=EXCLUDED.delivery_count_snapshot,per_delivery_snapshot=EXCLUDED.per_delivery_snapshot,base_snapshot=EXCLUDED.base_snapshot,rain_bonus_snapshot=EXCLUDED.rain_bonus_snapshot,total_snapshot=EXCLUDED.total_snapshot,pix_key_snapshot=EXCLUDED.pix_key_snapshot,pix_type_snapshot=EXCLUDED.pix_type_snapshot,pix_holder_name_snapshot=EXCLUDED.pix_holder_name_snapshot,pix_status_snapshot=EXCLUDED.pix_status_snapshot,reviewed_at=EXCLUDED.reviewed_at,reviewed_by=EXCLUDED.reviewed_by,paid_at=EXCLUDED.paid_at,paid_by=EXCLUDED.paid_by,updated_at=NOW() RETURNING *`,
    [date,courierId,shift,finalRain,finalTip,finalDiscount,finalAdjustment,paymentMethod,status,notes,lock?calc.delivery_count:null,lock?calc.per_delivery:null,lock?calc.base_amount:null,lock?calc.rain_bonus:null,lock?calc.total_amount:null,pix.key,pix.type,pix.holder,pix.status,reviewedAt,lock?req.session.user.id:null,paidAt,status==='PAID'?req.session.user.id:null]);}
  else {if(existing)q=await pool.query(`UPDATE courier_payments SET tip_amount=$3,discount_amount=$4,adjustment_amount=$5,payment_method=$6,status=$7,notes=$8,delivery_count_snapshot=$9,per_delivery_snapshot=$10,base_snapshot=$11,total_snapshot=$12,pix_key_snapshot=$13,pix_type_snapshot=$14,pix_holder_name_snapshot=$15,pix_status_snapshot=$16,reviewed_at=$17,reviewed_by=$18,paid_at=$19,paid_by=$20,updated_at=NOW() WHERE id=$1 AND courier_id=$2 RETURNING *`,[existing.id,courierId,finalTip,finalDiscount,finalAdjustment,paymentMethod,status,notes,lock?calc.delivery_count:null,lock?calc.per_delivery:null,lock?calc.base_amount:null,lock?calc.total_amount:null,pix.key,pix.type,pix.holder,pix.status,reviewedAt,lock?req.session.user.id:null,paidAt,status==='PAID'?req.session.user.id:null]);else q=await pool.query(`INSERT INTO courier_payments(payment_date,courier_id,tip_amount,discount_amount,adjustment_amount,payment_method,status,notes) VALUES($1::date,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[date,courierId,finalTip,finalDiscount,finalAdjustment,paymentMethod,status,notes]);}
  const row=await buildPaymentRow(courier,q.rows[0],date,rule,liveCount,shift,worked);await audit(req.session.user.id,'PAYMENT_UPDATED','courier_payment',q.rows[0].id,{payment_date:date,shift_code:shift,courier_id:courierId,courier_name:courier.name,delivery_count:row.delivery_count,total_amount:row.total_amount,status,rain:finalRain});
  io.emit('payment:changed',{courier_id:courierId,shift_code:shift});res.json({payment:row,message:`Pagamento de ${row.shift_label} atualizado.`,server_now:new Date().toISOString()});
}));

app.get("/api/admin/payments.csv", auth, adminOnly, asyncRoute(async (req,res)=>{
  const date=validDate(req.query.date)?String(req.query.date):await getSPDate(),requested=String(req.query.shift_code||req.query.shift||'').trim()||null;const {rows}=await getPaymentRows(date,requested);
  const header=['Data','Turno','Motoboy','Apelido','Titular PIX','Chave PIX','Tipo PIX','Status PIX','Nº Entregas','Valor por Entrega','Base','Chuva','Adicional chuva','Gorjeta','Desconto','Ajuste','Forma PGMT','Status','Total','Observações'];
  const lines=[header.map(csvCell).join(';')];for(const r of rows)lines.push([date,r.shift_label,r.courier_name,r.nickname||'',r.pix_holder_name||'',r.pix_key||'',r.pix_type||'',r.pix_status_label||'',r.delivery_count,r.per_delivery,r.base_amount,r.rain?'SIM':'NÃO',r.rain_bonus,r.tip_amount,r.discount_amount,r.adjustment_amount,r.payment_method||'',paymentStatusLabel(r.status),r.total_amount,r.notes||''].map(csvCell).join(';'));
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="despachefull-pagamentos-${date}${requested?'-'+requested.toLowerCase():''}.csv"`);res.send('\uFEFF'+lines.join('\r\n'));
  await audit(req.session.user.id,'PAYMENT_REPORT_EXPORTED','payment',null,{date,shift_code:requested,rows:rows.length});
}));

app.get("/api/admin/dashboard"'''
s=sub(admin_block,new_admin,s)

# Payment locks now protect only the affected shift, not the whole day.
s=s.replace("""const payment = (await client.query(`SELECT status FROM courier_payments
      WHERE courier_id=$1 AND payment_date=($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date FOR UPDATE`, [courierId, departedAt])).rows[0];
    if (payment && payment.status !== 'OPEN') throw Object.assign(new Error('O pagamento deste dia já foi revisado ou pago. Reabra-o no Financeiro antes de vincular o pedido.'), { status:409 });""",
"""const recoveredShift=operationalShiftAt(departedAt);
    if(!recoveredShift) throw Object.assign(new Error('O horário informado não pertence a um turno operacional.'),{status:409,code:'OUTSIDE_OPERATIONAL_SHIFT'});
    const payment=(await client.query(`SELECT status FROM courier_payments WHERE courier_id=$1 AND payment_date=$2::date AND shift_code=$3 FOR UPDATE`,[courierId,recoveredShift.operational_date,recoveredShift.shift_code])).rows[0];
    if(payment&&payment.status!=='OPEN')throw Object.assign(new Error(`O pagamento de ${recoveredShift.shift_label} já foi revisado ou pago. Reabra este turno no Financeiro antes de vincular o pedido.`),{status:409});""",1)

s=s.replace("""const payment = (await client.query(`SELECT status FROM courier_payments
        WHERE courier_id=$1 AND payment_date=($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
        FOR UPDATE`, [courierId, effectiveDeparture])).rows[0];
      if (payment && payment.status !== 'OPEN') throw Object.assign(new Error('O pagamento deste dia já foi revisado ou pago. Reabra-o no Financeiro antes de vincular o pedido.'), { status: 409 });""",
"""const routeShift=existingRoute?.shift_code?{operational_date:existingRoute.operational_date||orderDateSP(effectiveDeparture),shift_code:existingRoute.shift_code,shift_label:shiftLabel(existingRoute.shift_code)}:operationalShiftAt(effectiveDeparture);
      if(!routeShift)throw Object.assign(new Error('O horário da rota não pertence a um turno operacional.'),{status:409,code:'OUTSIDE_OPERATIONAL_SHIFT'});
      const payment=(await client.query(`SELECT status FROM courier_payments WHERE courier_id=$1 AND payment_date=$2::date AND shift_code=$3 FOR UPDATE`,[courierId,routeShift.operational_date,routeShift.shift_code])).rows[0];
      if(payment&&payment.status!=='OPEN')throw Object.assign(new Error(`O pagamento de ${routeShift.shift_label} já foi revisado ou pago. Reabra este turno no Financeiro antes de vincular o pedido.`),{status:409});""",1)

# UI: add shift selector, six rule inputs and shift/rain columns.
u=u.replace('<p class="muted">Fechamento diário calculado automaticamente pelas entregas. PIX cadastrado pelo motoboy precisa de confirmação do Admin.</p>','<p class="muted">Fechamento separado por almoço e janta. Cada turno possui base, entregas e adicional de chuva independentes.</p>')
u=u.replace('''<label>Data
              <input id="paymentDate" type="date" onchange="loadPayments()">
            </label>''','''<label>Data
              <input id="paymentDate" type="date" onchange="loadPayments()">
            </label>
            <label>Turno
              <select id="paymentShift" onchange="loadPayments()"><option value="">Todos</option><option value="LUNCH">Almoço</option><option value="DINNER">Janta</option></select>
            </label>''')
u=u.replace('<div class="label">Total do dia</div>','<div class="label">Total selecionado</div>')
u=u.replace('''<div class="payment-formula"><b>Fórmula:</b> Entregas × valor por entrega + encosta + gorjeta − desconto + ajuste.</div>
            <div class="settings-grid" style="margin-top:14px">
              <label><b>Valor por entrega</b><input id="paymentPerDelivery" type="number" min="0" step="0.01"></label>
              <label><b>Encosta Seg–Qui</b><input id="paymentBaseWeekday" type="number" min="0" step="0.01"></label>
              <label><b>Encosta Sex–Dom</b><input id="paymentBaseWeekend" type="number" min="0" step="0.01"></label>
            </div>''','''<div class="payment-formula"><b>Fórmula:</b> Entregas × valor por entrega + base do turno + chuva + gorjeta − desconto + ajuste.</div>
            <div class="settings-grid" style="margin-top:14px">
              <label><b>Valor por entrega</b><input id="paymentPerDelivery" type="number" min="0" step="0.01"></label>
              <label><b>Almoço Seg–Qui</b><input id="paymentLunchWeekday" type="number" min="0" step="0.01"></label>
              <label><b>Almoço Sex–Sáb</b><input id="paymentLunchWeekend" type="number" min="0" step="0.01"></label>
              <label><b>Janta Seg–Qui</b><input id="paymentDinnerWeekday" type="number" min="0" step="0.01"></label>
              <label><b>Janta Sex–Dom</b><input id="paymentDinnerWeekend" type="number" min="0" step="0.01"></label>
              <label><b>Adicional chuva</b><input id="paymentRainBonus" type="number" min="0" step="0.01"></label>
            </div>''')
u=u.replace('<th>Motoboy</th><th>Entregas</th><th>R$/entrega</th><th>Encosta</th>','<th>Motoboy</th><th>Turno</th><th>Entregas</th><th>R$/entrega</th><th>Base</th><th>Chuva</th>')

# Replace finance JS functions as a single block.
ui_pattern=r'function previewPaymentRow\(courierId\).*?\nasync function loadMyPayment\(\)\{'
ui_new=r'''function paymentRowKey(row){return `${row.courier_id}-${row.shift_code||'LEGACY'}`}
function previewPaymentRow(key){const row=paymentState.rows.find(x=>paymentRowKey(x)===String(key));if(!row||row.locked)return;const tip=moneyNumber($(`payTip-${key}`)?.value),discount=Math.max(0,moneyNumber($(`payDiscount-${key}`)?.value)),adjustment=moneyNumber($(`payAdjustment-${key}`)?.value),rain=$(`payRain-${key}`)?.checked===true;
  const total=Math.round((row.delivery_count*row.per_delivery+row.base_amount+(rain?Number(paymentState.rule?.rain_bonus||0):0)+tip-discount+adjustment)*100)/100;if($(`payTotalRow-${key}`))$(`payTotalRow-${key}`).textContent=brl(total)}
function renderPayments(){const d=paymentState;$('payCouriers').textContent=d.summary.couriers||0;$('payDeliveries').textContent=d.summary.deliveries||0;$('payTotal').textContent=brl(d.summary.total);$('payPaid').textContent=brl(d.summary.paid);$('payPending').textContent=brl(d.summary.pending);
  $('paymentRuleSummary').textContent=`${brl(d.rule?.per_delivery)} por entrega • Almoço ${brl(d.rule?.lunch_mon_thu)} Seg–Qui / ${brl(d.rule?.lunch_fri_sun)} Sex–Sáb • Janta ${brl(d.rule?.dinner_mon_thu)} Seg–Qui / ${brl(d.rule?.dinner_fri_sun)} Sex–Dom • Chuva +${brl(d.rule?.rain_bonus)}`;
  $('paymentDayInfo').textContent=`${d.date.split('-').reverse().join('/')} • ${d.shift_label||'Todos os turnos'} • ${d.rows.length} fechamento(s)`;$('paymentPerDelivery').value=Number(d.rule?.per_delivery||0).toFixed(2);$('paymentLunchWeekday').value=Number(d.rule?.lunch_mon_thu||0).toFixed(2);$('paymentLunchWeekend').value=Number(d.rule?.lunch_fri_sun||0).toFixed(2);$('paymentDinnerWeekday').value=Number(d.rule?.dinner_mon_thu||0).toFixed(2);$('paymentDinnerWeekend').value=Number(d.rule?.dinner_fri_sun||0).toFixed(2);$('paymentRainBonus').value=Number(d.rule?.rain_bonus||0).toFixed(2);
  $('paymentTable').innerHTML=d.rows.map(row=>{const key=paymentRowKey(row),disabled=row.locked?'disabled':'',lockedClass=row.locked?'payment-locked':'',pixStatus=row.pix_status||(row.pix_key?'VERIFIED':'NONE');let pix='';
    if(!row.pix_key)pix='<span class="badge gray">SEM PIX</span>';else if(pixStatus==='VERIFIED')pix=`<div class="payment-pix"><div class="pix-holder">${escapeHtml(row.pix_holder_name||'')}</div>${escapeHtml(row.pix_key)}<div><span class="badge green">VERIFICADO</span></div></div>`;else pix='<span class="badge yellow">AGUARDANDO</span>';
    return `<tr class="${lockedClass}"><td><b>${escapeHtml(row.courier_name)}</b></td><td><span class="badge ${row.shift_code==='LUNCH'?'yellow':'blue'}">${escapeHtml(row.shift_label)}</span></td><td><b>${row.delivery_count}</b></td><td>${brl(row.per_delivery)}</td><td>${brl(row.base_amount)}</td>
      <td><label><input id="payRain-${key}" type="checkbox" ${row.rain?'checked':''} ${disabled} onchange="previewPaymentRow('${key}')"> +${brl(d.rule?.rain_bonus)}</label></td>
      <td><input id="payTip-${key}" class="payment-input" type="number" min="0" step="0.01" value="${Number(row.tip_amount||0).toFixed(2)}" ${disabled} oninput="previewPaymentRow('${key}')"></td><td><input id="payDiscount-${key}" class="payment-input" type="number" min="0" step="0.01" value="${Number(row.discount_amount||0).toFixed(2)}" ${disabled} oninput="previewPaymentRow('${key}')"></td><td><input id="payAdjustment-${key}" class="payment-input" type="number" step="0.01" value="${Number(row.adjustment_amount||0).toFixed(2)}" ${disabled} oninput="previewPaymentRow('${key}')"></td>
      <td><span id="payTotalRow-${key}" class="payment-total">${brl(row.total_amount)}</span></td><td>${pix}</td><td><select id="payMethod-${key}" class="payment-select" ${disabled}>${paymentMethodOptions(row.payment_method)}</select></td><td><select id="payStatus-${key}" class="payment-select">${paymentStatusOptions(row.status)}</select></td><td><input id="payNotes-${key}" class="payment-note" maxlength="600" value="${escapeHtml(row.notes||'')}" ${disabled}></td><td><button class="btn primary" onclick="savePaymentRow('${key}')">Salvar</button></td></tr>`}).join('')||empty(15)}
async function loadPayments(){if(!me||me.role!=='admin')return;const date=$('paymentDate')?.value||spToday(),shift=$('paymentShift')?.value||'';if($('paymentDate'))$('paymentDate').value=date;try{paymentState=await api('/api/admin/payments?date='+encodeURIComponent(date)+(shift?'&shift_code='+shift:''));renderPayments()}catch(err){$('paymentTable').innerHTML=`<tr><td colspan="15"><div class="msg err">${escapeHtml(err.message)}</div></td></tr>`}}
async function savePaymentRule(){const payload={effective_from:$('paymentRuleEffective').value||spToday(),per_delivery:moneyNumber($('paymentPerDelivery').value),lunch_mon_thu:moneyNumber($('paymentLunchWeekday').value),lunch_fri_sun:moneyNumber($('paymentLunchWeekend').value),dinner_mon_thu:moneyNumber($('paymentDinnerWeekday').value),dinner_fri_sun:moneyNumber($('paymentDinnerWeekend').value),rain_bonus:moneyNumber($('paymentRainBonus').value)};if(!confirm(`Salvar esta regra a partir de ${payload.effective_from.split('-').reverse().join('/')}?`))return;try{const d=await api('/api/admin/payments/rules',{method:'PUT',body:JSON.stringify(payload)});message('paymentRuleMsg',d.message||'Regra salva.','ok');await loadPayments()}catch(err){message('paymentRuleMsg',err.message,'err')}}
async function savePaymentRow(key,confirmReopen=false){const current=paymentState.rows.find(x=>paymentRowKey(x)===String(key));if(!current)return;const status=$(`payStatus-${key}`).value;if(current.status==='OPEN'&&status==='REVIEWED'&&!confirm(`Conferir o pagamento de ${current.shift_label}? Os valores serão congelados.`))return;if(current.status!=='PAID'&&status==='PAID'&&!confirm(`Marcar ${current.shift_label} como PAGO?`))return;if(current.status==='PAID'&&status!=='PAID'&&!confirmReopen){if(!confirm('Este turno já está PAGO. Deseja reabrir?'))return;confirmReopen=true}
  const payload={shift_code:current.shift_code,rain:$(`payRain-${key}`)?.checked===true,tip_amount:moneyNumber($(`payTip-${key}`).value),discount_amount:moneyNumber($(`payDiscount-${key}`).value),adjustment_amount:moneyNumber($(`payAdjustment-${key}`).value),payment_method:$(`payMethod-${key}`).value,status,notes:$(`payNotes-${key}`).value,confirm_reopen_paid:confirmReopen};try{await api(`/api/admin/payments/${paymentState.date}/${current.courier_id}`,{method:'PUT',body:JSON.stringify(payload)});await loadPayments()}catch(err){if(err.code==='PAYMENT_REOPEN_CONFIRMATION'&&!confirmReopen)return savePaymentRow(key,true);alert(err.message)}}
function exportPayments(){const date=$('paymentDate')?.value||spToday(),shift=$('paymentShift')?.value||'';location.href='/api/admin/payments.csv?date='+encodeURIComponent(date)+(shift?'&shift_code='+shift:'')}
async function loadMyPayment(){'''
u=sub(ui_pattern,ui_new,u)

# Courier text now explicitly names the current shift and daily total.
u=u.replace("$('myEarningsToday').textContent=brl(summary.today?.total_amount??p.total_amount);","$('myEarningsToday').textContent=brl(summary.today?.total_amount??p.total_amount);")
u=u.replace("$('myPaymentMessage').textContent=p.locked\n      ? `Fechamento ${paymentStatusText(p.status).toLowerCase()}. Os valores estão congelados.`\n      : 'Valor parcial: atualiza automaticamente conforme novas entregas são registradas.';","$('myPaymentMessage').textContent=p.locked\n      ? `${p.shift_label}: fechamento ${paymentStatusText(p.status).toLowerCase()}. Os valores estão congelados.`\n      : `${p.shift_label}: valor parcial do turno. O total de hoje soma almoço + janta.`;")

server_path.write_text(s)
ui_path.write_text(u)
print('STEP5_SOURCE_MATERIALIZED')
