import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';

// Ghostflix (ghostflix.st) fixture: mirrors the verified VidBolt chain — a
// keyless TMDB-addressed resolve API (vidbolt.st) whose sources[i].url points
// at a short-lived token manifest on proxy.vidbolt.xyz. Movie manifests are
// masters; TV manifests are flat VOD playlists; both end in /s/<token>
// MPEG-TS segments. The CDN mislabels segment Content-Type, so validation is
// byte-based (0x47 at every 188-byte offset). The API has no referer gate,
// so no referer header is sent at all, and the stale inline `master`
// previews must never be fetched.
const tsSegment = (n, seed) => {
  const buf = Buffer.alloc(188 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 188; k++) buf[188 * i + k] = k === 0 ? 0x47 : (k + seed) & 0xff;
  return buf;
};
const ts = (seed) => tsSegment(30, seed);

function ghostflixFetch({ streamNull = false, baitFirst = false, baitAll = false, bogus = false, id = '1003596' } = {}) {
  const calls = [];
  const mediaCalls = [];
  const master = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=4783294,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\n1080.m3u8\n';
  const leaf = (base) => `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.000,\n${base}/seg1?s=1\n#EXTINF:6.000,\n${base}/seg2?s=1\n#EXT-X-ENDLIST\n`;
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const hlsRes = (text) => new Response(text, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers: options.headers || {} });
    if (u.hostname === 'vidbolt.st') {
      assert.equal(u.pathname, '/api/resolve');
      assert.equal(u.searchParams.get('id'), id);
      assert.equal(u.searchParams.get('hevc'), '0');
      assert.equal(options.headers.referer, undefined);
      if (streamNull) return json({ stream: null });
      if (u.searchParams.get('type') === 'tv') {
        if (!bogus) { assert.equal(u.searchParams.get('season'), '1'); assert.equal(u.searchParams.get('episode'), '1'); }
        return json({
          stream: {
            server: 'vega',
            sources: [
              { url: 'https://proxy.vidbolt.xyz/m/tokA?f=.m3u8', kind: 'hls', quality: '720p', master: 'https://proxy.vidbolt.xyz/m/stale-preview?f=.m3u8' },
              { url: 'https://proxy.vidbolt.xyz/m/tokB?f=.m3u8', kind: 'hls', quality: '480p', master: 'https://proxy.vidbolt.xyz/m/stale-preview2?f=.m3u8' },
            ],
            subtitles: [{ url: 'https://subs.example/1.vtt', label: 'en', lang: 'en' }],
            resolvedAt: 'fixture',
          },
        });
      }
      assert.equal(u.searchParams.get('type'), 'movie');
      return json({
        stream: {
          server: 'quantum',
          sources: [{ url: 'https://proxy.vidbolt.xyz/m/tokC?f=.m3u8', kind: 'hls', quality: 'Auto', master: 'https://proxy.vidbolt.xyz/m/stale-preview3?f=.m3u8' }],
          subtitles: [],
        },
      });
    }
    if (u.hostname === 'proxy.vidbolt.xyz') {
      mediaCalls.push({ url: u, referer: options.headers?.referer });
      if (/stale-preview/.test(u.pathname)) throw new Error('stale inline master preview was fetched');
      if (u.pathname.endsWith('tokA')) return hlsRes(leaf('m/tokA'));
      if (u.pathname.endsWith('tokB')) return hlsRes(leaf('m/tokB'));
      if (u.pathname.endsWith('tokC')) return hlsRes(master);
      if (u.pathname.endsWith('1080.m3u8')) return hlsRes(leaf('m/1080'));
      if (u.pathname.endsWith('seg1') || u.pathname.endsWith('seg2')) {
        const bait = (u.pathname.endsWith('seg1') && (baitAll || (baitFirst && u.pathname.includes('tokA')))) || (u.pathname.endsWith('seg2') && baitAll);
        if (bait) return new Response('<html>player</html>', { headers: { 'content-type': 'text/html' } });
        return new Response(ts(u.pathname.endsWith('seg1') ? 1 : 2), { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
}

const policy = (enabled = ['ghostflix', 'cinejoy']) => () => ({ order: ['ghostflix', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('Ghostflix movie: keyless resolve -> master -> 1080p VOD, no referer, stale preview untouched', async () => {
  const fixture = ghostflixFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 1003596, kind: 'movie', provider: 'ghostflix' });
  assert.equal(result.provider, 'ghostflix');
  assert.equal(result.server, 'ghostflix');
  assert.match(result.master, /^https:\/\/proxy\.vidbolt\.xyz\/m\/tokC\?f=\.m3u8/);
  assert.equal(result.variants[0].width, 1920);
  for (const call of fixture.calls) assert.equal(call.headers.referer, undefined);
  for (const call of fixture.mediaCalls) assert.equal(call.referer, undefined);
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('m/1080/seg1')));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 1003596, kind: 'movie', provider: 'ghostflix' })).cached, true);
  assert.equal(fixture.calls.length, before);
});

test('Ghostflix TV: flat VOD playlist, first source wins, second source untouched', async () => {
  const fixture = ghostflixFetch({ id: '84773' });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 84773, kind: 'series', season: 1, episode: 1, provider: 'ghostflix' });
  assert.equal(result.provider, 'ghostflix');
  assert.equal(result.season, 1);
  assert.equal(result.episode, 1);
  assert.match(result.master, /^https:\/\/proxy\.vidbolt\.xyz\/m\/tokA\?f=\.m3u8/);
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('m/tokA/seg1')));
  assert.ok(!fixture.mediaCalls.some(c => c.url.pathname.includes('/tokB')), 'unused 480p source must not be fetched');
});

test('Ghostflix TV: a baited first source falls back to the next source', async () => {
  const fixture = ghostflixFetch({ id: '84773', baitFirst: true });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 84773, kind: 'series', season: 1, episode: 1, provider: 'ghostflix' });
  assert.equal(result.provider, 'ghostflix');
  assert.match(result.master, /^https:\/\/proxy\.vidbolt\.xyz\/m\/tokB\?f=\.m3u8/);
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('m/tokA/seg1')), 'the baited source was tried first');
});

test('Ghostflix stream:null (unavailable title or episode) fails honestly and falls back', async () => {
  const fixture = ghostflixFetch({ streamNull: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1003596, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.ghostflix, /no playable source/);
  const bogusFixture = ghostflixFetch({ id: '84773', streamNull: true, bogus: true });
  const bogus = createProviderResolver({ ...bogusFixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await bogus({ tmdb: 84773, kind: 'series', season: 99, episode: 99 });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.ghostflix, /no playable source/);
});

test('Ghostflix: every source baited rejects with the last error and falls back', async () => {
  const fixture = ghostflixFetch({ baitAll: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1003596, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.ghostflix, /not.*video|bait/i);
});

test('Ghostflix exclusions skip the provider and a pinned disabled provider is rejected', async () => {
  const fixture = ghostflixFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1003596, kind: 'movie', exclude: ['ghostflix'] });
  assert.equal(result.provider, 'cinejoy');
  assert.equal(fixture.calls.length, 0);
  const disabled = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
  await assert.rejects(disabled({ tmdb: 1003596, kind: 'movie', provider: 'ghostflix' }), /disabled/);
});

test('Ghostflix serves IPTV movie routes through the signed local HLS relay with MPEG-TS segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-ghostflix-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = ghostflixFetch();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['ghostflix'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/1003596.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /vidbolt|ghostflix/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXTINF:/);
    assert.doesNotMatch(leaf, /vidbolt|ghostflix/);
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
