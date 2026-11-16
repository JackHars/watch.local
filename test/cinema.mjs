import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderResolver } from '../api/providers.mjs';
import { streamToken, STREAM_TOKEN_KEY, STREAM_XOR_KEY } from '../api/cinema-crypto.mjs';

// Cinema (BZ) (cinema.army) fixture — mirrors the live-verified contract
// (evidence artifact 07552f4c27ae, re-verified live 2026-11-24):
//
//   * the API lives at /api/<server>/{movie,tv}/... on cinema.army: the
//     cookiebakers server first (POST), then the GET mirrors
//     ngcloud/tcloud/ipcloud/dcloud (ngcloud is movie-only); every call needs
//     the X-Stream-Token header — a hex HMAC-SHA256 of "<tmdb>:<minute>" with
//     the bundle-published key, recomputed per server (the fixture recomputes
//     the same derivation and rejects missing, foreign, or stale tokens);
//   * a hit answers { stream: { url, duration_seconds } }; a non-http url is
//     base64 + XOR (second bundle-published key) decoding to the real playlist
//     on the cookiebakers23blog.xyz CDN family (served here on a .test host);
//   * the chain is master (v1080/v720/v480; TV adds an audio group and forced
//     subtitles) → variant → leaf with #EXT-X-KEY:METHOD=AES-128,
//     URI="../enc.key", IV=0x<static> (16-byte key file served openly) →
//     AES-128-CBC segments → MPEG-TS. No cookies, no DRM, no Referer gate.
//   * The mirrors have been observed serving HTML/PNG bait or dead hosts for
//     the same paths, so each server's chain is media-validated (accept) and a
//     failing mirror is skipped; 404 means the server does not carry the
//     title. The response never echoes the requested id, so identity is exact
//     keying.
const CDN_HOST = 'cookiebakers23blog-fixture.test';
const CDN = `https://${CDN_HOST}`;
const UA_RE = /Mozilla\/5\.0/;

// The 16-byte AES-128 key-file bytes, served openly in each play directory.
const KEY_BYTES = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
// The static IV the site's leaf playlists carry on #EXT-X-KEY.
const IV_HEX = '43a6d967d5c17290d98322f5c8f6660b';
const IV_BYTES = Buffer.from(IV_HEX, 'hex');

// Plaintext MPEG-TS pattern: 0x47 sync at every 188-byte offset.
const tsPlain = () => Uint8Array.from({ length: 3 * 188 }, (_, i) => (i % 188 === 0 ? 0x47 : 0));
// Plaintext ADTS audio frame: 0xff sync with the ADTS header bits.
const adtsPlain = () => Uint8Array.from([0xff, 0xf1, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
const HTML_BAIT = '<html><body>Error</body></html>';
const PNG_BAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const encrypt = (plain) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY_BYTES, IV_BYTES);
  return Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
};
const videoPlain = (cfg) => ({ html: HTML_BAIT, png: PNG_BAIT }[cfg.segment] || tsPlain());

// jxe() encoding, the inverse of decodeStreamUrl: http(s) passes through,
// otherwise base64 of bytes XORed with the key, char at i % 64.
function encodeUrl(plain) {
  if (plain.startsWith('http')) return plain;
  const raw = Buffer.from(plain);
  let out = '';
  for (let index = 0; index < raw.length; index++) out += String.fromCharCode(raw[index] ^ STREAM_XOR_KEY.charCodeAt(index % STREAM_XOR_KEY.length));
  return Buffer.from(out).toString('base64');
}

const movieMaster = (base) => `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\n${base}/v480/index.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720,CODECS="avc1.64001e,mp4a.40.2"\n${base}/v720/index.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=1920x1080,CODECS="avc1.64001e,mp4a.40.2"\n${base}/v1080/index.m3u8\n` +
  '#EXT-X-ENDLIST\n';

const tvMaster = (base) => `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:8\n` +
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="${base}/audio/en.m3u8"\n` +
  `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Forced",FORCED=YES,URI="${base}/subs/forced.vtt"\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"\n${base}/v720/index.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=1920x1080,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"\n${base}/v1080/index.m3u8\n` +
  '#EXT-X-ENDLIST\n';

const keyLine = (method) => method === 'SAMPLING'
  ? `#EXT-X-KEY:METHOD=${method},URI="../enc.key"`
  : `#EXT-X-KEY:METHOD=${method},URI="../enc.key",IV=0x${IV_HEX}`;

