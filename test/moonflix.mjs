import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderResolver } from '../api/providers.mjs';

// Moonflix (moonflix.website) fixture: mirrors the verified live contract —
// a keyless GET /api/stream on the operator's Render apps, keyed by the exact
// requested TMDB id (movies add type=movie, series add s/e), answering
// { available, sources, scraperName, _meta } on the primary app and
// { m3u8, available } on the backup app, followed by unencrypted HLS on the
// Rousav CDN family whose segment files are named .jpg/.png. No cookies,
// tokens, or DRM exist on the verified chain; 404 means the title is absent
// from the operator's DB and the response never echoes the requested id.
// All hosts are .test placeholders.
const SITE = 'https://moonflix.website';
const TV_CDN = 'https://gzip.rousav-fixture.test';
const MV_CDN = 'https://img.rousav-fixture.test';
// Plain MPEG-TS: sync byte 0x47 at every 188-byte offset.
const TS = Uint8Array.from({ length: 3 * 188 }, (_, i) => (i % 188 === 0 ? 0x47 : 0));
// Bait: a real PNG (a segment shape some CDN families serve instead of TS).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML = '<html><body>Error</body></html>';

const master = (dir) =>
  '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.64001e"\n${dir}/360.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64001e"\n${dir}/1080.m3u8\n` +
  '#EXT-X-ENDLIST\n';
const leaf = (dir) =>
  '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  `#EXTINF:3.0,\n${dir}/00000.jpg\n` +
  `#EXTINF:3.0,\n${dir}/00001.png\n` +
  '#EXT-X-ENDLIST\n';
