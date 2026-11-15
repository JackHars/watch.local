import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';

const SCRAPER = 'scrapper.rivestream.app';
const REF = 'https://www.rivestream.app/';
const HOSTS = { a: 'cdn.rive-a.test', b: 'cdn.rive-b.test', c: 'img.rive-c.test' };

// Deterministic, time-independent media fixtures: no signed URLs.
const ts = Buffer.alloc(188 * 4);
for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\nleaf.m3u8\n';
const leaf = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n';

// Bounded mirror catalog for the fixtures: the live-verified mirrors first
// (integration evidence, 2026-11-14), then mirrors that answer empty.
const SOURCES = {
  primevids: {
    movie: [{ quality: 'dcloud', host: 'a', dir: 'm' }],
    series: [
      { quality: 'tcloud', host: 'a', dir: 'e1' },
      { quality: 'dcloud', host: 'a', dir: 'e2' },
      { quality: 'ipcloud', host: 'a', dir: 'e3' },
    ],
  },
  citadel: {
    movie: [{ quality: '720p | English', host: 'c', dir: 'm' }],
    series: [{ quality: '720p | Hindi', host: 'c', dir: 'e1' }],
  },
  valiant: {
    movie: [
      { quality: '1080p', host: 'b', dir: 'm1' },
      { quality: '720p', host: 'b', dir: 'm2' },
      { quality: '480p', host: 'b', dir: 'm3' },
    ],
    series: [
      { quality: '1080p', host: 'b', dir: 'e1' },
      { quality: '720p', host: 'b', dir: 'e2' },
      { quality: '480p', host: 'b', dir: 'e3' },
    ],
  },
};

function riveFetch(flags = {}) {
  const calls = [];
  const mediaCalls = [];
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    const headers = options.headers || {};
    calls.push({ url: u, headers });
    if (u.hostname === SCRAPER) {
      const upstream = u.searchParams.get('provider');
      const kind = u.searchParams.has('season') ? 'series' : 'movie';
      const season = kind === 'series' ? Number(u.searchParams.get('season')) : null;
      let sources = SOURCES[upstream]?.[kind] ?? [];
      // Season 0 and the failure flags return no sources, exactly like the
      // live scrapper does for unavailable titles and for S0E1.
      if (season === 0 || flags.allEmpty || (flags.firstUpstreamEmpty && upstream === 'primevids')) sources = [];
      if (flags.baitFirst && upstream === 'primevids' && kind === 'series' && season !== 0) {
        sources = sources.map((s, i) => (i === 0 ? { ...s, dir: 'bait' } : s));
      }
      return json({
        data: {
          title: kind === 'series' ? 'Breaking Bad' : 'Inception',
          sources: sources.map(s => ({ quality: s.quality, format: 'hls', url: `https://${HOSTS[s.host]}/${s.dir}/master.m3u8` })),
        },
      });
    }
    if (Object.values(HOSTS).includes(u.hostname)) {
      mediaCalls.push({ url: u, referer: headers.referer, ua: headers['user-agent'] });
      // Bait: an image served where a playlist is expected.
      if (u.pathname.startsWith('/bait')) return new Response(Buffer.from('89504e470d0a1a0a0000000004', 'hex'));
      if (u.pathname.endsWith('master.m3u8')) return new Response(master, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      if (u.pathname.endsWith('leaf.m3u8')) return new Response(leaf, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      if (u.pathname.endsWith('seg.ts')) return new Response(ts);
      if (u.pathname.endsWith('low.m3u8')) throw new Error('Wrong rendition selected');
      return new Response('No media', { status: 404 });
    }
    return new Response('Unknown fixture host', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
}

const cinejoyStub = () => async input => ({ master: 'https://cinejoy.test/master.m3u8', variants: [], streams: [], server: 'fixture-cinejoy', ...input });
const rivePolicy = (enabled = ['rive', 'cinejoy']) => () => ({ order: ['rive', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });

test('Rive movie: resolves the exact requested TMDB id and sends the site referer on media', async () => {
  const fixture = riveFetch();
  const result = await createProviderResolver(fixture)({ tmdb: 27205, kind: 'movie', provider: 'rive' });
  assert.equal(result.provider, 'rive');
  assert.equal(result.tmdb, 27205);
  assert.equal(result.kind, 'movie');
  assert.equal(result.server, 'primevids/dcloud');
  const query = fixture.calls.find(c => c.url.hostname === SCRAPER);
  assert.equal(query.url.searchParams.get('id'), '27205');
  assert.equal(query.url.searchParams.get('provider'), 'primevids');
  assert.equal(query.url.searchParams.get('season'), null);
  assert.ok(fixture.mediaCalls.length > 0);
  for (const call of fixture.mediaCalls) {
    assert.equal(call.referer, REF);
    assert.match(call.ua, /Chrome/);
  }
});

test('Rive series: preserves season and episode identity in the upstream query', async () => {
  const fixture = riveFetch();
  const result = await createProviderResolver(fixture)({ tmdb: 1396, kind: 'series', season: 1, episode: 1, provider: 'rive' });
  assert.equal(result.tmdb, 1396);
  assert.equal(result.kind, 'series');
  assert.equal(result.season, 1);
  assert.equal(result.episode, 1);
  const query = fixture.calls.find(c => c.url.hostname === SCRAPER);
  assert.equal(query.url.searchParams.get('id'), '1396');
  assert.equal(query.url.searchParams.get('season'), '1');
  assert.equal(query.url.searchParams.get('episode'), '1');
});

test('Rive season 0: keeps season 0 in the query and falls back honestly when mirrors have no sources', async () => {
  const fixture = riveFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: rivePolicy() });
  const result = await resolve({ tmdb: 1396, kind: 'series', season: 0, episode: 1 });
  assert.equal(result.provider, 'cinejoy');
  assert.deepEqual(result.provider_order, ['rive', 'cinejoy']);
  assert.match(result.provider_errors.rive, /no playable source/);
  const queries = fixture.calls.filter(c => c.url.hostname === SCRAPER);
  assert.ok(queries.length > 0);
  for (const query of queries) {
    assert.equal(query.url.searchParams.get('season'), '0');
    assert.equal(query.url.searchParams.get('episode'), '1');
  }
});

test('Rive candidate fallback: rejects an image-bait rendition and accepts the next mirror source', async () => {
  const fixture = riveFetch({ baitFirst: true });
  const result = await createProviderResolver(fixture)({ tmdb: 1396, kind: 'series', season: 1, episode: 1, provider: 'rive' });
  assert.equal(result.server, 'primevids/dcloud');
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.startsWith('/bait')), 'the bait playlist was requested before being rejected');
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname === '/e2/leaf.m3u8'), 'the accepted source resolved to its leaf');
});

