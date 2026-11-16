import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderResolver } from '../api/providers.mjs';
import { extractBridgeMasterUrl, cdnPathParts } from '../api/bingr.mjs';

// Bingr (bingr.st / bingr.one) fixture — mirrors the live-verified contract
// (evidence artifact c2fc869bdc64, re-verified live 2026-11-16):
//
//   * the SSR watch pages (/watch/movie/<id>, /watch/tv/<id>/<s>/<e>) embed
//     a pre-signed CloudFront "bridge" master playlist as a
//     <link rel="preload" href="..."> on
//     dash-hls-bridge.johndoesdmc.workers.dev — the URL's url= param is the
//     absolute CDN master on sacdn.hakunaymatata.com (path
//     /dash/<contentId>_<s>_<e>_<quality>_<codec>_<bitrate>/master.m3u8);
//   * a bare GET of the bridge URL answers an HLS v7 master (video variants
//     plus one DEFAULT audio group); rendition and audio URIs point back at
//     the bridge, which serves the CDN playlists; all CloudFront signatures
//     (master, playlists, segments, inits) are issued server-side in the
//     page — no client-side crypto anywhere;
//   * media is keyless fragmented MP4 (#EXT-X-MAP init ftyp, .m4s styp,
//     no #EXT-X-KEY);
//   * the site is exact-keyed: unknown titles, out-of-range season/episode
//     and type mismatches render the bare home page with NO signed master;
//   * the resolver requires the page's own echoes — RSC state
//     kind+tmdbId(+S/E), the "· S<n> E<n>" title, and the CDN path's
//     <s>_<e> components — to match the requested identity, and fails over
//     to the bingr.one mirror when an origin omits the signed master
//     (worker-dependent SSR).
const SITE = 'https://bingr.st';
const MIRROR = 'https://bingr.one';
const BRIDGE_HOST = 'dash-hls-bridge.johndoesdmc.workers.dev';
const CDN_HOST = 'sacdn.hakunaymatata.com';
const CDN = `https://${CDN_HOST}`;
const BRIDGE = `https://${BRIDGE_HOST}`;
const UA_RE = /Mozilla\/5\.0/;

const fmp4 = () => Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x73, 0x74, 0x79, 0x70,
  0x6d, 0x73, 0x64, 0x68, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x66,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const ftyp = () => Uint8Array.from([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
]);
const PNG_BAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML_BAIT = '<html><body>404 Not Found</body></html>';

const SIGN = 'Policy=***&Signature=***&Key-Pair-Id=***';
const SIGN_HTML = 'Policy=***&amp;Signature=***&amp;Key-Pair-Id=***';
const enc = (s) => encodeURIComponent(s);

// Per-origin CDN content build ids (the mirror serves the same catalog on
// its own CDN node); everything else about the two origins is identical.
const PREFIX = { st: '9001', one: '9101' };

function bridgeUrl(build) {
  return `${BRIDGE}/?url=${enc(`${CDN}/dash/${build}/master.m3u8`)}&${SIGN_HTML}`;
}
function pageFor({ id, kind, season = 1, episode = 1, origin, knobs = {} }) {
  const isMovie = kind === 'movie';
  const s = isMovie ? 1 : (season ?? 1);
  const e = isMovie ? 1 : (episode ?? 1);
  const home = knobs.home;
  if (home) {
    return '<html><head><title>Bingr — Movies, Shows, Anime &amp; Live Sports</title></head><body><div id="root"></div></body></html>';
  }
  const title = knobs.title ?? (isMovie ? 'Binging: Fight Club' : `Binging: Rings of Power · S${s} E${e}`);
  const build = knobs.cdnPath ?? (isMovie
    ? `${PREFIX[origin]}_0_0_1080_h265_660`
    : `${PREFIX[origin]}_${s}_${e}_1080_h265_808`);
  const state = isMovie
    ? `\\"kind\\":\\"movie\\",\\"tmdbId\\":\\"${id}\\"`
    : `\\"kind\\":\\"tv\\",\\"tmdbId\\":\\"${id}\\",\\"season\\":${s},\\"episode\\":${e}`;
  let html = `<html><head><title>${title}</title>`;
  if (!knobs.noPreload) {
    html += `<link rel="preload" href="${bridgeUrl(build)}">`;
  } else {
    // Worker-dependent SSR: the signed master is only in the RSC flight
    // payload (JSON-escaped inside the JS string).
    html += `<script>window.__RSC$=[["$","$HL","${BRIDGE}/?url=${enc(`${CDN}/dash/${build}/master.m3u8`)}\\\\u0026Policy=***\\\\u0026Signature=***\\\\u0026Key-Pair-Id=***"]];</script>`;
  }
  html += `</head><body><div id="root"><script>var state = {${state}};</script></div></body></html>`;
  return html;
}

