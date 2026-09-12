from pathlib import Path
p=Path('server.js'); s=p.read_text()
old="SELECT id,dispatch_code,departed_at,operational_stage,returning_at\n      FROM dispatches"
new="SELECT id,dispatch_code,departed_at,operational_date,shift_code,operational_stage,returning_at\n      FROM dispatches"
assert old in s
s=s.replace(old,new,1)
old="""    const effectiveDeparture = existingRoute?.departed_at || departedAt || new Date().toISOString();
    if (append || recovery) {
      const routeShift=existingRoute?.shift_code?{operational_date:existingRoute.operational_date||orderDateSP(effectiveDeparture),shift_code:existingRoute.shift_code,shift_label:shiftLabel(existingRoute.shift_code)}:getCurrentOperationalShift(new Date(effectiveDeparture));
      if(!routeShift)throw Object.assign(new Error('O horário da rota não pertence a um turno operacional.'),{status:409,code:'OUTSIDE_OPERATIONAL_SHIFT'});"""
new="""    const effectiveDeparture = existingRoute?.departed_at || departedAt || new Date().toISOString();
    if (append || recovery) {
      const routeShift=resolveDispatchShift({
        departedAt: effectiveDeparture,
        existingOperationalDate: existingRoute?.operational_date || null,
        existingShiftCode: existingRoute?.shift_code || null,
        recovery
      });"""
assert old in s
s=s.replace(old,new,1)
paid="if(existing?.status==='PAID'&&status!=='PAID'&&req.body.confirm_reopen_paid!==true)return res.status(409).json({error:'Este pagamento já está marcado como PAGO. Confirme explicitamente para reabrir.',code:'PAYMENT_REOPEN_CONFIRMATION'});"
reviewed="if(existing?.status==='REVIEWED'&&status==='OPEN'&&req.body.confirm_reopen_reviewed!==true)return res.status(409).json({error:'Este pagamento já foi CONFERIDO. Confirme explicitamente para reabrir.',code:'PAYMENT_REVIEWED_REOPEN_CONFIRMATION'});"
assert paid in s
s=s.replace(paid,paid+'\n  '+reviewed,1)
p.write_text(s)
p=Path('public/index.html'); x=p.read_text()
sig="async function savePaymentRow(key,confirmReopen=false){"
assert sig in x
x=x.replace(sig,"async function savePaymentRow(key,confirmReopen=false,confirmReviewed=false){",1)
paid_ui="if(current.status==='PAID'&&status!=='PAID'&&!confirmReopen){if(!confirm('Este turno já está PAGO. Deseja reabrir?'))return;confirmReopen=true}"
assert paid_ui in x
x=x.replace(paid_ui,paid_ui+"if(current.status==='REVIEWED'&&status==='OPEN'&&!confirmReviewed){if(!confirm('Este turno já foi CONFERIDO. Deseja reabrir para edição?'))return;confirmReviewed=true}",1)
assert "confirm_reopen_paid:confirmReopen}" in x
x=x.replace("confirm_reopen_paid:confirmReopen}","confirm_reopen_paid:confirmReopen,confirm_reopen_reviewed:confirmReviewed}",1)
catcher="if(err.code==='PAYMENT_REOPEN_CONFIRMATION'&&!confirmReopen)return savePaymentRow(key,true);alert(err.message)"
assert catcher in x
x=x.replace(catcher,"if(err.code==='PAYMENT_REOPEN_CONFIRMATION'&&!confirmReopen)return savePaymentRow(key,true,confirmReviewed);if(err.code==='PAYMENT_REVIEWED_REOPEN_CONFIRMATION'&&!confirmReviewed)return savePaymentRow(key,confirmReopen,true);alert(err.message)",1)
p.write_text(x)
p=Path('scripts/selftest-route-orders.js'); t=p.read_text()
anchor="  getCurrentOperationalShift:d=>({operational_date:d.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),shift_code:'LUNCH',shift_label:'Almoço'}),\n"
resolver="  resolveDispatchShift:({departedAt,existingOperationalDate,existingShiftCode})=>existingShiftCode?({operational_date:existingOperationalDate,shift_code:existingShiftCode,shift_label:existingShiftCode==='LUNCH'?'Almoço':'Janta'}):({operational_date:new Date(departedAt).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),shift_code:'LUNCH',shift_label:'Almoço'}),\n"
assert anchor in t
if resolver not in t: t=t.replace(anchor,anchor+resolver,1)
p.write_text(t)
Path('scripts/selftest-step5-safety.js').write_text("""import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
assert.match(server,/operational_date,shift_code,operational_stage,returning_at/);
assert.match(server,/existingOperationalDate: existingRoute/);
assert.match(server,/existingShiftCode: existingRoute/);
assert.match(server,/PAYMENT_REVIEWED_REOPEN_CONFIRMATION/);
assert.match(server,/confirm_reopen_reviewed/);
assert.match(ui,/confirm_reopen_reviewed:confirmReviewed/);
assert.match(ui,/PAYMENT_REVIEWED_REOPEN_CONFIRMATION/);
console.log(JSON.stringify({result:'PASS',feature:'step5_safety_hardening',checks:7}));
""")