test('Rive upstream fallback: moves to the next mirror when the first has no sources', async () => {
  const fixture = riveFetch({ firstUpstreamEmpty: true });
  const result = await createProviderResolver(fixture)({ tmdb: 27205, kind: 'movie', provider: 'rive' });
  assert.equal(result.server, 'citadel/720p');
  const queries = fixture.calls.filter(c => c.url.hostname === SCRAPER);
  assert.ok(queries.some(q => q.url.searchParams.get('provider') === 'citadel'));
});

test('Rive participates in configured provider fallback and honors exclusions', async () => {
  const fixture = riveFetch({ allEmpty: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: rivePolicy() });
  const result = await resolve({ tmdb: 27205, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.deepEqual(result.provider_order, ['rive', 'cinejoy']);
  assert.match(result.provider_errors.rive, /no playable source/);
  const before = fixture.calls.length;
  await resolve({ tmdb: 27205, kind: 'movie', exclude: ['rive'], fresh: true });
  assert.equal(fixture.calls.length, before, 'an excluded provider must not be retried on fresh');
});

test('Rive pinned provider is rejected as disabled, not silently substituted', async () => {
  const fixture = riveFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: rivePolicy(['cinejoy']) });
  await assert.rejects(resolve({ tmdb: 27205, kind: 'movie', provider: 'rive' }), /disabled/);
});

test('Rive caches a verified source and re-resolves on fresh', async () => {
  const fixture = riveFetch();
  const resolve = createProviderResolver(fixture);
  assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'rive' })).cached, false);
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'rive' })).cached, true);
  assert.equal(fixture.calls.length, before);
  assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'rive', fresh: true })).cached, false);
  assert.ok(fixture.calls.length > before);
});

test('Rive serves IPTV movie routes through the signed local HLS relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-rive-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = riveFetch();
    globalThis.fetch = (url, options) => {
      const target = new URL(url);
      return target.hostname === '127.0.0.1' || target.hostname === 'localhost'
        ? original(url, options)
        : fixture.fetchResource(url, options);
    };
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({
      sportsDirectory: directory,
      zliveSource: { list: async () => [] },
      timstreamsSource: { list: async () => [] },
    });
    await settingsStore.configure({ playback: { enabled: ['rive'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/27205.m3u8`);
    assert.equal(response.status, 200);
    const masterText = await response.text();
    assert.match(masterText, /^#EXTM3U/);
    assert.match(masterText, /RESOLUTION=1920x1080/);
    assert.doesNotMatch(masterText, /rivestream\.app|rive-a\.test|rive-b\.test|rive-c\.test/);
    const leafURL = masterText.split('\n').find(line => line.startsWith('http'));
    assert.ok(leafURL);
    const leafText = await (await original(leafURL)).text();
    assert.match(leafText, /^#EXTM3U/);
    assert.doesNotMatch(leafText, /rivestream\.app|rive-a\.test|rive-b\.test|rive-c\.test/);
    const segmentURL = leafText.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    assert.ok(segmentURL);
    const segment = await (await original(segmentURL)).arrayBuffer();
    assert.equal(segment.byteLength, ts.length);
    assert.ok(fixture.mediaCalls.some(c => c.referer === REF));
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
