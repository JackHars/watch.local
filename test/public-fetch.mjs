import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { isPublicAddress, publicURL, createPublicLookup, publicFetch, readPublicBody } from '../api/public-fetch.mjs';

test('outbound URLs reject private, special-purpose and encoded IP addresses', () => {
  for (const host of [
    '0.0.0.0', '10.0.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254',
    '172.16.1.1', '192.168.1.110', '192.0.0.8', '192.0.2.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]',
    '[64:ff9b::7f00:1]', '[64:ff9b:1::a00:1]', '[fd00::1]', '[fe80::1]',
    '[ff02::1]', '[2002:7f00:1::]', '[2001::1]', '[2001:db8::1]', '[3fff::1]',
    '2130706433', '0x7f000001', '127.1', '0177.0.0.1', '%31%32%37.0.0.1',
    'localhost', 'localhost.', 'watch.local', 'watch.lan', 'box.localdomain',
    'metadata.google.internal', 'foo.localhost', 'router.home.arpa', 'router',
  ]) assert.throws(() => publicURL(`http://${host}/media`), /blocked/, host);
  for (const url of ['file:///etc/passwd', 'data:text/plain,x', 'ftp://example.com/x', 'https://user:secret@example.com/']) assert.throws(() => publicURL(url), /blocked/);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  assert.equal(publicURL('https://media.example.com/signed?token=fixture').hostname, 'media.example.com');
});

test('the socket lookup blocks private DNS answers, including mixed public/private records', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '::1', family: 6 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const lookup = createPublicLookup((host, options, done) => done(null, addresses));
    await assert.rejects(new Promise((resolve, reject) => lookup('untrusted.example', { all: true }, (error, values) => error ? reject(error) : resolve(values))), /blocked/);
  }
  let calls = 0;
  const addresses = [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  const lookup = createPublicLookup((host, options, done) => { calls++; assert.equal(options.all, true); done(null, addresses); });
  const result = await new Promise((resolve, reject) => lookup('public.example', { all: true }, (error, values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(result, addresses); assert.equal(calls, 1, 'connection receives the checked answer without a second lookup');
});

test('a DNS name resolving to loopback cannot even open a TCP connection', async () => {
  let connections = 0;
  const internal = net.createServer(socket => { connections++; socket.end(); });
  internal.listen(0, '127.0.0.1'); await once(internal, 'listening');
  try {
    const socket = net.connect({ host: 'rebind.example', port: internal.address().port,
      lookup: createPublicLookup((host, options, done) => done(null, [{ address: '127.0.0.1', family: 4 }])) });
    const [error] = await once(socket, 'error');
    assert.equal(error.code, 'ERR_UPSTREAM_ADDRESS'); assert.equal(connections, 0);
  } finally { await new Promise(resolve => internal.close(resolve)); }
});

test('each redirect is validated before dispatch, credentials are stripped across origins, loops are bounded', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      assert.equal(init.redirect, 'manual'); assert.ok(init.dispatcher);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    };
    await assert.rejects(publicFetch('https://media.example/playlist.m3u8'), /blocked/);
    assert.equal(requests.length, 1);
    requests.length = 0;
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return new Response(null, { status: 307, headers: { location: 'https://cdn.example/video' } });
      return new Response('video');
    };
    const response = await publicFetch('https://media.example/video', { method: 'POST', body: 'fixture', headers: {
      authorization: 'Bearer fixture', cookie: 'session=fixture', 'proxy-authorization': 'fixture',
      origin: 'https://player.example', referer: 'https://player.example/', host: 'watch.local',
    } });
    assert.equal(await response.text(), 'video');
    assert.equal(requests[1].init.headers.authorization, undefined); assert.equal(requests[1].init.headers.cookie, undefined);
    assert.equal(requests[1].init.headers['proxy-authorization'], undefined); assert.equal(requests[1].init.headers.host, undefined);
    assert.equal(requests[1].init.headers.referer, 'https://player.example/');
    assert.equal(requests[1].init.method, 'POST'); assert.equal(requests[1].init.body, 'fixture');
    requests.length = 0;
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(null, { status: 302, headers: { location: '/loop' } }); };
    await assert.rejects(publicFetch('https://media.example/start'), /redirect refused/);
    assert.equal(requests.length, 8);
    requests.length = 0;
    await assert.rejects(publicFetch('https://media.example/start', { redirect: 'error' }), /redirect refused/);
    assert.equal(requests.length, 1);
    assert.equal((await publicFetch('https://media.example/start', { redirect: 'manual' })).status, 302);
  } finally { globalThis.fetch = original; }
});

test('POST redirects use GET and drop body headers, while cancellation stops dispatch', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1 ? new Response(null, { status: 303, headers: { location: '/next' } }) : new Response('ok');
    };
    await publicFetch('https://media.example/start', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'same-origin' } });
    assert.equal(requests[1].init.method, 'GET'); assert.equal(requests[1].init.body, undefined);
    assert.equal(requests[1].init.headers['content-type'], undefined); assert.equal(requests[1].init.headers.authorization, 'same-origin');
    await assert.rejects(publicFetch('https://media.example/start', { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});

test('buffered upstream bodies enforce actual bytes and cancel oversized chunked responses', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } });
  await assert.rejects(readPublicBody(response, 32), /too large/);
  assert.equal(cancelled, true, 'do not keep downloading after the byte limit');
  assert.equal((await readPublicBody(new Response('fixture'), 7)).toString(), 'fixture');
});
