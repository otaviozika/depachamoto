function roundMoney(value){return Math.round((Number(value)+Number.EPSILON)*100)/100}
function isFriSun(date){const d=new Date(`${date}T12:00:00Z`).getUTCDay();return d===5||d===6||d===0}
function calc({date,count,per=6,weekday=60,weekend=75,tip=0,discount=0,adjustment=0}){
  const base=count>0?(isFriSun(date)?weekend:weekday):0;
  return roundMoney(count*per+base+tip-discount+adjustment);
}
const tests=[
  ['segunda 13 entregas',calc({date:'2026-08-03',count:13}),138],
  ['sexta 14 entregas',calc({date:'2026-08-07',count:14}),159],
  ['sábado 14 entregas',calc({date:'2026-08-08',count:14}),159],
  ['domingo 13 + gorjeta 4 - desconto 20',calc({date:'2026-08-02',count:13,tip:4,discount:20}),137],
  ['sexta 21 + gorjeta 15 - desconto 121.99',calc({date:'2026-08-07',count:21,tip:15,discount:121.99}),94.01],
  ['zero entregas sem encosta',calc({date:'2026-08-07',count:0}),0],
  ['ajuste manual negativo',calc({date:'2026-08-07',count:10,adjustment:-5}),130]
];
let ok=true;
for(const [name,got,expected] of tests){
  const pass=Math.abs(got-expected)<0.001;
  console.log(`${pass?'PASS':'FAIL'} ${name}: ${got} (esperado ${expected})`);
  if(!pass)ok=false;
}
if(!ok)process.exit(1);
console.log(JSON.stringify({result:'PASS',tests:tests.length,formula:'entregas*valor + encosta + gorjeta - desconto + ajuste'}));
