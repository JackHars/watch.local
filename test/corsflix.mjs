import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';
import { decryptCorsflix, corsflixKey } from '../api/corsflix.mjs';

const RESOLVER = 'https://new.vidnest.fun';
const CDN_A = 'https://cdn.a.test';
const CDN_B = 'https://cdn.b.test';
const CDN_AVC = 'https://cdn.avc.test';
const BAITS = 'https://img.bait.test';
const REFERER = 'https://vidrift.example.net/';
const BACKEND_PREFIXES = ['onehd', 'allmovies', 'hollymoviehd', 'ophim', 'vidzee', 'flixhq', 'yflix', 'rogflix'];

// Build a VidNest-style envelope exactly as the live resolver does:
// {v:2, n, d} where d is base64url(iv | AES-256-GCM ciphertext | auth tag)
// under SHA-256(`n|<public key>`), so the real adapter decrypts it.
function envelope(plain, n) {
  const key = createHash('sha256').update(`${n}|${corsflixKey}`).digest();
  const iv = createHash('sha256').update(`iv|${n}`).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([iv, cipher.update(Buffer.from(JSON.stringify(plain))), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  return { v: 2, n, d };
}
const token = plain => Buffer.from(JSON.stringify(plain)).toString('base64url');
const meta = (kind, id, season, episode, language) => {
  const value = { k: kind, id: String(id), l: language };
  if (kind === 'tv') { value.s = season; value.e = episode; }
  return value;
};

// Deterministic upstream: the encrypted resolver and fMP4 media hosts
// (time-independent, no signed URLs in fixtures).
function corsflixFetch({ brokenFirst = false, emptyBackends = [], episodeDelta = 0 } = {}) {
  const calls = [];
  const mediaCalls = [];
  const init = Buffer.from('000000186674797069736f36000000000000000000000000', 'hex'); // ftyp isom
  const seg = Buffer.from('00000018737479706d736468000000000000000000000000', 'hex'); // fMP4 styp msdh
  const png = Buffer.from('89504e470d0a1a0a504e470d0a1a0a', 'hex');
  const master = dir => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1728000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,mp4a.40.2",AUDIO="aud"\n${dir}/v0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1044000,RESOLUTION=1280x720,CODECS="hvc1.1.6.L120.90,mp4a.40.2",AUDIO="aud"\n${dir}/v1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=628000,RESOLUTION=854x480,CODECS="hvc1.1.6.L120.90,mp4a.40.2",AUDIO="aud"\n${dir}/v2.m3u8\n`;
  const leaf = (initName, segName) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MAP:URI="${initName}"\n#EXTINF:7.0,\n${segName}\n#EXTINF:7.0,\n${segName}\n#EXT-X-ENDLIST\n`;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const hls = text => new Response(text, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  const plaintextFor = (kind, id, season, episode, prefix) => prefix === 'allmovies' ? {
    streams: [
      { language: 'Hindi', type: 'hls', url: `${CDN_AVC}/hindi/master.m3u8`, headers: { Referer: REFERER } },
      { language: 'English', type: 'hls', url: `${CDN_AVC}/english/master.m3u8`, headers: { Referer: REFERER } },
    ], totalLanguages: 2,
  } : ({
    status: 'success',
    streams: [
      { language: 'Original', quality: '1080p', type: 'hls', url: `/hls/${token({ u: `${CDN_A}/api/orion/000000000000000000000000000000a1/master.m3u8`, h: { Referer: REFERER }, m: meta(kind, id, season + episodeDelta, episode + episodeDelta, 'Original') })}/master.m3u8` },
      { language: 'Hindi', quality: '480p', type: 'hls', url: `/hls/${token({ u: `${BAITS}/${kind}/${id}.png`, h: { Referer: REFERER }, m: meta(kind, id, season + episodeDelta, episode + episodeDelta, 'Hindi') })}/master.m3u8` },
      { language: 'French', quality: '720p', type: 'hls', url: `/hls/${token({ u: `${CDN_B}/api/orion/000000000000000000000000000000b2/master.m3u8`, h: { Referer: REFERER }, m: meta(kind, id, season + episodeDelta, episode + episodeDelta, 'French') })}/master.m3u8` },
    ],
    subtitles: [{ language: 'English', url: `${RESOLVER}/subs/${id}/en.vtt` }],
  });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    calls.push(u);
    const headers = options.headers || {};
    if (u.origin === RESOLVER) {
      const n = u.searchParams.get('_n');
      if (!/^[A-Za-z0-9_-]{22}$/.test(n || '')) return json({ error: 'missing or invalid nonce' }, 403);
      const m = u.pathname.match(/^\/(onehd|allmovies|hollymoviehd|ophim|vidzee|flixhq|yflix|rogflix)\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?\/?$/);
      if (!m) return new Response('not found', { status: 404 });
      const [, prefix, kind, id, season, episode] = m;
      if (kind === 'tv' && (season === undefined || episode === undefined)) return new Response('bad request', { status: 400 });
      if (emptyBackends.includes(prefix)) return json(envelope({}, n));
      return json(envelope(plaintextFor(kind, id, Number(season || 0), Number(episode || 0), prefix), n));
    }
    if (u.origin === CDN_AVC) {
      mediaCalls.push({ url: u, referer: headers.referer || headers.Referer, ua: headers['user-agent'] });
      if (u.pathname.endsWith('master.m3u8')) return hls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720.m3u8\n');
      if (u.pathname.endsWith('720.m3u8')) return hls('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n');
      if (u.pathname.endsWith('seg0.ts')) {
        const ts = Buffer.alloc(188 * 4); ts[0] = ts[188] = ts[376] = ts[564] = 0x47;
        return new Response(ts);
      }
      return new Response('No media', { status: 404 });
    }
    if (u.origin === CDN_A || u.origin === CDN_B) {
      mediaCalls.push({ url: u, referer: headers.referer, ua: headers['user-agent'] });
      const file = u.pathname.split('/').at(-1);
      if (u.origin === CDN_B) {
        if (file === 'master.m3u8') return hls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1044000,RESOLUTION=1280x720\nv.m3u8\n');
        if (file === 'v.m3u8') return hls(leaf('init.m4s', 'seg1.m4s'));
        if (file === 'init.m4s') return new Response(init);
        if (file === 'seg1.m4s') return new Response(seg);
      } else {
        if (file === 'master.m3u8') return hls(master('/api/orion/000000000000000000000000000000a1'));
        if (file === 'v0.m3u8') return brokenFirst ? new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } }) : hls(leaf('init-stream0.m4s', 'seg1.m4s'));
        if (file === 'v1.m3u8' || file === 'v2.m3u8') return hls(leaf('init-stream0.m4s', 'seg1.m4s'));
        if (file === 'a.m3u8') return hls(leaf('init-a.m4s', 'a1.m4s'));
        if (file === 'init-stream0.m4s' || file === 'init-a.m4s') return new Response(init);
        if (file === 'seg1.m4s' || file === 'a1.m4s') return new Response(seg);
      }
      return new Response('No media', { status: 404 });
    }
    if (u.origin === BAITS) return new Response(png);
    return new Response('Unknown fixture host', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
};