const videoLeaf = (build) => {
  const b = `${CDN}/dash/${build}`;
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
    `#EXT-X-MAP:URI="${b}/init.mp4?${SIGN}"\n` +
    `#EXTINF:4.002000,\n${b}/seg0.m4s?${SIGN}\n#EXTINF:4.002000,\n${b}/seg1.m4s?${SIGN}\n#EXT-X-ENDLIST\n`;
};
const audioLeaf = (build) => {
  const b = `${CDN}/dash/${build}`;
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
    `#EXT-X-MAP:URI="${b}/audio-init.mp4?${SIGN}"\n#EXTINF:4.002000,\n${b}/aseg0.m4s?${SIGN}\n#EXT-X-ENDLIST\n`;
};
const master = (build) => {
  const b = (p) => `${BRIDGE}/?url=${enc(`${CDN}/dash/${build}/${p}`)}&${SIGN_HTML}`;
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${b('audio.m3u8')}"\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=8128000,RESOLUTION=1920x1080,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"\n${b('v1080.m3u8')}\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=853000,RESOLUTION=640x360,FRAME-RATE=23.976,CODECS="avc1.4D001E,mp4a.40.2",AUDIO="audio"\n${b('v360.m3u8')}\n` +
    '#EXT-X-ENDLIST\n';
};

function bingrFetch({ origins = {} } = {}) {
  const pageCalls = [];
  const bridgeCalls = [];
  const cdnCalls = [];

  const fetchResource = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = options.headers || {};
    const originKey = url.hostname === 'bingr.st' ? 'st' : url.hostname === 'bingr.one' ? 'one' : null;
    if (originKey) {
      pageCalls.push({ origin: originKey, path: url.pathname, headers });
      const knobs = origins[originKey] || {};
      if (knobs.status) return new Response(`upstream ${knobs.status}`, { status: knobs.status, headers: { 'content-type': 'text/html' } });
      const isMovie = url.pathname.startsWith('/watch/movie/');
      const m = isMovie
        ? url.pathname.match(/^\/watch\/movie\/(\d+)$/)
        : url.pathname.match(/^\/watch\/tv\/(\d+)\/(\d+)\/(\d+)$/);
      if (!m) return new Response('not found', { status: 404 });
      const id = m[1];
      const season = isMovie ? 1 : Number(m[2]);
      const episode = isMovie ? 1 : Number(m[3]);
      return new Response(pageFor({ id, kind: isMovie ? 'movie' : 'series', season, episode, origin: originKey, knobs }),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.hostname === BRIDGE_HOST) {
      const inner = url.searchParams.get('url') || '';
      bridgeCalls.push({ query: url.search, inner, headers });
      const build = inner.match(/\/dash\/([^/]+)\/(master|v\d+|audio)\.m3u8$/);
      if (!build) return new Response('not found', { status: 404 });
      if (build[2] === 'master') return new Response(master(build[1]), { status: 200, headers: { 'content-type': 'application/x-mpegURL' } });
      if (build[2] === 'audio') return new Response(audioLeaf(build[1]), { status: 200, headers: { 'content-type': 'application/x-mpegURL' } });
      return new Response(videoLeaf(build[1]), { status: 200, headers: { 'content-type': 'application/x-mpegURL' } });
    }
    if (url.hostname === CDN_HOST) {
      const m = url.pathname.match(/^\/dash\/([^/]+)\/([^/]+)$/);
      const origin = m && m[1].startsWith(PREFIX.one) ? 'one' : 'st';
      cdnCalls.push({ origin, path: url.pathname, query: url.search, headers });
      const cfg = origins[origin]?.cdn || {};
      if (m && (m[2] === 'init.mp4' || m[2] === 'audio-init.mp4')) {
        return new Response(cfg.audioInitBait === 'html' ? HTML_BAIT : ftyp(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (m && m[2].endsWith('.m4s')) {
        if (cfg.segBait === 'png') return new Response(PNG_BAIT, { status: 200, headers: { 'content-type': 'video/mp4' } });
        if (cfg.segBait === 'html') return new Response(HTML_BAIT, { status: 200, headers: { 'content-type': 'video/mp4' } });
        return new Response(fmp4(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
    }
    return new Response(`unexpected host ${url.hostname}`, { status: 404 });
  };

  const resolve = createProviderResolver({
    fetchResource,
    getPolicy: () => ({
      enabled: ['bingr'],
      order: ['bingr'],
      providerTimeout: 5,
      totalTimeout: 10,
      cacheSeconds: 60,
    }),
  });
  return { resolve, pageCalls, bridgeCalls, cdnCalls };
}

// The platform wraps adapter failures: the thrown message is the generic
// 502 text and the per-provider detail lands in error.provider_errors.
async function bingrError(promise) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'expected rejection');
  assert.equal(error.status, 502);
  assert.equal(error.message, 'No provider returned playable HLS');
  assert.match(error.provider_errors?.bingr || '', /Bingr has no playable source/);
  return error;
}

test('bingr movie: exact path, identity echoes, signed bridge master, fMP4 chain, audio group', async () => {
  const { resolve, pageCalls, bridgeCalls, cdnCalls } = bingrFetch();
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0].origin, 'st');
  assert.equal(pageCalls[0].path, '/watch/movie/550');
  assert.match(pageCalls[0].headers['user-agent'], UA_RE);
  assert.equal(pageCalls[0].headers.referer, `${SITE}/home`);
  assert.equal(bridgeCalls.length, 3); // master + video leaf + audio leaf
  for (const call of bridgeCalls) {
    for (const part of ['url=', 'Policy=***', 'Signature=***', 'Key-Pair-Id=***']) {
      assert.ok(call.query.includes(part), `bridge query missing ${part}: ${call.query}`);
    }
    assert.match(call.headers['user-agent'], UA_RE);
    assert.equal(call.headers.referer, `${SITE}/home`);
  }
  assert.ok(out.master.startsWith(`https://${BRIDGE_HOST}/?url=`), out.master);
  assert.ok(out.master.includes(`${PREFIX.st}_0_0_`), out.master);
  assert.ok(out.master.includes('master.m3u8&Policy=***'), out.master);
  assert.equal(out.server, 'bingr.st');
  assert.equal(out.kind, 'movie');
  assert.equal(out.variants[0].width, 1920);
  assert.equal(out.variants[1].width, 640);
  assert.equal(out.streams[0].type, 'hls');
  assert.equal(out.streams[0].playlist, out.master);
  // Keyless fMP4 verified on the CDN (st-scoped build): video init +
  // segment, audio init + segment, each with a signed query.
  assert.ok(cdnCalls.some(c => c.origin === 'st' && c.path === `/dash/${PREFIX.st}_0_0_1080_h265_660/init.mp4` && c.query.startsWith('?') && c.query.includes('Signature=***')));
  assert.ok(cdnCalls.some(c => c.origin === 'st' && c.path === `/dash/${PREFIX.st}_0_0_1080_h265_660/seg0.m4s`));
  assert.ok(cdnCalls.some(c => c.origin === 'st' && c.path === `/dash/${PREFIX.st}_0_0_1080_h265_660/audio-init.mp4`));
  assert.ok(cdnCalls.some(c => c.origin === 'st' && c.path === `/dash/${PREFIX.st}_0_0_1080_h265_660/aseg0.m4s`));
});

