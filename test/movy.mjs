import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';
import { movyKeystream, decryptMovyPayload } from '../api/movy.mjs';

const API = 'https://api.wecollege.net';
const DB = 'https://db.wecollege.net';
const MEDIA_HOSTS = ['https://moon.goldenkite.top', 'https://nobleoffer.top', 'https://southdesk.top'];

// Build a Movy sources payload exactly as the live API does: "mov1" magic,
// XOR-encrypted with the seed/TMDB-id keystream, base64url-encoded.
function movyPayload(json, seed, mediaId) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const out = Buffer.alloc(4 + body.length);
  out.set([109, 118, 109, 49], 0); // "mov1"
  out.set(body, 4);
  const keystream = movyKeystream(seed, mediaId, out.length);
  for (let i = 0; i < out.length; i++) out[i] ^= keystream[i];
  return out.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const MOVIE_DETAIL = { id: 9384, original_title: 'Starsky & Hutch', title: 'Starsky & Hutch', release_date: '2004-03-05', imdb_id: 'tt0335438' };
const SERIES_DETAIL = { id: 63333, original_name: 'The Last Kingdom', name: 'The Last Kingdom', first_air_date: '2015-10-10', number_of_seasons: 5, imdb_id: 'tt3650652' };

// Deterministic upstream: db.wecollege.net metadata, the seed/sources API,
// and time-independent CDN playlists/segments (no signed URLs in fixtures).
function movyFetch({ brokenFirst = false, noSources = false, wrongDetailId = false, rotateSeed = false } = {}) {
  const calls = [];
  const mediaCalls = [];
  const seed = 'fxsd';
  let currentSeed = seed;
  let seedFetches = 0;
  let sourcesFetches = 0;
  const video = Buffer.alloc(564, 0x47); // three TS sync bytes
  const init = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 120, 109, 0, 0, 0, 0]); // ftyp isom
  const master = dir => `#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,BANDWIDTH=5000000\n1080.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,BANDWIDTH=2500000\n720.m3u8\n`;
  const leaf = name => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\n${name}\n#EXT-X-ENDLIST\n`;
  const sourcesFor = tmdb => ({
    sources: [
      { quality: '1080p', url: `${MEDIA_HOSTS[0]}/hls/${tmdb}/1080/master.m3u8` },
      { quality: '720p', url: `${MEDIA_HOSTS[1]}/hls/${tmdb}/720/master.m3u8` },
    ],
    subtitles: [],
  });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    calls.push(u);
    const headers = options.headers || {};
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (u.origin === DB) {
      const [, , type, id] = u.pathname.split('/');
      if (type === 'movie' && id === '9384') return json(wrongDetailId ? { ...MOVIE_DETAIL, id: 9385 } : MOVIE_DETAIL);
      if (type === 'tv' && id === '63333') return json(wrongDetailId ? { ...SERIES_DETAIL, id: 63334 } : SERIES_DETAIL);
      return new Response('Not found', { status: 404 });
    }
    if (u.origin === API) {
      if (u.pathname === '/seed') {
        seedFetches += 1;
        if (rotateSeed && seedFetches >= 2) currentSeed = 'rot2';
        return json({ seed: currentSeed, ttlMs: 30000 });
      }
      if (u.pathname === '/miami/sources') {
        sourcesFetches += 1;
        if (rotateSeed && sourcesFetches === 1) return new Response('Rotated seed', { status: 401 });
        const tmdb = Number(u.searchParams.get('tmdbId'));
        const payload = noSources ? { sources: [], subtitles: [] } : sourcesFor(tmdb);
        return new Response(movyPayload(payload, u.searchParams.get('seed'), tmdb), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('Unknown API route', { status: 404 });
    }
    if (MEDIA_HOSTS.includes(u.origin)) {
      mediaCalls.push({ url: u, referer: headers.referer, ua: headers['user-agent'] });
      const file = u.pathname.split('/')[4];
      const dir = u.pathname.split('/')[3];
      if (file === 'master.m3u8') return new Response(master(dir), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      if (file.endsWith('.m3u8')) {
        if (brokenFirst && dir === '1080' && file === '1080.m3u8') return new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } });
        return new Response(leaf('segment.ts'), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (file === 'init.mp4') return new Response(init);
      if (file === 'segment.ts') return new Response(video);
      return new Response('No media', { status: 404 });
    }
    return new Response('Unknown fixture host', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls, state: () => ({ seedFetches, sourcesFetches }) };
}

const policy = (enabled = ['movy', 'cinejoy']) => () => ({ order: ['movy', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('Movy decrypts its seeded payload and rejects tampered or wrong-seed input', () => {
  const json = { sources: [{ quality: '1080p', url: 'https://moon.goldenkite.top/hls/9384/1080/master.m3u8' }], subtitles: [] };
  const payload = movyPayload(json, 'abcd', 9384);
  assert.equal(decryptMovyPayload(payload, 'abcd', 9384), JSON.stringify(json));
  const corrupted = Array.from(payload);
  corrupted[0] = corrupted[0] === 'A' ? 'B' : 'A'; // first char covers magic byte 0
  assert.throws(() => decryptMovyPayload(corrupted.join(''), 'abcd', 9384), /decrypt/);
  assert.throws(() => decryptMovyPayload(payload, 'wxyz', 9384), /decrypt/);
});

test('Movy movie: resolves the exact requested TMDB id, queries season-less, and caches the source', async () => {
  const fixture = movyFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' });
  assert.equal(result.provider, 'movy');
  assert.equal(result.tmdb, 9384);
  assert.equal(result.kind, 'movie');
  assert.match(result.master, /^https:\/\//);
  const sources = fixture.calls.find(c => c.origin === API && c.pathname === '/miami/sources');
  assert.equal(sources.searchParams.get('tmdbId'), '9384');
  assert.equal(sources.searchParams.get('mediaType'), 'movie');
  assert.equal(sources.searchParams.get('year'), '2004');
  assert.equal(sources.searchParams.get('title'), encodeURIComponent(MOVIE_DETAIL.original_title));
  assert.equal(sources.searchParams.get('seasonId'), null);
  assert.equal(sources.searchParams.get('episodeId'), null);
  assert.equal(sources.searchParams.get('enc'), '2');
  assert.ok(sources.searchParams.get('seed'));
  for (const call of fixture.mediaCalls) {
    assert.equal(call.referer, 'https://www.movy.sx/');
    assert.match(call.ua, /Chrome/);
  }
  assert.ok(fixture.calls.every(c => [API, DB, ...MEDIA_HOSTS].includes(c.origin)));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' })).cached, true);
  assert.equal(fixture.calls.length, before);
});

test('Movy series: preserves season 0 and episode identity in the sources request', async () => {
  const fixture = movyFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 63333, kind: 'series', season: 0, episode: 2, provider: 'movy' });
  assert.equal(result.provider, 'movy');
  assert.equal(result.season, 0);
  assert.equal(result.episode, 2);
  const sources = fixture.calls.find(c => c.origin === API && c.pathname === '/miami/sources');
  assert.equal(sources.searchParams.get('tmdbId'), '63333');
  assert.equal(sources.searchParams.get('mediaType'), 'tv');
  assert.equal(sources.searchParams.get('seasonId'), '0');
  assert.equal(sources.searchParams.get('episodeId'), '2');
  assert.equal(sources.searchParams.get('totalSeasons'), '5');
  assert.equal(sources.searchParams.get('year'), '2015');
  assert.equal(sources.searchParams.get('title'), encodeURIComponent(SERIES_DETAIL.original_name));
  assert.equal(sources.searchParams.get('imdbId'), 'tt3650652');
});

test('Movy fails honestly when the upstream serves a different title for the TMDB id', async () => {
  const fixture = movyFetch({ wrongDetailId: true });
  const resolve = createProviderResolver(fixture);
  await assert.rejects(resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' }), e => e.provider_errors.movy === 'Movy returned a different title for this TMDB id');
  assert.equal(fixture.state().sourcesFetches, 0);
});

test('Movy tries qualities best-first and falls back when the best rendition is not video', async () => {
  const fixture = movyFetch({ brokenFirst: true });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' });
  assert.equal(result.provider, 'movy');
  assert.equal(result.server, 'movy/720p');
  assert.ok(fixture.calls.some(c => c.origin === MEDIA_HOSTS[0] && c.pathname.endsWith('/1080/master.m3u8')));
  assert.ok(fixture.calls.some(c => c.origin === MEDIA_HOSTS[0] && c.pathname.endsWith('/1080/1080.m3u8')));
  assert.ok(fixture.calls.some(c => c.origin === MEDIA_HOSTS[1] && c.pathname.endsWith('/720/segment.ts')));
});

test('Movy participates in configured provider fallback and honors exclusions', async () => {
  const fixture = movyFetch({ noSources: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 9384, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.deepEqual(result.provider_order, ['movy', 'cinejoy']);
  assert.equal(result.provider_errors.movy, 'Movy has no source for this title');
  const before = fixture.calls.length;
  await resolve({ tmdb: 9384, kind: 'movie', exclude: ['movy'], fresh: true });
  assert.equal(fixture.calls.length, before);
});

test('Movy pinned provider is rejected as disabled, not silently substituted', async () => {
  const fixture = movyFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
  await assert.rejects(resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' }), /disabled/);
});

test('Movy refreshes a rotated seed on 401 instead of caching the failure', async () => {
  const fixture = movyFetch({ rotateSeed: true });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 9384, kind: 'movie', provider: 'movy' });
  assert.equal(result.provider, 'movy');
  assert.equal(result.server, 'movy/1080p');
  const { seedFetches, sourcesFetches } = fixture.state();
  assert.equal(seedFetches, 2);
  assert.equal(sourcesFetches, 2);
});

test('Movy serves IPTV movie routes through the signed local HLS relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-movy-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = movyFetch();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['movy'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/9384.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.match(master, /RESOLUTION=1920x1080/);
    assert.doesNotMatch(master, /movy\.sx|wecollege\.net|goldenkite|nobleoffer|southdesk/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXT-X-MAP:URI="http/);
    assert.doesNotMatch(leaf, /movy\.sx|wecollege\.net|goldenkite|nobleoffer|southdesk/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const segment = await (await original(segmentURL)).arrayBuffer();
    assert.equal(segment.byteLength, 564);
    assert.ok(fixture.mediaCalls.some(c => c.referer === 'https://www.movy.sx/'));
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
