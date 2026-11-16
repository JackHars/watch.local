import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderResolver } from '../api/providers.mjs';

// MovieBite (moviebite.org) fixture: mirrors the verified live contract —
// a Referer-gated GET /api/watch that echoes the requested TMDB id (and,
// for series, the exact season/episode), followed by per-title media
// chains: flat unencrypted MPEG-TS media playlists (one CDN family
// disguises its segments as .jpg files) and direct progressive MP4 files.
// The verified chain has no cookies, one-shot tokens, or DRM. All hosts
// are .test placeholders and all token material is synthetic.
const BASE = 'https://moviebite.org';
const TITAN = 'https://titan.mbfixture.test';
const WILLOW = 'https://willow.mbfixture.test';
// 48-byte MP4 container: ftyp brand at offset 4.
const MP4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 42, 0, ...Array(32).fill(0)]);
// Plain MPEG-TS: sync byte 0x47 at every 188-byte offset.
const TS = Uint8Array.from({ length: 3 * 188 }, (_, i) => (i % 188 === 0 ? 0x47 : 0));
// Bait: a real PNG (the disguise one CDN family uses for segments).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

const FLAT =
  '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  '#EXTINF:3.0,\nseg\n#EXT-X-ENDLIST\n';

const api = (kind, tmdb, overrides) => {
  const o = overrides || {};
  return ({
    success: true,
    results: {
      media: { tmdbId: tmdb, mediaType: kind === 'series' ? 'tv' : 'movie', ...(kind === 'series' ? { season: 1, episode: 2 } : {}), ...o.media },
      streams: o.streams ?? [
      { name: 'Willow', provider: 'willow', quality: '1080p', format: 'mp4', bestWorking: true, url: `${WILLOW}/b.mp4` },
      { name: 'Titan', provider: 'titan', quality: '720p', format: 'hls', bestWorking: false, url: `${TITAN}/master` },
      ],
    },
  });
};

function moviebiteFetch({ gate = null, apiOverrides = {} } = {}) {
  const calls = [];
  const mediaCalls = [];
  let apiHits = 0;
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    const headers = {};
    for (const [k, v] of Object.entries(options.headers || {})) headers[String(k).toLowerCase()] = v;
    calls.push({ url: u, headers });
    if (u.hostname === 'moviebite.org' && u.pathname === '/api/watch') {
      apiHits += 1;
      if (gate === '429-first' && apiHits === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      if (gate === '403') return new Response('Origin not allowed', { status: 403 });
      const kind = u.searchParams.get('type') === 'tv' ? 'series' : 'movie';
      const tmdb = Number(u.searchParams.get('tmdbId'));
      assert.equal(headers['x-moviebite-client'], '1', 'the watch API must carry the site client header');
      assert.equal(headers.referer, `${BASE}/watch/${kind === 'series' ? 'tv' : 'movie'}/${tmdb}`, 'the watch API requires the same-origin play-page Referer');
      assert.equal(u.searchParams.get('id'), String(tmdb));
      assert.equal(u.searchParams.get('sv'), '19');
      return new Response(JSON.stringify(api(kind, tmdb, apiOverrides)), { headers: { 'content-type': 'application/json' } });
    }
    if (u.hostname === 'titan.mbfixture.test') {
      mediaCalls.push({ url: u, referer: headers['referer'] });
      if (u.pathname === '/master') {
        assert.equal(headers['referer'], `${BASE}/`, 'the HLS master hop must carry the site referer');
        return new Response(FLAT, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (u.pathname === '/seg') {
        assert.equal(headers['referer'], `${BASE}/`, 'the segment hop must carry the site referer');
        return new Response(TS, { headers: { 'content-type': 'video/mp2t' } });
      }
      return new Response('not found', { status: 404 });
    }
    if (u.hostname === 'willow.mbfixture.test') {
      mediaCalls.push({ url: u, referer: headers['referer'] });
      if (u.pathname === '/a.mp4') return new Response(PNG, { headers: { 'content-type': 'video/mp4' } });
      if (u.pathname === '/b.mp4') return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls, apiHits: () => apiHits };
}

const policy = () => () => ({ order: ['moviebite', 'cinejoy'], enabled: ['moviebite', 'cinejoy'], providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });
// The settings store is a process singleton pinned to its data directory at
// first import, so both IPTV tests share one directory (created here, removed
// by the last test).
let iptvDirectory = null;
const ensureIptvDirectory = async () => {
  if (!iptvDirectory) {
    iptvDirectory = await mkdtemp(join(tmpdir(), 'watchlocal-moviebite-iptv-'));
    process.env.WATCHLOCAL_DATA_DIR = iptvDirectory;
  }
  return iptvDirectory;
};

test('movie: the Referer-gated API identity echo resolves a direct MP4 source; cached then fresh', async () => {
  const fixture = moviebiteFetch();
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource });
  const out = await resolve({ tmdb: 550, kind: 'movie', provider: 'moviebite' });
  assert.equal(out.provider, 'moviebite');
  assert.equal(out.tmdb, 550);
  assert.equal(out.kind, 'movie');
  assert.equal(out.server, 'Willow');
  assert.equal(out.master, `${WILLOW}/b.mp4`);
  const apiCalls = fixture.calls.filter(c => c.url.pathname === '/api/watch');
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].headers.referer, `${BASE}/watch/movie/550`);
  const mp4 = fixture.mediaCalls.find(c => c.url.pathname === '/b.mp4');
  assert.ok(mp4, 'the MP4 candidate gets a container peek');

  const again = await resolve({ tmdb: 550, kind: 'movie', provider: 'moviebite' });
  assert.equal(again.cached, true);
  assert.equal(again.master, out.master);
  assert.equal(fixture.apiHits(), 1, 'a cached hit must not refetch the API');

  const fresh = await resolve({ tmdb: 550, kind: 'movie', provider: 'moviebite', fresh: true });
  assert.equal(fresh.cached, false);
  assert.equal(fixture.apiHits(), 2, 'fresh forces an upstream revalidation');
});

