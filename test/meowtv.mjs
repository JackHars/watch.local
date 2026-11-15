import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';
import { meowtvKey, buildMeowtvDeobfuscator, setMeowtvDeobfuscator } from '../api/meowtv.mjs';

const API = 'https://api.meowtv.ru';
const SITE_ORIGIN = 'https://meowtv.ru';
const CDN_A = 'https://cdn-a.meowtv.example';
const CDN_B = 'https://cdn-b.meowtv.example';
const ALIAS_A = 'https://alias-a.meowtv.example/';
const ALIAS_B = 'https://alias-b.meowtv.example/';
const TICKET = 'fixture-stream-ticket';

// Deterministic upstream for the ticketed resolver and its referer-gated CDN.
// Media is MPEG-TS (0x47 packet sync), like the live service; the "envelope"
// {n, d} carries the stream list base64-encoded in d, and the injected
// deobfuscator "decrypts" it — mirroring the live AES-CTR+WASM chain without
// needing a live site (the real WASM build is covered by its own test).
function meowtvFetch({ noStream = false, emptyStreams = false, ticketFail = false, baitFirst = false } = {}) {
  const calls = [];
  const mediaCalls = [];
  const ts = () => { const b = Buffer.alloc(5 * 188); for (let i = 0; i < 5; i++) b[i * 188] = 0x47; return b; };
  const png = Buffer.from('89504e470d0a1a0a504e470d0a1a0a', 'hex');
  const master = dir => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n${dir}/v0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n${dir}/v1.m3u8\n`;
  const leaf = () => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts\n#EXT-X-ENDLIST\n`;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const hls = text => new Response(text, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  const streamsFor = (kind, id, season, episode) => [
    baitFirst
      ? { language: 'Original', url: `${CDN_B}/${kind}/${id}.png`, headers: { Referer: ALIAS_B } }
      : { language: 'Hindi', url: `${CDN_A}/${kind}/${id}${kind === 'tv' ? `/${season}/${episode}` : ''}/master.m3u8`, headers: { Referer: ALIAS_A } },
    { language: 'English', url: `${CDN_B}/${kind}/${id}${kind === 'tv' ? `/${season}/${episode}` : ''}/en/master.m3u8`, headers: { Referer: ALIAS_B } },
  ];
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    const headers = options.headers || {};
    calls.push({ method: options.method || 'GET', url: u, headers });
    if (u.origin === API) {
      if (u.pathname === '/streams/ticket' && (options.method || 'GET') === 'POST') {
        if (ticketFail) return json({ error: 'rate limited' }, 500);
        return json({ ticket: TICKET, exp: 9999999999999 });
      }
      const m = u.pathname.match(/^\/streams\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?$/);
      if (!m || !u.searchParams.get('s') || !u.searchParams.get('list')) return json({ error: 'bad request' }, 400);
      if (headers['x-stream-ticket'] !== TICKET) return json({ error: 'Invalid ticket' }, 403);
      const [, kind, id, season, episode] = m;
      if (noStream) return json({ error: 'No stream' }, 404);
      const d = Buffer.from(JSON.stringify(emptyStreams ? [] : streamsFor(kind, id, Number(season || 0), Number(episode || 0)))).toString('base64');
      return json({ n: '0123456789abcdef', d });
    }
    mediaCalls.push({ url: u, referer: headers.referer });
    const alias = u.origin === CDN_A ? ALIAS_A : ALIAS_B;
    if (headers.referer !== alias) return new Response('blocked', { status: 403 });
    const file = u.pathname.split('/').at(-1);
    if (file.endsWith('.png')) return new Response(png);
    if (file === 'master.m3u8') return hls(master(u.pathname.replace(/\/master\.m3u8$/, '')));
    if (file === 'v0.m3u8' || file === 'v1.m3u8') return hls(leaf());
    if (file.endsWith('.ts')) return new Response(ts());
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
}

const withFixtureDeobfuscator = () => {
  setMeowtvDeobfuscator(async (n, d) => JSON.stringify({ streams: JSON.parse(Buffer.from(d, 'base64').toString('utf8')) }));
};
const policy = (enabled = ['meowtv', 'cinejoy']) => () => ({ order: ['meowtv', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('MeowTV key derivation guards the shape of the key material', async () => {
  await assert.rejects(meowtvKey({ p: ['aGVsbG8=', 'd29ybGQ='], env: 'x' }), /build changed/);
  await assert.rejects(meowtvKey({ p: 'nope', env: 'x' }), /build changed/);
  const full = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const p = [0, 8, 16, 24].map(off => full.subarray(off, off + 8).toString('base64'));
  const key = await meowtvKey({ p, env: 'objectobjectstringfunction' });
  assert.equal(key.length, 32);
});

test('MeowTV committed key material assembles the site deobfuscator WASM', async () => {
  const deob = await buildMeowtvDeobfuscator();
  assert.equal(typeof deob, 'function');
});

test('MeowTV movie: resolves the exact TMDB id through the ticketed resolver and validates the CDN master', async () => {
  const fixture = meowtvFetch();
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver(fixture);
    const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'meowtv' });
    assert.equal(result.provider, 'meowtv');
    assert.equal(result.tmdb, 27205);
    assert.equal(result.server, 'meowtv/Hindi');
    assert.equal(result.master, `${CDN_A}/movie/27205/master.m3u8`);
    assert.equal(result.variants[0].width, 1280);
    const ticketCall = fixture.calls.find(c => c.url.pathname === '/streams/ticket');
    assert.equal(ticketCall.method, 'POST');
    assert.equal(ticketCall.headers.origin, SITE_ORIGIN);
    const streamCall = fixture.calls.find(c => c.url.pathname === '/streams/movie/27205');
    assert.equal(streamCall.url.searchParams.get('s'), 'acme');
    assert.equal(streamCall.url.searchParams.get('list'), '1');
    assert.equal(streamCall.headers['x-stream-ticket'], TICKET);
    for (const call of fixture.mediaCalls) assert.equal(call.referer, ALIAS_A);
    assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('/seg1.ts')));
    const before = fixture.calls.length;
    assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'meowtv' })).cached, true);
    assert.equal(fixture.calls.length, before);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV TV: preserves the exact season and episode in the resolver path and result', async () => {
  const fixture = meowtvFetch();
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver(fixture);
    const result = await resolve({ tmdb: 1396, kind: 'series', season: 3, episode: 2, provider: 'meowtv' });
    assert.equal(result.provider, 'meowtv');
    assert.equal(result.season, 3);
    assert.equal(result.episode, 2);
    assert.equal(result.master, `${CDN_A}/tv/1396/3/2/master.m3u8`);
    const streamCall = fixture.calls.find(c => c.url.pathname === '/streams/tv/1396/3/2');
    assert.equal(streamCall.headers['x-stream-ticket'], TICKET);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV TV: season 0 stays season 0 in the path', async () => {
  const fixture = meowtvFetch();
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver(fixture);
    const result = await resolve({ tmdb: 1396, kind: 'series', season: 0, episode: 1, provider: 'meowtv' });
    assert.equal(result.master, `${CDN_A}/tv/1396/0/1/master.m3u8`);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV best-first: a non-HLS language entry is rejected and the next language is served', async () => {
  const fixture = meowtvFetch({ baitFirst: true });
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver(fixture);
    const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'meowtv' });
    assert.equal(result.server, 'meowtv/English');
    assert.equal(result.master, `${CDN_B}/movie/27205/en/master.m3u8`);
    for (const call of fixture.mediaCalls.filter(c => c.url.origin === CDN_B)) assert.equal(call.referer, ALIAS_B);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV 404 "No stream" fails honestly and falls back to the next provider', async () => {
  const fixture = meowtvFetch({ noStream: true });
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
    const result = await resolve({ tmdb: 999999999, kind: 'movie' });
    assert.equal(result.provider, 'cinejoy');
    assert.match(result.provider_errors.meowtv, /no stream for movie 999999999/i);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV empty stream list fails honestly and falls back', async () => {
  const fixture = meowtvFetch({ emptyStreams: true });
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
    const result = await resolve({ tmdb: 27205, kind: 'movie' });
    assert.equal(result.provider, 'cinejoy');
    assert.match(result.provider_errors.meowtv, /no stream for movie 27205/i);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV ticket failure is reported honestly and falls back', async () => {
  const fixture = meowtvFetch({ ticketFail: true });
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
    const result = await resolve({ tmdb: 27205, kind: 'movie' });
    assert.equal(result.provider, 'cinejoy');
    assert.match(result.provider_errors.meowtv, /ticket unavailable/i);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV exclusions skip the provider and a pinned disabled provider is rejected', async () => {
  const fixture = meowtvFetch();
  withFixtureDeobfuscator();
  try {
    const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
    const result = await resolve({ tmdb: 27205, kind: 'movie', exclude: ['meowtv'] });
    assert.equal(result.provider, 'cinejoy');
    assert.equal(fixture.calls.length, 0);
    const disabled = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
    await assert.rejects(disabled({ tmdb: 27205, kind: 'movie', provider: 'meowtv' }), /disabled/);
  } finally {
    setMeowtvDeobfuscator(null);
  }
});

test('MeowTV serves IPTV movie routes through the signed local HLS relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-meowtv-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = meowtvFetch();
    withFixtureDeobfuscator();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['meowtv'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/27205.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.match(master, /RESOLUTION=1280x720/);
    assert.doesNotMatch(master, /meowtv\.ru|meowtv\.example/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXTINF:/);
    assert.doesNotMatch(leaf, /meowtv\.ru|meowtv\.example/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const segment = await (await original(segmentURL)).arrayBuffer();
    const bytes = Buffer.from(segment);
    assert.ok(bytes.length >= 940);
    for (const offset of [0, 188, 376]) assert.equal(bytes[offset], 0x47);
    assert.ok(fixture.mediaCalls.some(c => c.referer === ALIAS_A));
  } finally {
    globalThis.fetch = original;
    setMeowtvDeobfuscator(null);
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