const videoLeaf = (base, cfg) => `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n` +
  `${keyLine(cfg.keyMethod || 'AES-128')}\n` +
  `#EXTINF:8.00000,\n${base}/v1080/seg0.ts\n#EXTINF:8.00000,\n${base}/v1080/seg1.ts\n#EXT-X-ENDLIST\n`;

const audioLeaf = (base) => `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:16\n#EXT-X-MEDIA-SEQUENCE:0\n` +
  `#EXT-X-KEY:METHOD=AES-128,URI="../enc.key",IV=0x${IV_HEX}\n` +
  `#EXTINF:16.00000,\n${base}/audio/seg0.aac\n#EXT-X-ENDLIST\n`;

// Per-test knobs:
//   servers: per-server response config: { status?, fourOhOne?, passThrough?,
//            keyMethod?, segment: 'html'|'png' } — absent servers return a
//            healthy chain, so a test names every server it wants to control.
//   expect:  { token: false } skips token validation; { path } asserts the
//            exact API path.
function cinemaFetch({ servers = {}, expect = {} } = {}) {
  const apiCalls = [];
  const keyCalls = [];
  const segmentCalls = [];
  const playlistCalls = [];
  let context = null;

  const fetchResource = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = options.headers || {};
    const method = options.method || 'GET';
    if (url.hostname === 'cinema.army') {
      const match = url.pathname.match(/^\/api\/(cookiebakers|ngcloud|tcloud|ipcloud|dcloud)\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?$/);
      if (!match) return new Response('not found', { status: 404 });
      const [, serverName, mediaKind, tmdb, season, episode] = match;
      context = { mediaKind };
      assert.equal(method, serverName === 'cookiebakers' ? 'POST' : 'GET', `${serverName} must be called with ${serverName === 'cookiebakers' ? 'POST' : 'GET'}`);
      assert.match(String(headers['user-agent'] || ''), UA_RE);
      if (expect.token !== false) {
        const token = String(headers['x-stream-token'] || '');
        assert.match(token, /^[0-9a-f]{64}$/, 'X-Stream-Token must be a 64-hex HMAC');
        // The site's own client has the same minute-boundary race, so the
        // gate must accept the computed minute and the one it arrives in.
        const minute = Math.floor(Date.now() / 1000 / 60);
        const valid = new Set([streamToken(tmdb, STREAM_TOKEN_KEY, minute), streamToken(tmdb, STREAM_TOKEN_KEY, minute - 1)]);
        assert.ok(valid.has(token), 'X-Stream-Token must be this tmdb id at the current or previous minute');
      }
      if (expect.path) assert.equal(url.pathname, expect.path);
      apiCalls.push({ server: serverName, path: url.pathname, method });
      const cfg = servers[serverName] || {};
      if (cfg.status) return new Response(`unavailable ${serverName}`, { status: cfg.status });
      if (cfg.fourOhOne) return new Response('token rejected', { status: 401 });
      const dir = mediaKind === 'movie' ? `movie-${tmdb}` : `tv-${tmdb}-${season}-${episode}`;
      const master = `${CDN}/play/${dir}/${serverName}/master.m3u8`;
      const streamUrl = cfg.passThrough ? master : encodeUrl(master);
      return new Response(JSON.stringify({ stream: { url: streamUrl, duration_seconds: cfg.duration ?? (mediaKind === 'movie' ? 10380 : 3960) } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === CDN_HOST) {
      const parts = url.pathname.split('/').filter(Boolean);
      const base = `/${parts.slice(0, 3).join('/')}`;
      const cfg = servers[parts[2]] || {};
      if (url.pathname.endsWith('/enc.key')) { keyCalls.push(url.pathname); return new Response(KEY_BYTES); }
      if (url.pathname.endsWith('/master.m3u8')) { playlistCalls.push(url.pathname); return new Response(context?.mediaKind === 'movie' ? movieMaster(base) : tvMaster(base)); }
      if (/\/v\d+\/index\.m3u8$/.test(url.pathname)) { playlistCalls.push(url.pathname); return new Response(videoLeaf(base, cfg)); }
      if (url.pathname.endsWith('/audio/en.m3u8')) { playlistCalls.push(url.pathname); return new Response(audioLeaf(base)); }
      if (url.pathname.endsWith('/subs/forced.vtt')) return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello\n');
      if (url.pathname.endsWith('.ts')) { segmentCalls.push(url.pathname); return new Response(encrypt(videoPlain(cfg))); }
      if (url.pathname.endsWith('.aac')) { segmentCalls.push(url.pathname); return new Response(encrypt(adtsPlain())); }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, apiCalls, keyCalls, segmentCalls, playlistCalls, context: () => context };
};

const policy = (overrides = {}) => () => ({ order: ['cinema', 'cinejoy'], enabled: ['cinema', 'cinejoy'], providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0, ...overrides });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('movie: a cookiebakers POST with a valid minute-bucket token serves an AES-encrypted TS chain', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.provider, 'cinema');
  assert.equal(out.kind, 'movie');
  assert.equal(out.tmdb, 1368337);
  assert.equal(out.server, 'cookiebakers');
  assert.equal(out.master, `${CDN}/play/movie-1368337/cookiebakers/master.m3u8`);
  assert.deepEqual(fixture.apiCalls, [{ server: 'cookiebakers', path: '/api/cookiebakers/movie/1368337', method: 'POST' }]);
  assert.equal(fixture.keyCalls.length, 1, 'the 16-byte key file is fetched for the AES leaf');
  assert.equal(fixture.segmentCalls.length, 1, 'the first segment is read and decrypts to MPEG-TS (accept)');
});

test('tv: a cookiebakers POST with the exact s/e path serves the audio-grouped chain', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 84773, kind: 'series', season: 1, episode: 1, provider: 'cinema' });
  assert.equal(out.provider, 'cinema');
  assert.equal(out.kind, 'series');
  assert.equal(out.tmdb, 84773);
  assert.equal(out.season, 1);
  assert.equal(out.episode, 1);
  assert.equal(out.server, 'cookiebakers');
  assert.equal(out.master, `${CDN}/play/tv-84773-1-1/cookiebakers/master.m3u8`);
  assert.deepEqual(fixture.apiCalls, [{ server: 'cookiebakers', path: '/api/cookiebakers/tv/84773/1/1', method: 'POST' }]);
  assert.ok(fixture.playlistCalls.some(p => p.endsWith('/audio/en.m3u8')), 'the default audio group playlist is validated');
  assert.equal(fixture.segmentCalls.length, 2, 'video and audio leaves each validate a decrypted segment');
});