const policy = (enabled = ['corsflix', 'cinejoy']) => () => ({ order: ['corsflix', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('CorsFlix decrypts its envelope with the public key and rejects tampered or wrong-key input', () => {
  const plain = { status: 'success', streams: [{ language: 'Original', quality: '1080p', url: '/hls/x/master.m3u8' }] };
  assert.deepEqual(decryptCorsflix(envelope(plain, '0123456789abcdef')), plain);
  const good = envelope(plain, '0123456789abcdef');
  const chars = Array.from(good.d);
  chars[0] = chars[0] === 'A' ? 'B' : 'A';
  assert.throws(() => decryptCorsflix({ ...good, d: chars.join('') }), /decrypt|authenticate|envelope/i);
  assert.throws(() => decryptCorsflix({ ...good, v: 3 }), /invalid encrypted envelope/);
  const foreign = { ...envelope(plain, 'fedcba9876543210') };
  const key = createHash('sha256').update(`${foreign.n}|wrong-key`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  foreign.d = Buffer.concat([iv, cipher.update(Buffer.from(JSON.stringify(plain))), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  assert.throws(() => decryptCorsflix(foreign), /decrypt|authenticate/i);
});

test('CorsFlix movie: resolves the exact requested TMDB id through the encrypted resolver and caches', async () => {
  const fixture = corsflixFetch({ emptyBackends: ['allmovies'] });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'corsflix' });
  assert.equal(result.provider, 'corsflix');
  assert.equal(result.tmdb, 27205);
  assert.equal(result.kind, 'movie');
  assert.equal(result.server, 'onehd/1080p');
  const resolverCall = fixture.calls.find(c => c.pathname === '/onehd/movie/27205');
  assert.equal(resolverCall.pathname, '/onehd/movie/27205');
  assert.match(resolverCall.searchParams.get('_n'), /^[A-Za-z0-9_-]{22}$/);
  for (const call of fixture.mediaCalls) {
    assert.equal(call.referer, REFERER);
    assert.match(call.ua, /Chrome/);
  }
  assert.ok(fixture.calls.every(c => [RESOLVER, CDN_A, CDN_B, CDN_AVC, BAITS].includes(c.origin)));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'corsflix' })).cached, true);
  assert.equal(fixture.calls.length, before);
});

