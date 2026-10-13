import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const proxyaddr=require('proxy-addr');

// GHSA-jqcg-44mw-7w3h: a short IPv4-mapped IPv6 prefix must never
// trust arbitrary IPv4 clients and accept their spoofed forwarding headers.
const client='203.0.113.7';
const request={socket:{remoteAddress:client},headers:{'x-forwarded-for':'198.51.100.42'}};
for(const subnet of ['::ffff:10.0.0.0/8','::/1']){
  const trust=proxyaddr.compile(subnet);
  assert.equal(trust(client),false,subnet+' cannot trust an arbitrary IPv4 client');
  assert.equal(proxyaddr(request,trust),client,'untrusted forwarding header is ignored');
}
for(const subnet of ['10.0.0.0/8','::ffff:10.0.0.0/104']){
  const trust=proxyaddr.compile(subnet);
  assert.equal(trust('10.1.2.3'),true,'legitimate subnet stays valid');
  assert.equal(trust(client),false,'external client stays untrusted');
}
// Keep the existing numeric one-hop reverse-proxy contract working too.
assert.equal(proxyaddr(request,(_address,index)=>index<1),'198.51.100.42');
console.log(JSON.stringify({result:'PASS',feature:'proxy_trust_advisory',checks:9}));