const jsonBody = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// Per-test controls:
//   primary: { status?, available?, sources?, scraperName?, meta?, rate429? }
//   backup:  { status?, available?, m3u8? }
//   segment: 'ts' | 'png' | 'html' (what the leaf segment paths serve)
//   mediaStatus: pathname -> HTTP status override for CDN paths
//   expect:    { tmdb, type?, s?, e? } query params the API must see
function moonflixFetch({ primary = {}, backup = {}, segment = 'ts', mediaStatus = {}, expect = {} } = {}) {
  const apiCalls = [];
  const mediaCalls = [];
  let primaryHits = 0;
  let backupHits = 0;
  const fetchResource = async (value, options = {}) => {
    const u = new URL(value);
    const headers = {};
    for (const [k, v] of Object.entries(options.headers || {})) headers[String(k).toLowerCase()] = v;
    if (u.hostname === 'filmu-1.onrender.com' && u.pathname === '/api/stream') {
      if (expect.tmdb !== undefined) assert.equal(u.searchParams.get('tmdb'), String(expect.tmdb), 'the primary API must see the exact TMDB key');
      if (expect.type) assert.equal(u.searchParams.get('type'), expect.type, 'movie requests carry the type flag');
      if (expect.s !== undefined) assert.equal(u.searchParams.get('s'), String(expect.s), 'series requests carry the season key');
      if (expect.e !== undefined) assert.equal(u.searchParams.get('e'), String(expect.e), 'series requests carry the episode key');
      assert.match(String(headers['user-agent'] || ''), /Mozilla\/5\.0/, 'the API hop must carry a browser user agent');
      apiCalls.push({ host: 'primary', u, headers });
      primaryHits += 1;
      if (primary.rate429 && primaryHits <= primary.rate429) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      if (primary.status) return jsonBody({ available: false, error: 'Not available', message: 'This movie / episode is not available on this server.' }, primary.status);
      if (primary.available === false) return jsonBody({ available: false, error: 'Not available', message: 'This movie / episode is not available on this server.' });
      const tmdb = Number(u.searchParams.get('tmdb'));
      const series = u.searchParams.get('s') !== null;
      const dir = series
        ? `${TV_CDN}/tv/${tmdb}/${u.searchParams.get('s')}/${u.searchParams.get('e')}`
        : `${MV_CDN}/media/${tmdb}`;
      return jsonBody({
        available: true,
        scraperName: primary.scraperName ?? 'DarkMatter',
        subtitles: [],
        sources: primary.sources ?? [{ name: '1080p', quality: '1080p', headers: {}, url: `${dir}/index.m3u8` }],
        _meta: primary.meta ?? { source: 'database-stale', stale: false },
      });
    }
    if (u.hostname === 'vidzy-0aej.onrender.com' && u.pathname === '/api/stream') {
      apiCalls.push({ host: 'backup', u, headers });
      backupHits += 1;
      if (backup.status) return jsonBody({ available: false, error: 'Not available' }, backup.status);
      if (backup.available === false) return jsonBody({ available: false });
      const tmdb = Number(u.searchParams.get('tmdb'));
      return jsonBody({ m3u8: backup.m3u8 ?? `${MV_CDN}/media/${tmdb}/index.m3u8`, available: true, _cached: true });
    }
    if (u.hostname === 'gzip.rousav-fixture.test' || u.hostname === 'img.rousav-fixture.test') {
      mediaCalls.push({ u, headers });
      if (mediaStatus[u.pathname] !== undefined) return new Response('blocked', { status: mediaStatus[u.pathname] });
      const parts = u.pathname.split('/');
      const file = parts[parts.length - 1];
      if (file === 'index.m3u8') return new Response(master(`${u.origin}${u.pathname.replace('/index.m3u8', '')}`), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      if (/^\d+m?\.m3u8$/.test(file)) return new Response(leaf(`${u.origin}/${parts.slice(1, -1).join('/')}`), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      if (file.endsWith('.jpg') || file.endsWith('.png')) {
        if (segment === 'png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        if (segment === 'html') return new Response(HTML, { headers: { 'content-type': 'text/html' } });
        return new Response(TS, { headers: { 'content-type': 'video/mp2t' } });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, apiCalls, mediaCalls, primaryHits: () => primaryHits, backupHits: () => backupHits };
};

const policy = () => () => ({ order: ['moonflix', 'cinejoy'], enabled: ['moonflix', 'cinejoy'], providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });
// The settings store is a process singleton pinned to its data directory at
// first import, so both IPTV tests share one directory (created here, removed
// by the last test).
let iptvDirectory = null;
const ensureIptvDirectory = async () => {
  if (!iptvDirectory) {
    iptvDirectory = await mkdtemp(join(tmpdir(), 'watchlocal-moonflix-iptv-'));
    process.env.WATCHLOCAL_DATA_DIR = iptvDirectory;
  }
  return iptvDirectory;
};

test('movie: the keyless API resolves the Rousav master chain; cached then fresh', async () => {
  const fixture = moonflixFetch({ expect: { tmdb: 550, type: 'movie' } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource });
  const out = await resolve({ tmdb: 550, kind: 'movie', provider: 'moonflix' });
  assert.equal(out.provider, 'moonflix');
  assert.equal(out.tmdb, 550);
  assert.equal(out.kind, 'movie');
  assert.equal(out.master, `${MV_CDN}/media/550/index.m3u8`);
  assert.ok(out.variants.length >= 2, 'the two-variant master is parsed');
  assert.equal(out.variants[0].width, 1920, 'variants are bandwidth-sorted');
  for (const c of fixture.mediaCalls) {
    assert.ok(String(c.headers['user-agent']).startsWith('Mozilla'), 'media hops carry a browser UA');
    // The TV CDN (gzip.rousav.tech) 403s leaf/segment requests that carry the
    // site Referer/Origin, so media hops must send the UA only.
    assert.equal(c.headers.referer, undefined, 'media hops must not carry the site referer');
    assert.equal(c.headers.origin, undefined, 'media hops must not carry the site origin');
  }

  const again = await resolve({ tmdb: 550, kind: 'movie', provider: 'moonflix' });
  assert.equal(again.cached, true);
  assert.equal(again.master, out.master);
  assert.equal(fixture.primaryHits(), 1, 'a cached hit must not refetch the API');

  const fresh = await resolve({ tmdb: 550, kind: 'movie', provider: 'moonflix', fresh: true });
  assert.equal(fresh.cached, false);
  assert.equal(fixture.primaryHits(), 2, 'fresh forces an upstream revalidation');
});

test('series: the exact season/episode keying keeps the requested identity (no echo to trust)', async () => {
  const fixture = moonflixFetch({ expect: { tmdb: 1396, s: 1, e: 1 } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource });
  const out = await resolve({ tmdb: 1396, kind: 'series', season: 1, episode: 1, provider: 'moonflix' });
  assert.equal(out.provider, 'moonflix');
  assert.equal(out.tmdb, 1396);
  assert.equal(out.season, 1);
  assert.equal(out.episode, 1);
  assert.equal(out.master, `${TV_CDN}/tv/1396/1/1/index.m3u8`);
  const api = fixture.apiCalls.find(c => c.host === 'primary');
  assert.equal(api.u.searchParams.get('tmdb'), '1396');
  assert.equal(api.u.searchParams.get('s'), '1');
  assert.equal(api.u.searchParams.get('e'), '1');
  assert.equal(api.u.searchParams.get('type'), null, 'series queries never send the movie type flag');
});

test('failover: a dead first source is skipped and the next source serves', async () => {
  const fixture = moonflixFetch({
    expect: { tmdb: 550, type: 'movie' },
    primary: { sources: [
      { name: '360p', quality: '360p', headers: {}, url: `${MV_CDN}/media/550/dead/index.m3u8` },
      { name: '1080p', quality: '1080p', headers: {}, url: `${MV_CDN}/media/550/index.m3u8` },
    ] },
    mediaStatus: { '/media/550/dead/index.m3u8': 403 },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'moonflix');
  assert.equal(out.master, `${MV_CDN}/media/550/index.m3u8`);
  assert.match(out.server, /1080p/);
  assert.equal(fixture.backupHits(), 0, 'a working primary source must not reach the backup app');
});

test('all sources dead: the backup is dead too, so the next enabled provider serves', async () => {
  const fixture = moonflixFetch({
    expect: { tmdb: 550, type: 'movie' },
    primary: { sources: [
      { name: '360p', quality: '360p', headers: {}, url: `${MV_CDN}/media/550/a/index.m3u8` },
      { name: '1080p', quality: '1080p', headers: {}, url: `${MV_CDN}/media/550/b/index.m3u8` },
    ] },
    mediaStatus: { '/media/550/a/index.m3u8': 403, '/media/550/b/index.m3u8': 503 },
    backup: { status: 404 },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moonflix, /no playable source/i);
  await assert.rejects(resolve({ tmdb: 550, kind: 'movie', provider: 'moonflix' }), /playable/);
});

test('unavailable: a 404 title and an unavailable backup fail cleanly without substitution', async () => {
  const fixture = moonflixFetch({
    expect: { tmdb: 999999, type: 'movie' },
    primary: { status: 404 },
    backup: { available: false },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 999999, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moonflix, /HTTP 404/);
  assert.equal(fixture.mediaCalls.length, 0, "an unavailable title must never serve another title's bytes");
});

test('primary down: the backup app m3u8 serves when it validates', async () => {
  const fixture = moonflixFetch({
    expect: { tmdb: 777, type: 'movie' },
    primary: { status: 503 },
    backup: { m3u8: `${MV_CDN}/media/777/index.m3u8` },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource });
  const out = await resolve({ tmdb: 777, kind: 'movie', provider: 'moonflix' });
  assert.equal(out.provider, 'moonflix');
  assert.equal(out.master, `${MV_CDN}/media/777/index.m3u8`);
  assert.match(out.server, /backup/i);
  assert.equal(fixture.backupHits(), 1);
});

test('api: a 429 on the primary API gets one bounded backoff, then resolves', async () => {
  const fixture = moonflixFetch({ expect: { tmdb: 550, type: 'movie' }, primary: { rate429: 1 } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie', provider: 'moonflix' });
  assert.equal(out.provider, 'moonflix');
  assert.equal(fixture.primaryHits(), 2, 'one bounded retry, then the stream entry');
});

test('bait: an HTML segment fails media validation and the next provider serves', async () => {
  const fixture = moonflixFetch({
    expect: { tmdb: 550, type: 'movie' },
    segment: 'html',
    backup: { available: false },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moonflix, /not video|baited/i);
});

test('iptv: the two-level HLS chain is relayed as signed local assets and segment bytes play', async () => {
  const directory = await ensureIptvDirectory();
  const original = globalThis.fetch;
  let server;
  try {
    const fixture = moonflixFetch({
      expect: { tmdb: 777, type: 'movie' },
      primary: { sources: [{ name: '1080p', quality: '1080p', headers: {}, url: `${MV_CDN}/media/777/index.m3u8` }] },
    });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['moonflix'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    // tmdb 777: a fresh key, so this test resolves from the fixture instead
    // of any cache populated by the resolver tests above.
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/777.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /rousav|moonflix|onrender/i, 'no upstream host may appear in the rewritten master');
    const variantURL = master.split('\n').find(line => line.startsWith('http'));
    assert.ok(variantURL, 'the rewritten master exposes a local variant');
    const variant = await original(variantURL);
    assert.equal(variant.status, 200);
    const variantText = await variant.text();
    assert.doesNotMatch(variantText, /rousav|moonflix|onrender/i, 'no upstream host may appear in the rewritten variant');
    const segmentURL = variantText.split('\n').find(line => line.startsWith('http'));
    assert.ok(segmentURL, 'the rewritten variant exposes a local segment');
    const segment = await original(segmentURL);
    assert.equal(segment.status, 200);
    const bytes = Buffer.from(await segment.arrayBuffer());
    assert.equal(bytes[0], 0x47, 'segment bytes are MPEG-TS, not HTML or a redirect');
    assert.equal(bytes[188], 0x47);
    assert.equal(bytes[376], 0x47);
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    // The shared IPTV directory is removed by the last test in the file.
  }
});

test('iptv: when the primary app 404s, the backup chain is relayed through the same signed assets', async () => {
  const directory = await ensureIptvDirectory();
  const original = globalThis.fetch;
  let server;
  try {
    const fixture = moonflixFetch({
      expect: { tmdb: 888, type: 'movie' },
      primary: { status: 404 },
      backup: { m3u8: `${MV_CDN}/media/888/index.m3u8` },
    });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['moonflix'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    // tmdb 888: a fresh key (777 was the primary-chain IPTV test).
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/888.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /rousav|moonflix|onrender/i, 'no upstream host may appear in the rewritten master');
    const variantURL = master.split('\n').find(line => line.startsWith('http'));
    assert.ok(variantURL, 'the rewritten master exposes a local variant');
    const variant = await original(variantURL);
    assert.equal(variant.status, 200);
    const variantText = await variant.text();
    const segmentURL = variantText.split('\n').find(line => line.startsWith('http'));
    assert.ok(segmentURL, 'the rewritten variant exposes a local segment');
    const segment = await original(segmentURL);
    assert.equal(segment.status, 200);
    const bytes = Buffer.from(await segment.arrayBuffer());
    assert.equal(bytes[0], 0x47, 'segment bytes are MPEG-TS, not HTML or a redirect');
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
    iptvDirectory = null;
  }
});