test('bingr series: path-based season/episode, title and CDN-path echoes', async () => {
  const { resolve, pageCalls } = bingrFetch();
  const out = await resolve({ kind: 'series', tmdb: 84773, season: 1, episode: 2 });
  assert.equal(pageCalls[0].path, '/watch/tv/84773/1/2');
  assert.match(out.master, new RegExp(`${PREFIX.st}_1_2_1080_h265_808%2Fmaster\\.m3u8`));
  assert.equal(out.kind, 'series');
});

test('bingr season 0: passed through exactly, no clamping', async () => {
  const { resolve, pageCalls } = bingrFetch();
  const out = await resolve({ kind: 'series', tmdb: 84773, season: 0, episode: 3 });
  assert.equal(pageCalls[0].path, '/watch/tv/84773/0/3');
  assert.match(out.master, new RegExp(`${PREFIX.st}_0_3_`));
});

test('bingr RSC-only page: bridge recovered from the flight payload (no preload tag)', async () => {
  const { resolve, bridgeCalls } = bingrFetch({ origins: { st: { noPreload: true } } });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'bingr.st');
  assert.equal(bridgeCalls.length, 3);
  assert.ok(out.master.includes('url='));
});

test('bingr unknown title: home page without signed master on both origins fails honestly', async () => {
  const { resolve, pageCalls, bridgeCalls, cdnCalls } = bingrFetch({
    origins: { st: { home: true }, one: { home: true } },
  });
  const error = await bingrError(resolve({ kind: 'movie', tmdb: 424242 }));
  assert.match(error.provider_errors.bingr, /bingr\.st: no signed master in page/);
  assert.match(error.provider_errors.bingr, /bingr\.one: no signed master in page/);
  assert.equal(pageCalls.length, 2);
  assert.equal(bridgeCalls.length, 0);
  assert.equal(cdnCalls.length, 0);
});