test('movie: a PNG-disguised MP4 candidate is skipped and the next MP4 wins', async () => {
  const fixture = moviebiteFetch({
    apiOverrides: { streams: [
      { name: 'Willow A', provider: 'willow', quality: '1080p', format: 'mp4', url: `${WILLOW}/a.mp4` },
      { name: 'Willow B', provider: 'willow', quality: '720p', format: 'mp4', url: `${WILLOW}/b.mp4` },
    ] },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie', provider: 'moviebite' });
  assert.equal(out.provider, 'moviebite');
  assert.equal(out.master, `${WILLOW}/b.mp4`, 'the baited candidate must be skipped, not served');
});

test('movie: when every MP4 candidate is dead, the next enabled provider serves', async () => {
  const fixture = moviebiteFetch({
    apiOverrides: { streams: [
      { name: 'Willow A', provider: 'willow', quality: '1080p', format: 'mp4', url: `${WILLOW}/dead-a.mp4` },
      { name: 'Willow B', provider: 'willow', quality: '720p', format: 'mp4', url: `${WILLOW}/dead-b.mp4` },
    ] },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moviebite, /no playable source/i);
});

test('series: a flat HLS media playlist validates end to end with the season/episode echo', async () => {
  const fixture = moviebiteFetch({
    apiOverrides: { streams: [{ name: 'Titan', provider: 'titan', quality: '720p', format: 'hls', bestWorking: true, url: `${TITAN}/master` }] },
  });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'series', season: 1, episode: 2, provider: 'moviebite' });
  assert.equal(out.provider, 'moviebite');
  assert.equal(out.season, 1);
  assert.equal(out.episode, 2);
  assert.equal(out.master, `${TITAN}/master`);
  const apiCall = fixture.calls.find(c => c.url.pathname === '/api/watch');
  assert.equal(apiCall.headers.referer, `${BASE}/watch/tv/550`);
  for (const c of fixture.mediaCalls) assert.equal(c.referer, `${BASE}/`);
});

test('series: a mismatched tmdbId echo rejects instead of substituting the title', async () => {
  const fixture = moviebiteFetch({ apiOverrides: { media: { tmdbId: 999 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'series', season: 1, episode: 2 });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moviebite, /no media for the requested TMDB/i);
});

test('series: a wrong season or episode echo rejects instead of substituting the episode', async () => {
  const fixture = moviebiteFetch({ apiOverrides: { media: { season: 2, episode: 2 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'series', season: 1, episode: 2 });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.moviebite, /different season or episode/i);
});

test('api: a 429 on the watch API gets one bounded backoff, then resolves', async () => {
  const fixture = moviebiteFetch({ gate: '429-first' });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie', provider: 'moviebite' });
  assert.equal(out.provider, 'moviebite');
  assert.equal(fixture.apiHits(), 2, 'one bounded retry, then the identity-checked response');
});

test('api: a 403 gate rejection fails cleanly and the next provider is used', async () => {
  const fixture = moviebiteFetch({ gate: '403' });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 550, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.equal(out.provider_errors.moviebite, 'HTTP 403');
  assert.equal(fixture.mediaCalls.length, 0, 'a rejected gate must never reach the media chain');
});

test('iptv: the MP4 master is relayed as video/mp4 with no upstream host leaking', async () => {
  const directory = await ensureIptvDirectory();
  const original = globalThis.fetch;
  let server;
  try {
    const fixture = moviebiteFetch({
      apiOverrides: { streams: [{ name: 'Willow', provider: 'willow', quality: '1080p', format: 'mp4', bestWorking: true, url: `${WILLOW}/b.mp4` }] },
    });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['moviebite'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    // tmdb 777: a fresh key, so this test resolves from the fixture instead
    // of the module-level cache populated by the resolver tests above.
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/777.m3u8`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /video\/mp4/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString(), 'ftyp', 'the relayed bytes are the MP4 container, not HTML or a redirect');
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    // The shared IPTV directory is removed by the last test in the file.
  }
});

test('iptv: the HLS master is rewritten to signed local assets and segment bytes play', async () => {
  const directory = await ensureIptvDirectory();
  const original = globalThis.fetch;
  let server;
  try {
    const fixture = moviebiteFetch({
      apiOverrides: { streams: [{ name: 'Titan', provider: 'titan', quality: '720p', format: 'hls', bestWorking: true, url: `${TITAN}/master` }] },
    });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['moviebite'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    // tmdb 888: a fresh key, so this test resolves from the fixture instead
    // of the module-level cache populated by the tests above (777 was the
    // MP4 relay test).
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/888.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /titan|willow|moviebite/i, 'no upstream host may appear in the rewritten master');
    const segmentURL = master.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    assert.ok(segmentURL, 'the flat playlist exposes a local segment URL');
    assert.match(segmentURL, /^http:\/\/127\.0\.0\.1/);
    const segment = await original(segmentURL);
    assert.equal(segment.status, 200);
    const bytes = Buffer.from(await segment.arrayBuffer());
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
    iptvDirectory = null;
  }
});
