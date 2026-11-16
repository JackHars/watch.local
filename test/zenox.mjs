import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderResolver } from '../api/providers.mjs';

// Zenox (zenox.lol) fixture — mirrors the live-verified contract
// (evidence artifact f66c2b8d06da, re-verified live 2026-11-16):
//
//   * the playback-session API at https://zenox.lol/api/v1/playback/session
//     takes { mediaType: 'movie'|'tv', mediaId, season, episode,
//     autoUseCommunity, serverIndex, serverName } for the six bundle source
//     table (primary 2 / orion 3 / sienna 4 / delta 0 / atlas 7 / vbot 9) and
//     answers { success, streamUrl } where streamUrl is a SERVER-issued
//     signed path (/api/s/<source>/<type>/<id>[/<s>/<e>]?s=<sig>&t=<unix>);
//   * the signature is opaque (a client-side FNV re-derivation answers
//     403), so the resolver must use the returned URL as-is;
//   * the signed path serves an HLS master whose variant and audio-group
//     URIs are absolute on the operator's media proxy (banned.hls-m3u8.lol,
//     served here on a .test host): video is a keyless VOD media playlist
//     with no #EXT-X-MAP and self-describing fMP4 segments (styp brand
//     msdh); the separate audio group has a #EXT-X-MAP init;
//   * availability is enforced upstream at playlist fetch: an unknown
//     title's stream URL answers 502 { code: 'resolver_upstream_failed',
//     upstreamStatus: 404 } — exact keying, honest failure, no
//     substitution; the streamUrl path echoes the requested id and the
//     resolver rejects a mismatched echo.
const SITE = 'https://zenox.lol';
const CDN_HOST = 'cdn-zn-fixture.test';
const CDN = `https://${CDN_HOST}`;
const UA_RE = /Mozilla\/5\.0/;
const SOURCES = ['primary', 'orion', 'sienna', 'delta', 'atlas', 'vbot'];

// Self-describing fMP4 fragment shape: styp box (brand msdh) + moof.
const fmp4 = () => Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x73, 0x74, 0x79, 0x70,
  0x6d, 0x73, 0x64, 0x68, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x66,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
// fMP4 init segment (ftyp isom) for the audio playlist's #EXT-X-MAP.
const ftyp = () => Uint8Array.from([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
]);
const PNG_BAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML_BAIT = '<html><body>404 Not Found</body></html>';

// The upstream resolver's honest "title unknown on this source" body.
const upstream404 = (source) => JSON.stringify({
  error: 'No playable stream available on this source',
  source,
  stage: 'resolve',
  code: 'resolver_upstream_failed',
  upstreamStatus: 404,
});
// The signed-path signature rejection (client-side FNV never works).
const sigRejected = JSON.stringify({ error: '403', message: 'Client-side FNV rejected' });

const videoLeaf = (base) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
  `#EXTINF:4.010667,\n${base}/seg0.m4s\n#EXTINF:4.010667,\n${base}/seg1.m4s\n#EXT-X-ENDLIST\n`;
const audioLeaf = (base) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
  `#EXT-X-MAP:URI="${base}/audio-init.mp4"\n#EXTINF:4.010667,\n${base}/aseg0.m4s\n#EXT-X-ENDLIST\n`;
