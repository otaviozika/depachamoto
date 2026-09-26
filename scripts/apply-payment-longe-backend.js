import fs from 'node:fs';
const path=new URL('../server.js',import.meta.url);
let s=fs.readFileSync(path,'utf8');
if(!s.includes('payment-longe-backend-v1')){
const old='const tip=parseMoneyValue(req.body.tip_amount,0),discount=parseMoneyValue(req.body.discount_amount,0),adjustment=parseMoneyValue(req.body.adjustment_amount,0),rain=!!req.body.rain;';
const next='/* payment-longe-backend-v1 */ const longeProvided=req.body.longe_count!==undefined;const longeCount=Number(req.body.longe_count);if(longeProvided&&(!Number.isSafeInteger(longeCount)||longeCount<0||longeCount>10000))return res.status(400).json({error:"LONGE deve ser um número inteiro entre 0 e 10000."});const tip=parseMoneyValue(req.body.tip_amount,0),discount=parseMoneyValue(req.body.discount_amount,0),adjustment=longeProvided?longeCount*6:parseMoneyValue(req.body.adjustment_amount,0),rain=!!req.body.rain;';
if(!s.includes(old))throw Error('Endpoint de pagamentos não localizado');
s=s.replace(old,next);fs.writeFileSync(path,s);
}
console.log('Backend LONGE instalado');