test('failover: a cookiebakers 404 walks the GET mirrors in site order', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { status: 404 }, ngcloud: { status: 404 }, tcloud: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.server, 'tcloud');
  assert.equal(out.master, `${CDN}/play/movie-1368337/tcloud/master.m3u8`);
  assert.deepEqual(fixture.apiCalls.map(c => `${c.server}:${c.method}`), ['cookiebakers:POST', 'ngcloud:GET', 'tcloud:GET']);
});

test('tv: the series chain skips the movie-only ngcloud mirror', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { status: 404 }, tcloud: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 84773, kind: 'series', season: 1, episode: 1, provider: 'cinema' });
  assert.equal(out.server, 'tcloud');
  assert.deepEqual(fixture.apiCalls.map(c => c.path), ['/api/cookiebakers/tv/84773/1/1', '/api/tcloud/tv/84773/1/1']);
});

test('no coverage: all servers 404 fails with per-server evidence and the next provider serves', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { status: 404 }, ngcloud: { status: 404 }, tcloud: { status: 404 }, ipcloud: { status: 404 }, dcloud: { status: 404 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie' });
  assert.equal(out.provider, 'cinejoy');
  assert.match(out.provider_errors.cinema, /Cinema \(BZ\) has no movie 1368337/);
  assert.match(out.provider_errors.cinema, /cookiebakers \(HTTP 404\)/);
  assert.match(out.provider_errors.cinema, /dcloud \(HTTP 404\)/);
});

test('token: a 401 rejection fails fast with rotation evidence instead of burning every mirror', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { fourOhOne: true }, tcloud: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  let caught;
  try { await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' }); } catch (error) { caught = error; }
  assert.ok(caught, 'a token rejection must fail the pinned provider');
  assert.match(caught.provider_errors.cinema, /HTTP 401.*rotated/);
  assert.equal(fixture.apiCalls.length, 1, 'no further mirrors are tried after a token rejection');
});

test('bait: a dying server\'s AES leaf decrypts to HTML and the next mirror\'s real chain serves', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { segment: 'html' }, ngcloud: { status: 404 }, tcloud: {}, ipcloud: { status: 404 }, dcloud: { status: 404 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.server, 'tcloud');
  assert.equal(fixture.segmentCalls.length, 2, 'the baited segment is read and rejected, then the real one is read and accepted');
});

