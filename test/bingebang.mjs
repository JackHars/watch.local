import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderResolver, createProviderContext } from '../api/providers.mjs';
import { createBingebangResolver } from '../api/bingebang.mjs';

// BingeBang (bingebang.sx) fixture: mirrors the verified ticket chain —
// plain JSON movie meta, XOR-encoded play pages (7-byte repeating key in
// the inline IIFE), post-ticket {enc} envelopes keyed by deriveKey(BBKEY,
// ticket), a one-shot iCdn hop to a short-TTL signed master, then an
// m3u8 ladder ending in MPEG-TS segments (0x47 at every 188-byte
// offset). The CDN is hotlink-gated, so every media hop must carry the
// site's Origin/Referer. Tickets are one-shot, so a mismatched identity
// candidate must never spend its ticket.
const BBC = globalThis.BBCrypto;
const KEY = globalThis.__BBKEY;
const SITE = 'https://bingebang.sx';
const CDN = 'https://icdn.bbfixture.test';
const tkt = seed => (seed + 'x'.repeat(167)).slice(0, 167);
const T_MOVIE = tkt('M');
const T_A = tkt('A');
const T_B = tkt('B');
const KEY7 = [1, 2, 3, 4, 5, 6, 7];
function payloadHtml(payload) {
  const text = 'window.__BB_PLAYER__ = ' + JSON.stringify(payload) + ';';
  const d = [...Buffer.from(text, 'utf8')].map((byte, i) => byte ^ KEY7[i % KEY7.length]);
  return `<html><body><script>(function(){var k=[${KEY7.join(',')}],d=[${d.join(',')}];/* site player bootstrap */</script></body></html>`;
}
// Post-ticket API bodies are {"enc":...}; build fixtures with the shipped codec.
function encBody(value, ticket) {
  return { enc: BBC.encrypt(JSON.stringify(value), BBC.deriveKey(KEY, ticket), new Uint8Array(16)) };
}
const MASTER =
  `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.64001e"\n${CDN}/360/index.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64001e"\n${CDN}/1080/index.m3u8\n` +
  `#EXT-X-ENDLIST\n`;