test('bingr episode echo mismatch: title echoes a different episode, mirror takes over', async () => {
  const { resolve, pageCalls } = bingrFetch({
    origins: { st: { title: 'Binging: Rings of Power · S1 E1' } },
  });
  const out = await resolve({ kind: 'series', tmdb: 84773, season: 1, episode: 2 });
  assert.equal(out.server, 'bingr.one');
  assert.equal(pageCalls.length, 2);
  assert.match(out.master, new RegExp(`${PREFIX.one}_1_2_`));
});

test('bingr CDN path echo mismatch: build encodes a different episode, mirror takes over', async () => {
  const { resolve } = bingrFetch({
    origins: { st: { cdnPath: `${PREFIX.st}_1_1_1080_h265_808` } },
  });
  const out = await resolve({ kind: 'series', tmdb: 84773, season: 1, episode: 2 });
  assert.equal(out.server, 'bingr.one');
  assert.match(out.master, new RegExp(`${PREFIX.one}_1_2_`));
});

test('bingr mirror failover: primary page omits the signed master, mirror serves it', async () => {
  // noPreload on 'st' gives the RSC-only variant (still playable); use a
  // home page to model the worker-dependent SSR omission entirely.
  const { resolve, pageCalls } = bingrFetch({
    origins: { st: { home: true } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'bingr.one');
  assert.equal(pageCalls.length, 2);
  assert.match(out.master, new RegExp(`${PREFIX.one}_0_0_`));
});

test('bingr video segment bait (PNG) on the primary fails accept, mirror takes over', async () => {
  const { resolve, cdnCalls } = bingrFetch({
    origins: { st: { cdn: { segBait: 'png' } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'bingr.one');
  assert.ok(cdnCalls.some(c => c.origin === 'st' && c.path.endsWith('/seg0.m4s')));
  assert.ok(cdnCalls.some(c => c.origin === 'one' && c.path.endsWith('/seg0.m4s')));
});

test('bingr audio init bait (HTML) on the primary fails accept, mirror takes over', async () => {
  const { resolve } = bingrFetch({
    origins: { st: { cdn: { audioInitBait: 'html' } } },
  });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'bingr.one');
});

test('bingr both origins dead: 502 pages, combined error names both hosts', async () => {
  const { resolve, pageCalls } = bingrFetch({
    origins: { st: { status: 502 }, one: { status: 502 } },
  });
  const error = await bingrError(resolve({ kind: 'series', tmdb: 84773, season: 1, episode: 1 }));
  assert.match(error.provider_errors.bingr, /bingr\.st: HTTP 502/);
  assert.match(error.provider_errors.bingr, /bingr\.one: HTTP 502/);
  assert.equal(pageCalls.length, 4); // read() retries 5xx once per origin
});

test('extractBridgeMasterUrl: preload, RSC flight, and home page', async () => {
  // Preload tag (HTML-escaped ampersands).
  const preload = '<html><link rel="preload" href="https://dash-hls-bridge.johndoesdmc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F9_0_0_1080_h265_660%2Fmaster.m3u8&amp;Policy=***&amp;Signature=***&amp;Key-Pair-Id=***"></html>';
  const a = extractBridgeMasterUrl(preload);
  assert.ok(a && a.startsWith('https://dash-hls-bridge.johndoesdmc.workers.dev/?url='));
  assert.ok(a.includes('Policy=***&Signature=***&Key-Pair-Id=***'));
  // RSC flight payload (JSON-escaped: & as \\u0026, quotes as \\"), no tag.
  const rsc = `<script>window.__RSC$=[["$","$HL","${BRIDGE}/?url=${enc(`${CDN}/dash/9_0_0_1080_h265_660/master.m3u8`)}\\\\u0026Policy=***\\\\u0026Signature=***\\\\u0026Key-Pair-Id=***"]];</script>`;
  const b = extractBridgeMasterUrl(rsc);
  assert.ok(b && b.includes('url=') && b.includes('Policy=***&Signature=***&Key-Pair-Id=***'));
  // Home page: no signed master at all.
  assert.equal(extractBridgeMasterUrl('<html><head><title>Home</title></head><body></body></html>'), null);
});

test('cdnPathParts: decodes the bridge url= param into build components', async () => {
  const bridge = bridgeUrl('9001_2_5_1080_h265_808');
  assert.deepEqual(cdnPathParts(bridge), ['9001', '2', '5', '1080', 'h265', '808']);
  assert.equal(cdnPathParts('https://dash-hls-bridge.johndoesdmc.workers.dev/?Policy=***'), null);
  assert.equal(cdnPathParts('not a url'), null);
});
