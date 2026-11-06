import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { deliveryContext,anotaContext,plain,payloadFixture,seedDeliveries,frontendHarness,confirmationEvents } from './egress-test-support.js';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const db=new PGlite();
await db.exec(source.split('await pool.query(`')[1].split('`);')[0]);
let queryCount=0,resultBytes=0,lastMetadata=[];
const query=async(sql,args=[])=>{queryCount++;const result=await db.query(sql,args);resultBytes+=Buffer.byteLength(JSON.stringify(result.rows));if(sql.includes('AS has_detail_payload'))lastMetadata=result.rows;return {...result,rowCount:result.affectedRows??result.rows.length};};
let tests=0;
async function test(name,fn){await fn();tests++;console.log('PASS '+name);}
try {
  const payloads=[null,{},[],[1,2],false,true,42,'invalid-json',JSON.stringify(payloadFixture(999))];
  const names=[{customer:{name:'Ana'}},{customer:{fullName:'Bia'}},{customer:{full_name:'Caio'}},{customer:{firstName:'Dani',lastName:'Silva'}},{customerName:'Eva'},{customer_name:'Fábio'}];
  const address={street_name:'Rua Teste',street_number:'299',complemento:'Casa 2',bairro:'Barcelona',cidade:'São Caetano do Sul',uf:'SP',cep:'09550000',location:{lat:'-23,62',lng:'-46,55'}};
  for(let n=0;n<180;n++) {
    const p={...payloadFixture(n),...names[n%names.length]};
    delete p.delivery;
    const variant=n%6;
    if(variant===0)p.delivery={deliveryAddress:address,observations:'Interfone 8'};
    if(variant===1)p.delivery={address,coordinates:{type:'Point',coordinates:[-46.55,-23.62]}};
    if(variant===2)p.deliveryAddress=address;
    if(variant===3)p.delivery_address=address;
    if(variant===4)p.address=address;
    if(variant===5)p.customer={...p.customer,address};
    if(n%7===0)p.delivery={deliveryAddress:'Rua Inteira, 299, São Caetano do Sul',coordinates:{latitude:-23.62,longitude:-46.55}};
    if(n%11===0)p.payments={pending:0,methods:[{method:'PIX',prepaid:true,value:29.80}]};
    if(n%13===0)p.payments={methods:[{method:'CASH',type:'OFFLINE',value:29.80}]};
    payloads.push(p);
  }
  await seedDeliveries(query,{couriers:1,payloads});
  const optimized=deliveryContext(source,query);
  // Legacy SQL selected o.payload verbatim. Run that reference against the same
  // rows while keeping the public card mapping and authorization filters equal.
  const reference=deliveryContext(source,(sql,args)=>query(sql.replace(/CASE WHEN jsonb_typeof\(o\.payload\)='object' THEN jsonb_build_object\([\s\S]*?\) ELSE o\.payload END AS payload/,'o.payload'),args));
  await test('189 payload shapes produce identical cards, names, payment cents and navigation',async()=>{
    const expected=plain(await reference.getCourierIfoodDeliveries(2));
    const actual=plain(await optimized.getCourierIfoodDeliveries(2));
    assert.deepEqual(actual,expected);
    assert.equal(actual.current.length+actual.pending.length+actual.completed.length,payloads.length);
    assert.ok([...actual.current,...actual.pending,...actual.completed].some(x=>x.payment?.amount===29.80));
    assert.ok([...actual.current,...actual.pending,...actual.completed].some(x=>x.navigation?.address?.includes('299')));
  });
  await test('courier isolation and 48-hour selection remain identical',async()=>{
    assert.deepEqual(plain(await optimized.getCourierIfoodDeliveries(999)),{current:[],pending:[],completed:[]});
    await query("UPDATE dispatches SET departed_at=NOW()-INTERVAL '49 hours' WHERE dispatch_code='egress-10'");
    const a=plain(await optimized.getCourierIfoodDeliveries(2)),b=plain(await reference.getCourierIfoodDeliveries(2));
    assert.deepEqual(a,b);
    assert.equal([...a.current,...a.pending,...a.completed].some(x=>x.order_id==='egress-10'),false);
  });
  await test('new address, amount and conclusion are visible on the very next read',async()=>{
    const replacement=payloadFixture(1);replacement.delivery.deliveryAddress.streetNumber='888';replacement.payments.pending=19.80;
    await query("UPDATE ifood_orders SET payload=$1::jsonb,status='CONCLUDED' WHERE order_id='egress-1'",[JSON.stringify(replacement)]);
    const a=plain(await optimized.getCourierIfoodDeliveries(2));const item=[...a.current,...a.pending,...a.completed].find(x=>x.order_id==='egress-1');
    assert.equal(item.address_parts.number,'888');assert.equal(item.payment.amount,19.80);assert.equal(item.state,'CONCLUDED');
  });
  await test('SQL metadata flags match legacy JavaScript across null, scalar, array and object JSON',async()=>{
    const values=[null,{},[],[1],[1,2],0,1,true,false,'','a','ab','😀',{items:[]},{items:null},{items:[1],other:2},{a:1,b:2}];
    for(let i=0;i<values.length;i++)await query("INSERT INTO anotaai_orders(order_id,page_id,display_id,payload) VALUES($1,'test',$2,$3::jsonb)",['flags-'+i,String(i),JSON.stringify(values[i])]);
    const sql=source.match(/SELECT order_id,status_code,remote_updated_at,display_id,order_type,[\s\S]*?FROM anotaai_orders WHERE order_id=ANY\(\$1::text\[\]\)/)[0];
    const rows=(await query(sql,[values.map((_,i)=>'flags-'+i)])).rows;
    for(const row of rows){const value=values[Number(row.order_id.slice(6))];assert.equal(row.has_items,Array.isArray(value?.items));assert.equal(row.has_detail_payload,Boolean(value&&Object.keys(value).length>=2));assert.equal(Object.hasOwn(row,'payload'),false);}
  });
  await test('100 unchanged AnotaAi orders use one metadata read, preserve details, and never refetch',async()=>{
    const docs=Array.from({length:100},(_,i)=>({_id:'batch-'+i,shortReference:String(8000+i),check:1,updatedAt:'2026-10-30T18:00:00Z'}));
    for(const d of docs)await query("INSERT INTO anotaai_orders(order_id,page_id,display_id,status_code,remote_updated_at,order_type,payload) VALUES($1,'test',$2,1,$3,'DELIVERY',$4::jsonb)",[d._id,d.shortReference,d.updatedAt,JSON.stringify(payloadFixture(1))]);
    const statements=[];const context=anotaContext(source,async(sql,args)=>{statements.push(sql);return query(sql,args);},docs);
    const result=await context.syncAnotaAiPage('test');
    assert.equal(result.listed,100);assert.equal(result.inserted,0);assert.equal(result.changed,0);
    assert.equal(statements.filter(sql=>/SELECT[\s\S]*FROM anotaai_orders/.test(sql)).length,1);
    assert.equal(lastMetadata.length,100);assert.equal(lastMetadata.some(row=>Object.hasOwn(row,'payload')),false);
    const payload=(await query("SELECT payload FROM anotaai_orders WHERE order_id='batch-0'")).rows[0].payload;
    assert.deepEqual(payload.delivery,payloadFixture(1).delivery);assert.deepEqual(payload.items,payloadFixture(1).items);
  });
  await test('dispatch, delivery and iFood bursts coalesce without postponing the urgent update',async()=>{
    const h=frontendHarness(html);h.event('dispatch:changed',{courier_id:2});h.event('ifood:changed',{courier_id:2});h.event('delivery:changed',{courier_id:2});
    await h.advance(149);assert.equal(h.counts.deliveries,0);await h.advance(1);assert.deepEqual(h.counts,{dashboard:1,deliveries:1});await h.advance(2000);assert.deepEqual(h.counts,{dashboard:1,deliveries:1});
  });
  await test('other couriers, admin-only events and unrelated transfer targets do not reload',async()=>{
    const h=frontendHarness(html);for(const name of ['dispatch:changed','delivery:changed','attendance:changed','ifood:changed'])h.event(name,{courier_id:99});h.event('ifood:changed',{scope:'admin'});h.event('ifood:changed',{courier_ids:[98,99]});await h.advance(3000);assert.deepEqual(h.counts,{dashboard:0,deliveries:0});
    h.event('ifood:changed',{courier_ids:[2,3]});await h.advance(250);assert.equal(h.counts.deliveries,1);
  });
  await test('hidden tabs make no requests and recover the queued state when visible',async()=>{
    const h=frontendHarness(html,{hidden:true});for(let i=0;i<100;i++)h.event('delivery:changed',{courier_id:2});h.event('dispatch:changed',{courier_id:2});await h.advance(5000);assert.deepEqual(h.counts,{dashboard:0,deliveries:0});h.hide(false);h.flushVisible();await h.advance(50);assert.deepEqual(h.counts,{dashboard:1,deliveries:1});
  });
  await test('an event arriving during an in-flight read causes a fresh follow-up',async()=>{
    const h=frontendHarness(html,{holdDeliveries:true});h.event('delivery:changed',{courier_id:2});await h.advance(150);assert.equal(h.counts.deliveries,1);h.event('dispatch:changed',{courier_id:2});h.event('delivery:changed',{courier_id:2});await h.advance(2000);assert.equal(h.counts.deliveries,1);h.releaseDeliveries();await h.settle();await h.advance(750);assert.deepEqual(h.counts,{dashboard:1,deliveries:2});
  });
  await test('dashboard failure does not prevent delivery refresh or overlap an in-flight read',async()=>{
    const h=frontendHarness(html,{failDashboard:true,holdDeliveries:true});h.event('dispatch:changed',{courier_id:2});await h.advance(900);assert.equal(h.counts.deliveries,1);h.event('delivery:changed',{courier_id:2});await h.advance(2000);assert.equal(h.counts.deliveries,1);h.releaseDeliveries();await h.settle();await h.advance(750);assert.equal(h.counts.deliveries,2);
  });
  await test('confirmation event identifies its courier and transfer identifies both couriers',async()=>{
    const events=await confirmationEvents(source,2);assert.equal(events[0].body.courier_id,2);
    assert.match(source,/emitRealtime\("ifood:changed", \{ courier_ids: \[transfer\.from_courier_id, transfer\.to_courier_id\] \}\)/);
  });
  console.log(JSON.stringify({result:'PASS',scenarios:tests,payloadCases:payloads.length,jsonFlagCases:17}));
} finally {await db.close();}