const media = ladder =>
  `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n` +
  [0, 1, 2].map(i => `#EXTINF:3.0,\n${CDN}/${ladder}/seg${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n';
// Plain MPEG-TS: sync byte 0x47 at every 188-byte offset.
const TS = Uint8Array.from({ length: 3 * 188 }, (_, i) => (i % 188 === 0 ? 0x47 : 0));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

const moviePayload = { ticket: T_MOVIE, mediaType: 'movie', mediaId: 550, imdb: 'tt0000001', segmentsTmdb: 999, title: 'Fixture Movie', sourcesUrl: '/api/player/sources' };
const tvPayloadMismatch = { ticket: T_A, mediaType: 'episode', mediaId: 311, imdb: 'tt0000002', segmentsTmdb: 777, season: 1, episode: 1, title: 'Fixture Show (Clone)', sourcesUrl: '/api/player/sources' };
const tvPayloadMatch = { ticket: T_B, mediaType: 'episode', mediaId: 311, imdb: 'tt0000002', segmentsTmdb: 550, season: 1, episode: 1, title: 'Fixture Show', sourcesUrl: '/api/player/sources' };

function bingebangFetch({ moviePayload: mp = null, tvPages = null, sources = null, resolve: ro = null, sources429 = 0, baitSegments = false } = {}) {
  const calls = [];
  const mediaCalls = [];
  let sourcesHits = 0;
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    const headers = {};
    for (const [k, v] of Object.entries(options.headers || {})) headers[String(k).toLowerCase()] = v;
    calls.push({ url: u, headers });
    if (u.hostname === 'bingebang.sx') {
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      const html = (text) => new Response(text, { headers: { 'content-type': 'text/html' } });
      if (u.pathname === '/api/movie/550') return json({ id: 550, media_type: 'movie', title: 'Fixture Movie', play_url: '/movie/play/fx-movie' });
      if (u.pathname === '/movie/play/fx-movie') return html(payloadHtml(mp || moviePayload));
      if (u.pathname === '/api/search/multi') return json({ results: [
        { id: 9001, media_type: 'movie', name: 'Fixture Show Movie', play_url: '/movie/play/fx-movie-decoy' },
        { id: 9002, media_type: 'tv', name: 'Fixture Show (Clone)', play_url: '/tv/play/fx-a' },
        { id: 9003, media_type: 'tv', name: 'Fixture Show', play_url: '/tv/play/fx-b' },
      ] });
      if (tvPages && u.pathname in tvPages) return html(payloadHtml(tvPages[u.pathname]));
      if (u.pathname === '/tv/play/fx-a/1/1') return html(payloadHtml(tvPayloadMismatch));
      if (u.pathname === '/tv/play/fx-b/1/1') return html(payloadHtml(tvPayloadMatch));
      if (u.pathname === '/api/player/sources') {
        sourcesHits += 1;
        if (sourcesHits <= sources429) return new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } });
        assert.equal(headers['x-bb-player'], '1', 'sources must carry the player header');
        assert.ok(headers['x-bb-ticket'], 'sources must carry the one-shot ticket');
        return json(sources || encBody({
          ok: true,
          servers: [{ name: 'one', source_url: `${CDN}/top-1` }, { name: 'two', source_url: `${CDN}/top-2` }],
        }, headers['x-bb-ticket']));
      }
      if (u.pathname === '/api/player/resolve') {
        assert.equal(headers['x-bb-player'], '1');
        assert.ok(headers['x-bb-ticket']);
        if (ro) return json(ro(u, headers['x-bb-ticket']));
        return json(encBody({ ok: true, url: `${CDN}/top-1`, type: 'hls' }, headers['x-bb-ticket']));
      }
      return json({ ok: false, error: 'not found' }, 404);
    }
    if (u.hostname === 'icdn.bbfixture.test') {
      mediaCalls.push({ url: u, origin: headers['origin'], referer: headers['referer'] });
      if (u.pathname === '/top-1' || u.pathname === '/top-2') {
        // One-shot hop: emulate the 302 landing on the short-TTL signed master
        // by returning the master body with the landed URL as response.url.
        const signed = `${CDN}/signed${u.pathname.slice(1)}/index.m3u8?sig=fixture`;
        return { ok: true, status: 200, url: signed, body: new Response(MASTER, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }).body };
      }
      if (u.pathname === '/signedtop-1/index.m3u8' || u.pathname === '/signedtop-2/index.m3u8') {
        // The relay refetches the short-TTL signed master from scratch.
        assert.equal(headers['origin'], SITE, 'the relay must carry the provider origin upstream');
        assert.equal(headers['referer'], `${SITE}/`, 'the relay must carry the provider referer upstream');
        return new Response(MASTER, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (/(360|1080)\/index\.m3u8$/.test(u.pathname)) {
        assert.equal(headers['origin'], SITE, 'media hops must carry the site origin');
        assert.equal(headers['referer'], `${SITE}/`, 'media hops must carry the site referer');
        return new Response(media(u.pathname.match(/\/(360|1080)\//)[1]), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (/(360|1080)\/seg\d\.ts$/.test(u.pathname)) {
        assert.equal(headers['origin'], SITE);
        assert.equal(headers['referer'], `${SITE}/`);
        if (baitSegments) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        return new Response(TS, { headers: { 'content-type': 'video/mp2t' } });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls, sourcesHits: () => sourcesHits };
}

const policy = (enabled = ['bingebang', 'cinejoy']) => () => ({ order: ['bingebang', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });
const catalogStub = async path => path === '/tv/550' ? { name: 'Fixture Show' } : Promise.reject(new Error('no catalog item'));
const directCtx = (fetchResource, timeoutMs = 30000) => createProviderContext({ signal: AbortSignal.timeout(timeoutMs), fetchResource });

test('BingeBang shipped crypto: ticket-derived key encrypt/decrypt roundtrip', () => {
  const key = BBC.deriveKey(KEY, T_MOVIE);
  assert.equal(key.length, 32);
  const plain = JSON.stringify({ ok: true, servers: [{ name: 'one', source_url: `${CDN}/top-1` }] });
  const encoded = BBC.encrypt(plain, key, new Uint8Array(16));
  assert.equal(typeof encoded, 'string');
  assert.equal(BBC.decrypt(encoded, key), plain);
  assert.notEqual(BBC.decrypt(encoded, BBC.deriveKey(KEY, T_A)), plain, 'a different ticket must not decrypt the envelope');
});

test('BingeBang movie: TMDB meta -> XOR play page -> ticketed sources/resolve -> signed master; cached then fresh', async () => {
  const fixture = bingebangFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 550, kind: 'movie', provider: 'bingebang' });
  assert.equal(result.provider, 'bingebang');
  assert.equal(result.tmdb, 550);
  assert.equal(result.kind, 'movie');
  assert.equal(result.season, null);
  assert.equal(result.episode, null);
  assert.equal(result.server, 'one');
  assert.match(result.master, /^https:\/\/icdn\.bbfixture\.test\/signedtop-1\/index\.m3u8\?sig=fixture/);
  assert.equal(result.variants[0].width, 1920);
  assert.equal(result.cached, false);
  const play = fixture.calls.find(c => c.url.pathname === '/movie/play/fx-movie');
  assert.equal(play.headers['x-bb-ticket'], undefined, 'the play page is fetched pre-ticket');
  const sources = fixture.calls.filter(c => c.url.pathname === '/api/player/sources');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].headers['x-bb-ticket'], T_MOVIE);
  for (const c of fixture.mediaCalls) {
    assert.equal(c.origin, SITE);
    assert.equal(c.referer, `${SITE}/`);
  }

  const before = fixture.calls.length;
  const again = await resolve({ tmdb: 550, kind: 'movie', provider: 'bingebang' });
  assert.equal(again.cached, true);
  assert.equal(again.master, result.master);
  assert.equal(fixture.calls.length, before, 'a cached hit must not refetch upstream');

  const fresh = await resolve({ tmdb: 550, kind: 'movie', provider: 'bingebang', fresh: true });
  assert.equal(fresh.cached, false);
  assert.ok(fixture.calls.length > before, 'fresh forces an upstream revalidation');
});

test('BingeBang series: catalog title -> search candidates -> identity gate on segmentsTmdb (clone skipped, exact S/E matched, ticket spent once)', async () => {
  const fixture = bingebangFetch();
  const resolver = createBingebangResolver(catalogStub);
  const result = await resolver({ tmdb: 550, kind: 'series', season: 1, episode: 1 }, directCtx(fixture.fetchResource));
  assert.match(result.master, /signedtop-1/);
  assert.ok(fixture.calls.some(c => c.url.pathname === '/api/search/multi'), 'the site search finds the title');
  const playPages = fixture.calls.filter(c => c.url.pathname.startsWith('/tv/play/')).map(c => c.url.pathname);
  assert.deepEqual(playPages, ['/tv/play/fx-a/1/1', '/tv/play/fx-b/1/1'], 'candidates are walked in order');
  const sources = fixture.calls.filter(c => c.url.pathname === '/api/player/sources');
  assert.equal(sources.length, 1, 'the one-shot ticket is spent only for the identity-matched episode');
  assert.equal(sources[0].headers['x-bb-ticket'], T_B, 'the ticket comes from the matching payload');
  assert.ok(!fixture.calls.some(c => c.headers['x-bb-ticket'] === T_A), 'a mismatched candidate ticket is never spent');
});

test('BingeBang series is wired to the shared catalog in the integrated resolver', async () => {
  const fixture = bingebangFetch();
  const resolve = createProviderResolver({ ...fixture, getCatalogData: catalogStub, cinejoy: cinejoyStub(), getPolicy: policy(['bingebang']) });
  const result = await resolve({ tmdb: 550, kind: 'series', season: 1, episode: 1, provider: 'bingebang' });
  assert.equal(result.provider, 'bingebang');
  assert.match(result.master, /signedtop-1/);
});

test('BingeBang series: every candidate identity-mismatched rejects without spending any ticket', async () => {
  const fake = { ticket: T_B, mediaType: 'episode', mediaId: 311, imdb: 'tt0000002', segmentsTmdb: 777, season: 1, episode: 1, title: 'Fixture Show (Clone)', sourcesUrl: '/api/player/sources' };
  const fixture = bingebangFetch({ tvPages: { '/tv/play/fx-a/1/1': fake, '/tv/play/fx-b/1/1': { ...fake, segmentsTmdb: 888 } } });
  const resolver = createBingebangResolver(catalogStub);
  await assert.rejects(
    resolver({ tmdb: 550, kind: 'series', season: 1, episode: 1 }, directCtx(fixture.fetchResource)),
    /identity mismatch/,
  );
  assert.equal(fixture.calls.filter(c => c.url.pathname === '/api/player/sources').length, 0, 'no ticket spend when no candidate matches');
});

test('BingeBang movie: a different mediaId rejects before the ticket chain', async () => {
  const fixture = bingebangFetch({ moviePayload: { ...moviePayload, mediaId: 999 } });
  const resolver = createBingebangResolver(catalogStub);
  await assert.rejects(
    resolver({ tmdb: 550, kind: 'movie' }, directCtx(fixture.fetchResource)),
    /different movie/,
  );
  assert.equal(fixture.calls.filter(c => c.url.pathname === '/api/player/sources').length, 0, 'no ticket spend on a mismatched identity');
});

test('BingeBang server failover: a dead pool entry falls through to the next', async () => {
  const fixture = bingebangFetch({
    resolve: (u, ticket) => (u.searchParams.get('src') === `${CDN}/top-1`
      ? encBody({ ok: false, error: 'source offline' }, ticket)
      : encBody({ ok: true, url: `${CDN}/top-2`, type: 'hls' }, ticket)),
  });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 550, kind: 'movie', provider: 'bingebang' });
  assert.equal(result.server, 'two', 'the second pool entry serves the ladder');
  assert.match(result.master, /signedtop-2/);
  assert.equal(fixture.calls.filter(c => c.url.pathname === '/api/player/resolve').length, 2, 'both pool entries were asked');
});

test('BingeBang baited segments: provider fails and falls back to the next enabled provider', async () => {
  const fixture = bingebangFetch({ baitSegments: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.bingebang, /not.*video|bait/i);
  await assert.rejects(resolve({ tmdb: 550, kind: 'movie', provider: 'bingebang' }), /playable/);
});

test('BingeBang 429: one bounded backoff then recovery', async () => {
  const fixture = bingebangFetch({ sources429: 2 });
  const resolver = createBingebangResolver(catalogStub, { rateLimitDelayMs: 25 });
  const result = await resolver({ tmdb: 550, kind: 'movie' }, directCtx(fixture.fetchResource));
  assert.match(result.master, /signedtop-1/);
  assert.equal(fixture.sourcesHits(), 3, 'central retry, then one adapter backoff, then success');
});

test('BingeBang 429: a sustained rate-limit fails fast instead of hammering the edge', async () => {
  const fixture = bingebangFetch({ sources429: 100 });
  const resolver = createBingebangResolver(catalogStub, { rateLimitDelayMs: 25 });
  await assert.rejects(
    resolver({ tmdb: 550, kind: 'movie' }, directCtx(fixture.fetchResource)),
    /rate-limited/,
  );
  assert.equal(fixture.sourcesHits(), 4, 'two attempts of two reads each, then stop');
});

test('BingeBang serves the IPTV movie route through the signed local relay with MPEG-TS segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-bingebang-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = bingebangFetch();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['bingebang'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/550.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /icdn|bingebang/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXTINF:/);
    assert.doesNotMatch(leaf, /icdn|bingebang/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const bytes = Buffer.from(await (await original(segmentURL)).arrayBuffer());
    assert.equal(bytes[0], 0x47);
    assert.equal(bytes[188], 0x47);
    assert.equal(bytes[376], 0x47);
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
