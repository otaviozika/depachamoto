import fs from 'node:fs';
const path=new URL('../public/index.html',import.meta.url);
let s=fs.readFileSync(path,'utf8');
const change=(a,b)=>{if(!s.includes(a))throw Error('Não encontrado: '+a.slice(0,90));s=s.replace(a,b)};
if(!s.includes('payment-longe-v1')){
change('<th>Gorjeta</th><th>Desconto</th><th>Ajuste</th><th>Total</th>','<th>Gorjeta</th><th>Desconto</th><th title="R$ 6,00 por entrega longe">LONGE</th><th>Total</th>');
change('adjustment=moneyNumber($(`payAdjustment-${key}`)?.value)','adjustment=Math.max(0,Number($(`payAdjustment-${key}`)?.value||0))*6');
change('id="payAdjustment-${key}" class="payment-input" type="number" step="0.01" value="${Number(row.adjustment_amount||0).toFixed(2)}"','id="payAdjustment-${key}" class="payment-input" type="number" min="0" step="1" inputmode="numeric" title="R$ 6 por entrega longe" value="${Number(row.longe_count??(Number(row.adjustment_amount||0)/6))||0}"');
change('adjustment_amount:moneyNumber($(`payAdjustment-${key}`).value)','longe_count:Number($(`payAdjustment-${key}`).value)');
change('adjustment_amount:moneyNumber($(`payAdjustment-${key}`)?.value)','longe_count:Number($(`payAdjustment-${key}`)?.value)');
change('const payload={shift_code:current.shift_code,','if(!Number.isInteger(Number($(`payAdjustment-${key}`).value))||Number($(`payAdjustment-${key}`).value)<0)return alert("LONGE deve ser um número inteiro não negativo.");const payload={shift_code:current.shift_code,');
change('const payload={shift_code:row.shift_code,','if(!Number.isInteger(Number($(`payAdjustment-${key}`)?.value))||Number($(`payAdjustment-${key}`)?.value)<0)throw new Error("LONGE deve ser um número inteiro não negativo.");const payload={shift_code:row.shift_code,');
s=s.replace('</head>','<style>/* payment-longe-v1 */#adminApp [id^="payAdjustment-"]{width:82px;text-align:center;font-weight:800}</style></head>');
fs.writeFileSync(path,s);
}
console.log('LONGE instalado');