// Master: descending variants like the live masters; every variant
// references the audio group, which is how the site muxes playback.
const master = (base) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${base}/audio.m3u8"\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=8128000,RESOLUTION=1920x1080,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"\n${base}/v1080.m3u8\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=853000,RESOLUTION=640x360,FRAME-RATE=23.976,CODECS="avc1.4D001E,mp4a.40.2",AUDIO="audio"\n${base}/v360.m3u8\n` +
  '#EXT-X-ENDLIST\n';

// Per-test knobs. Every per-source entry may carry:
//   session: { status? } raw session status, { body? } raw JSON session
//             body, { streamUrl? } override the signed path
//   master:  { status? } raw status, { body? } raw JSON body, { html? }
//             HTML bait
//   cdn:     { segBait: 'png'|'html', audioInitBait: 'html' }
function zenoxFetch({ servers = {} } = {}) {
  const sessionCalls = [];
  const masterCalls = [];
  const cdnCalls = [];

  const fetchResource = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = options.headers || {};
    const method = options.method || 'GET';
    if (url.hostname === 'zenox.lol') {
      if (url.pathname === '/api/v1/playback/session') {
        const body = options.body ? JSON.parse(options.body) : null;
        sessionCalls.push({ method, body, headers });
        const key = sourceKeyFrom(body?.serverIndex);
        const cfg = servers[key] || {};
        if (cfg.session?.status) {
          return new Response(`upstream ${cfg.session.status}`, { status: cfg.session.status, headers: { 'content-type': 'application/json' } });
        }
        const echo = body.mediaType === 'tv'
          ? `/api/s/${key}/tv/${body.mediaId}/${body.season ?? 1}/${body.episode ?? 1}?s=sig-${key}&t=1234`
          : `/api/s/${key}/movie/${body.mediaId}?s=sig-${key}&t=1234`;
        const respBody = cfg.session?.body ?? { success: true, streamUrl: cfg.session?.streamUrl ?? echo, streamType: 'hls', expiresIn: 3600, sessionId: `sess-${key}` };
        return new Response(JSON.stringify(respBody), { status: cfg.session?.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      const match = url.pathname.match(/^\/api\/s\/(primary|orion|sienna|delta|atlas|vbot)\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?$/);
      if (match) {
        masterCalls.push({ key: match[1], path: url.pathname, query: url.search, headers });
        const cfg = servers[match[1]] || {};
        if (cfg.master?.html) return new Response(HTML_BAIT, { status: 200, headers: { 'content-type': 'text/html' } });
        if (cfg.master?.status) {
          return new Response(cfg.master?.body ?? cfg.master?.status.toString(), { status: cfg.master.status, headers: { 'content-type': 'application/json' } });
        }
        // The live proxy mislabels playlists; the central code reads bytes,
        // never the label.
        return new Response(master(`${CDN}/${match[1]}`), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      }
      return new Response('not found', { status: 404 });
    }
    if (url.hostname === CDN_HOST) {
      // Every CDN path is source-scoped: /<source>/...
      const [key, ...rest] = url.pathname.split('/').filter(Boolean);
      const cfg = servers[key]?.cdn || {};
      const rel = rest.join('/');
      cdnCalls.push({ key, path: url.pathname, headers });
      if (rel === 'audio.m3u8') return new Response(audioLeaf(`${CDN}/${key}`), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      if (rel === 'v1080.m3u8' || rel === 'v360.m3u8') return new Response(videoLeaf(`${CDN}/${key}/${rel.replace('.m3u8', '')}`), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      if (rel === 'audio-init.mp4') {
        return new Response(cfg.audioInitBait === 'html' ? HTML_BAIT : ftyp(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (rel.endsWith('.m4s')) {
        if (cfg.segBait === 'png') return new Response(PNG_BAIT, { status: 200, headers: { 'content-type': 'video/mp4' } });
        if (cfg.segBait === 'html') return new Response(HTML_BAIT, { status: 200, headers: { 'content-type': 'video/mp4' } });
        return new Response(fmp4(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response(`unexpected host ${url.hostname}`, { status: 404 });
  };

  const resolve = createProviderResolver({
    fetchResource,
    getPolicy: () => ({
      enabled: ['zenox'],
      order: ['zenox'],
      providerTimeout: 5,
      totalTimeout: 10,
      cacheSeconds: 60,
    }),
  });
  return { resolve, sessionCalls, masterCalls, cdnCalls };
}

function sourceKeyFrom(id) {
  return ({ 2: 'primary', 3: 'orion', 4: 'sienna', 0: 'delta', 7: 'atlas', 9: 'vbot' })[id];
}

// The platform wraps adapter failures: the thrown message is the generic
// 502 text and the per-provider detail lands in error.provider_errors.
async function zenoxError(promise) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'expected rejection');
  assert.equal(error.status, 502);
  assert.equal(error.message, 'No provider returned playable HLS');
  assert.match(error.provider_errors?.zenox || '', /no playable source/);
  return error;
}

test('zenox movie: exact session body, identity echo, signed master, fMP4 chain, audio group', async () => {
  const { resolve, sessionCalls, masterCalls, cdnCalls } = zenoxFetch();
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.deepEqual(sessionCalls.map(c => c.body), [{
    mediaType: 'movie', mediaId: 550, season: 1, episode: 1,
    autoUseCommunity: false, serverIndex: 2, serverName: 'Primary',
  }]);
  assert.equal(sessionCalls[0].method, 'POST');
  assert.match(sessionCalls[0].headers['content-type'], /^application\/json/);
  assert.match(sessionCalls[0].headers['user-agent'], UA_RE);
  assert.equal(sessionCalls[0].headers.referer, `${SITE}/media/`);
  assert.equal(masterCalls.length, 1);
  assert.equal(masterCalls[0].key, 'primary');
  assert.equal(masterCalls[0].path, '/api/s/primary/movie/550');
  assert.match(masterCalls[0].query, /^\?s=sig-primary&t=1234$/);
  for (const call of [masterCalls[0], ...cdnCalls]) {
    assert.match(call.headers['user-agent'], UA_RE);
    assert.equal(call.headers.referer, `${SITE}/media/`);
  }
  assert.match(out.master, /^https:\/\/zenox\.lol\/api\/s\/primary\/movie\/550\?s=sig-primary&t=1234$/);
  assert.equal(out.server, 'primary');
  assert.equal(out.variants[0].width, 1920);
  assert.equal(out.variants[1].width, 640);
  assert.equal(out.kind, 'movie');
  assert.equal(out.streams[0].type, 'hls');
  assert.equal(out.streams[0].id, 'primary');
  assert.equal(out.streams[0].playlist, out.master);
  // Audio group: accept() validates the DEFAULT track internally (init +
  // segment below) without exposing it in the result shape.
  // Video leaf: two fMP4 segments verified; audio leaf: init + segment.
  assert.ok(cdnCalls.some(c => c.path === '/primary/v1080.m3u8'));
  assert.ok(cdnCalls.some(c => c.path === '/primary/v1080/seg0.m4s'));
  assert.ok(cdnCalls.some(c => c.path === '/primary/audio.m3u8'));
  assert.ok(cdnCalls.some(c => c.path === '/primary/audio-init.mp4'));
  assert.ok(cdnCalls.some(c => c.path === '/primary/aseg0.m4s'));
});

test('zenox series: tv mediaType, real season/episode, /tv/<id>/<s>/<e> echo', async () => {
  const { resolve, sessionCalls, masterCalls } = zenoxFetch();
  const out = await resolve({ kind: 'series', tmdb: 550, season: 1, episode: 2 });
  assert.deepEqual(sessionCalls.map(c => c.body), [{
    mediaType: 'tv', mediaId: 550, season: 1, episode: 2,
    autoUseCommunity: false, serverIndex: 2, serverName: 'Primary',
  }]);
  assert.equal(masterCalls[0].path, '/api/s/primary/tv/550/1/2');
  assert.match(out.master, /^https:\/\/zenox\.lol\/api\/s\/primary\/tv\/550\/1\/2\?s=sig-primary&t=1234$/);
});

test('zenox season 0: passed through exactly', async () => {
  const { resolve, sessionCalls, masterCalls } = zenoxFetch();
  const out = await resolve({ kind: 'series', tmdb: 550, season: 0, episode: 3 });
  assert.deepEqual([sessionCalls[0].body.season, sessionCalls[0].body.episode], [0, 3]);
  assert.equal(masterCalls[0].path, '/api/s/primary/tv/550/0/3');
  assert.match(out.master, /tv\/550\/0\/3\?/);
});

test('zenox failover: 503 session, source_error body, then healthy sienna', async () => {
  const { resolve, sessionCalls, masterCalls } = zenoxFetch({
    servers: {
      primary: { session: { status: 503 } },
      orion: { session: { body: { success: false, code: 'source_error', error: 'Source error' } } },
    },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'sienna');
  assert.deepEqual(sessionCalls.map(c => sourceKeyFrom(c.body.serverIndex)), ['primary', 'primary', 'orion', 'sienna']);
  assert.equal(masterCalls.length, 1);
  assert.equal(masterCalls[0].key, 'sienna');
});

test('zenox unavailable title: 502 upstream 404 on every source fails honestly', async () => {
  const servers = {};
  for (const key of SOURCES) servers[key] = { master: { status: 502, body: upstream404(key) } };
  const { resolve, sessionCalls, masterCalls, cdnCalls } = zenoxFetch({ servers });
  const error = await zenoxError(resolve({ kind: 'movie', tmdb: 424242 }));
  // The upstream resolver's honest 502 (upstream 404 body) surfaces as a
  // plain HTTP status; the tell-tale is that NO media was ever served.
  for (const key of ['primary', 'orion', 'sienna']) {
    assert.match(error.provider_errors.zenox, new RegExp(`${key}: HTTP 502`));
  }
  assert.equal(sessionCalls.length, 6);
  assert.equal(masterCalls.length, 12); // read() retries 5xx once per source
  assert.equal(cdnCalls.length, 0);
});

test('zenox signature rejection: 403 FNV body on every source, no retry', async () => {
  const servers = {};
  for (const key of SOURCES) servers[key] = { master: { status: 401, body: sigRejected } };
  const { resolve, masterCalls } = zenoxFetch({ servers });
  const error = await zenoxError(resolve({ kind: 'movie', tmdb: 550 }));
  assert.match(error.provider_errors.zenox, /primary: HTTP 401/);
  assert.equal(masterCalls.length, 6); // 401 is not retried
});

test('zenox mismatched streamUrl echo is rejected before accept', async () => {
  const { resolve, sessionCalls, masterCalls } = zenoxFetch({
    servers: { primary: { session: { streamUrl: '/api/s/primary/movie/999?s=sig-primary&t=1234' } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'orion');
  assert.equal(masterCalls[0].key, 'orion');
  assert.equal(sessionCalls.length, 2);
});

test('zenox video segment bait (PNG) fails the source and fails over', async () => {
  const { resolve, masterCalls } = zenoxFetch({
    servers: { primary: { cdn: { segBait: 'png' } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'orion');
  assert.equal(masterCalls.length, 2);
});

test('zenox audio init bait (HTML) fails the source and fails over', async () => {
  const { resolve, masterCalls } = zenoxFetch({
    servers: { primary: { cdn: { audioInitBait: 'html' } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'orion');
  assert.equal(masterCalls.length, 2);
});

test('zenox master HTML bait fails the source and fails over', async () => {
  const { resolve, masterCalls } = zenoxFetch({
    servers: { primary: { master: { html: true } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'orion');
  assert.equal(masterCalls.length, 2);
});

test('zenox all sources dead: combined error lists the first three', async () => {
  const servers = {};
  for (const key of SOURCES) servers[key] = { session: { status: 502 } };
  const { resolve, sessionCalls } = zenoxFetch({ servers });
  const error = await zenoxError(resolve({ kind: 'series', tmdb: 550, season: 1, episode: 1 }));
  assert.match(error.provider_errors.zenox, /primary: HTTP 502/);
  assert.match(error.provider_errors.zenox, /orion: HTTP 502/);
  assert.match(error.provider_errors.zenox, /sienna: HTTP 502/);
  assert.deepEqual(sessionCalls.map(c => sourceKeyFrom(c.body.serverIndex)),
    ['primary', 'primary', 'orion', 'orion', 'sienna', 'sienna', 'delta', 'delta', 'atlas', 'atlas', 'vbot', 'vbot']);
});