test('bait: a dying server\'s first segment is a PNG image and the next mirror serves', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { segment: 'png' }, ngcloud: { status: 404 }, tcloud: {}, ipcloud: { status: 404 }, dcloud: { status: 404 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.server, 'tcloud');
  assert.equal(fixture.segmentCalls.length, 2);
});

test('encryption: a SAMPLING leaf is refused as unsupported and the next mirror serves', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { keyMethod: 'SAMPLING' }, ngcloud: { status: 404 }, tcloud: {}, ipcloud: { status: 404 }, dcloud: { status: 404 } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.server, 'tcloud');
});

test('jxe: a plain https stream URL passes the decode through untouched', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: { passThrough: true } } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy() });
  const out = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(out.server, 'cookiebakers');
  assert.equal(out.master, `${CDN}/play/movie-1368337/cookiebakers/master.m3u8`);
});

test('cache: a repeat resolve is served from the resolver cache; fresh revalidates', async () => {
  const fixture = cinemaFetch({ servers: { cookiebakers: {} } });
  const resolve = createProviderResolver({ fetchResource: fixture.fetchResource, cinejoy: cinejoyStub(), getPolicy: policy({ cacheSeconds: 60 }) });
  const first = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(first.cached, false);
  const second = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema' });
  assert.equal(second.cached, true);
  assert.equal(fixture.apiCalls.length, 1, 'the cache serves the repeat resolve without an upstream call');
  const fresh = await resolve({ tmdb: 1368337, kind: 'movie', provider: 'cinema', fresh: true });
  assert.equal(fresh.cached, false);
  assert.equal(fixture.apiCalls.length, 2, 'fresh forces an upstream revalidation');
});

// The settings store is a process singleton pinned to its data directory at
// first import, so the IPTV test pins the directory before importing it.
let iptvDirectory = null;
const ensureIptvDirectory = async () => {
  if (!iptvDirectory) {
    iptvDirectory = await mkdtemp(join(tmpdir(), 'watchlocal-cinema-iptv-'));
    process.env.WATCHLOCAL_DATA_DIR = iptvDirectory;
  }
  return iptvDirectory;
};

test('iptv: the ../enc.key chain is relayed as signed local assets and the relayed segment decrypts to TS', async () => {
  const directory = await ensureIptvDirectory();
  const original = globalThis.fetch;
  let server;
  try {
    const fixture = cinemaFetch({ servers: { cookiebakers: {} } });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['cinema'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    // tmdb 1368340: a fresh key, so this resolves from the fixture instead of
    // any cache populated by the resolver tests above.
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/1368340.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.doesNotMatch(master, /cookiebakers23blog|cinema\.army/i, 'no upstream host may appear in the rewritten master');
    const variantURL = new URL(master.split('\n').find(line => line.startsWith('http')), base).href;
    const variant = await original(variantURL);
    assert.equal(variant.status, 200);
    const variantText = await variant.text();
    assert.doesNotMatch(variantText, /cookiebakers23blog|cinema\.army/i, 'no upstream host may appear in the rewritten leaf');
    const keyLine = variantText.split('\n').find(line => line.startsWith('#EXT-X-KEY:'));
    assert.ok(keyLine, 'the KEY tag survives the rewrite');
    assert.match(keyLine, /METHOD=AES-128/);
    assert.match(keyLine, /IV=0x43a6d967d5c17290d98322f5c8f6660b/i, 'the static IV survives the rewrite');
    const keyRef = keyLine.match(/URI="([^"]+)"/)[1];
    const keyURL = new URL(keyRef, base).href;
    const key = await original(keyURL);
    assert.equal(key.status, 200);
    const keyBytes = Buffer.from(await key.arrayBuffer());
    assert.equal(keyBytes.length, 16, 'the relayed key is the raw 16-byte AES-128 file');
    const segmentURL = new URL(variantText.split('\n').find(line => line.startsWith('http') && !line.includes('enc.key')), base).href;
    const segment = await original(segmentURL);
    assert.equal(segment.status, 200);
    const cipherBytes = Buffer.from(await segment.arrayBuffer());
    assert.equal(cipherBytes.length % 16, 0, 'the relayed segment is AES-128-CBC ciphertext');
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, IV_BYTES);
    const plain = Buffer.concat([decipher.update(cipherBytes.subarray(0, cipherBytes.length - cipherBytes.length % 16)), decipher.final()]);
    assert.equal(plain[0], 0x47, 'the relayed segment decrypts to MPEG-TS, not HTML or an image');
    assert.equal(plain[188], 0x47);
    assert.equal(plain[376], 0x47);
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
