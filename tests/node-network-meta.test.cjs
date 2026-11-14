const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
let currentRoute;
let requestCount = 0;
let privateSite = false;
const nodes = {
  public: { uuid: 'public', hidden: false, ipv4: '8.8.8.8', ipv6: '2001:4860:4860::8888' },
  privateIP: { uuid: 'privateIP', hidden: false, ipv4: '192.168.10.15', ipv6: 'fe80::1' },
  hidden: { uuid: 'hidden', hidden: true, ipv4: '1.1.1.1', ipv6: '' },
};
const server = {
  route: (method, endpoint, handler) => { assert.equal(method, 'GET'); currentRoute = { endpoint, handler }; },
  call: async (method) => {
    if (method === 'common:getNodes') return nodes;
    if (method === 'public:getPublicSettings') return { private_site: privateSite };
    throw new Error('Unexpected RPC ' + method);
  },
};
const sandbox = {
  require: (name) => { assert.equal(name, 'server'); return server; },
  console, Map, Object, Date, Promise, encodeURIComponent,
  fetch: async (url) => {
    requestCount++;
    if (url.includes('8.8.8.8') || url.includes('2001%3A4860%3A4860%3A%3A8888')) {
      return { ok: true, json: async () => ({ asn: 'AS15169 Google LLC', country: 'United States' }) };
    }
    throw new Error('Should not request hidden or private IP: ' + url);
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'node-network-meta', 'script.js'), 'utf8'), sandbox);
sandbox.load();
assert.equal(currentRoute.endpoint, '/api/vlongx/node-network-meta');
function response() {
  return { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; }, end(payload) { this.body = JSON.parse(payload); } };
}
(async () => {
  let res = response();
  await currentRoute.handler({ context: { principal: { type: 'guest' } } }, res);
  assert.deepEqual(Object.keys(res.body.nodes).sort(), ['privateIP', 'public']);
  assert.equal(res.body.nodes.public.asn, 'AS15169 Google LLC');
  assert.equal(res.body.nodes.public.ipv4_country, 'United States');
  assert.equal(res.body.nodes.public.ipv6_country, 'United States');
  assert.equal(res.body.nodes.privateIP.asn, '');
  assert(!JSON.stringify(res.body).includes('8.8.8.8'));
  assert(!JSON.stringify(res.body).includes('2001:4860'));
  assert.equal(requestCount, 2);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.diagnostics.visible_nodes, 2);
  assert.equal(res.body.diagnostics.nodes_with_public_ip, 1);
  assert.equal(res.body.diagnostics.nodes_with_asn, 1);
  assert.equal(res.body.diagnostics.nodes_with_country, 1);
  res = response();
  await currentRoute.handler({ context: { principal: { type: 'guest' } } }, res);
  assert.equal(requestCount, 2, 'Second request should use cached lookup results');
  privateSite = true;
  res = response();
  await currentRoute.handler({ context: { principal: { type: 'guest' } } }, res);
  assert.deepEqual(Object.keys(res.body.nodes), [], 'Private site must not expose metadata to guests');
  res = response();
  await currentRoute.handler({ context: { principal: { type: 'user', roles: ['admin'] } } }, res);
  assert.equal(res.body.nodes.public.asn, 'AS15169 Google LLC',
    'Authenticated admin must see metadata on private sites (principal.type is user)');
  assert(!JSON.stringify(res.body).includes('8.8.8.8'));
  console.log('PASS: public ASN / IPv4 / IPv6 metadata, private-site admin access, safe diagnostics, cache, hidden filtering');
})().catch((e) => { console.error(e); process.exitCode = 1; });