test('CorsFlix TV: preserves the exact episode in the resolver path and result identity', async () => {
  const fixture = corsflixFetch({ emptyBackends: ['allmovies'] });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 1396, kind: 'series', season: 3, episode: 2, provider: 'corsflix' });
  assert.equal(result.provider, 'corsflix');
  assert.equal(result.tmdb, 1396);
  assert.equal(result.season, 3);
  assert.equal(result.episode, 2);
  const resolverCall = fixture.calls.find(c => c.pathname === '/onehd/tv/1396/3/2');
  assert.equal(resolverCall.pathname, '/onehd/tv/1396/3/2');
});

test('CorsFlix prefers the direct English H.264 source over the HEVC-only backup', async () => {
  const fixture = corsflixFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 1396, kind: 'series', season: 1, episode: 1, provider: 'corsflix' });
  assert.equal(result.server, 'allmovies/English');
  assert.equal(fixture.calls.find(c => c.origin === RESOLVER).pathname, '/allmovies/tv/1396/1/1');
  assert.ok(!fixture.calls.some(c => c.pathname === '/onehd/tv/1396/1/1'));
  assert.ok(fixture.mediaCalls.some(c => c.url.origin === CDN_AVC && c.url.pathname.includes('/english/')));
  assert.ok(!fixture.mediaCalls.some(c => c.url.origin === CDN_AVC && c.url.pathname.includes('/hindi/')));
  assert.ok(fixture.mediaCalls.filter(c => c.url.origin === CDN_AVC).every(c => c.referer === REFERER));
});

test('CorsFlix fails honestly when a stream token names a different episode', async () => {
  const fixture = corsflixFetch({ episodeDelta: 1, emptyBackends: ['allmovies'] });
  // Let the adapter finish checking its backends so we can verify its failure reason.
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(), fallbackDelayMs: 5000 });
  const result = await resolve({ tmdb: 1396, kind: 'series', season: 1, episode: 1 });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.corsflix, /different episode/);
});

test('CorsFlix tries streams best-first, skips image bait, and accepts the next working stream', async () => {
  const fixture = corsflixFetch({ brokenFirst: true, emptyBackends: ['allmovies'] });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'corsflix' });
  assert.equal(result.provider, 'corsflix');
  assert.equal(result.server, 'onehd/720p');
  assert.ok(fixture.calls.some(c => c.origin === BAITS), 'the bait master must have been probed');
  assert.ok(fixture.mediaCalls.some(c => c.url.origin === CDN_B), 'the working stream must come from the second CDN');
});

test('CorsFlix treats a rate-limited empty envelope as a per-backend failure and moves to the next backend', async () => {
  const fixture = corsflixFetch({ emptyBackends: ['allmovies'] });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'corsflix' });
  assert.equal(result.provider, 'corsflix');
  assert.equal(result.server, 'onehd/1080p');
  assert.match(result.server_errors.allmovies, /no streams/);
  assert.ok(fixture.calls.filter(c => c.origin === RESOLVER).length >= 2);
});

test('CorsFlix falls back to the next provider when every backend has no streams', async () => {
  const fixture = corsflixFetch({ emptyBackends: BACKEND_PREFIXES });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(), fallbackDelayMs: 5000 });
  const result = await resolve({ tmdb: 27205, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.deepEqual(result.provider_order, ['corsflix', 'cinejoy']);
  assert.match(result.provider_errors.corsflix, /no streams/);
});

test('CorsFlix honors exclusions without contacting the resolver', async () => {
  const fixture = corsflixFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 27205, kind: 'movie', exclude: ['corsflix'] });
  assert.equal(result.provider, 'cinejoy');
  assert.equal(fixture.calls.filter(c => c.origin === RESOLVER).length, 0);
});

test('CorsFlix pinned provider is rejected as disabled, not silently substituted', async () => {
  const fixture = corsflixFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
  await assert.rejects(resolve({ tmdb: 27205, kind: 'movie', provider: 'corsflix' }), /disabled/);
});

test('CorsFlix serves IPTV movie routes through the signed local HLS relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-corsflix-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = corsflixFetch({ emptyBackends: ['allmovies'] });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['corsflix'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/27205.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.match(master, /RESOLUTION=1920x1080/);
    assert.doesNotMatch(master, /corsflix\.net|vidnest\.fun|vidrift|cdn\.a\.test|cdn\.b\.test/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXT-X-MAP:URI="http/);
    assert.doesNotMatch(leaf, /corsflix\.net|vidnest\.fun|vidrift|cdn\.a\.test|cdn\.b\.test/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const segment = await (await original(segmentURL)).arrayBuffer();
    assert.equal(segment.byteLength, 24);
    assert.equal(Buffer.from(segment).subarray(4, 8).toString(), 'styp');
    assert.ok(fixture.mediaCalls.some(c => c.referer === REFERER));
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
