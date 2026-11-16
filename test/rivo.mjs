import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderResolver } from '../api/providers.mjs';
import { hlsSources } from '../api/rivo.mjs';

// RIVO (rivo.st / f.rivo.st) fixture — mirrors the live-verified contract
// (evidence artifact 516f98c76982, re-verified live 2026-11-16):
//
//   * f.rivo.st serves the source API: GET /api/source/movie/<tmdbId> and
//     GET /api/source/tv/<tmdbId>?s=<season>&e=<episode> (the site's own
//     player bundle's query spelling) -> 200
//     { provider: 'rivo-backend', sources: [{ key, kind: 'hls'|'mp4',
//       quality, url }…] };
//   * unknown titles, out-of-range or absent season/episode, and type
//     mismatches -> { provider: 'none', sources: [] } — the backend never
//     substitutes;
//   * each hls source url is a signed (p param, opaque, ~600 s) HLS v7
//     master (m3u8-proxy.m3u8) on the 1..9.rivo.st proxy pool behind
//     CloudFront; variants answer VOD media playlists of mp2t .ts segments
//     (0x47 sync) — no #EXT-X-KEY, no #EXT-X-MAP, no audio groups;
//   * the pool is per-request unstable: nodes transiently return 5xx or
//     200 with non-playlist bodies, so the resolver fails over through the
//     source list, validating each master through the shared ctx.accept;
//   * direct mp4 sources exist for movies but are excluded (HLS is the
//     site's primary playback path);
//   * all API and media fetches carry a browser UA plus
//     Referer/Origin https://f.rivo.st/.
const API = 'https://f.rivo.st';
const UA_RE = /Mozilla\/5\.0/;

const mp2t = () => {
  const bytes = new Uint8Array(188 * 3);
  bytes[0] = 0x47; bytes[188] = 0x47; bytes[376] = 0x47;
  return bytes;
};
const PNG_BAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML_BAIT = '<html><body>404 Not Found</body></html>';

// Live-verified availability: 1400 carries only s1e1 and s0e3; 1396
// (Breaking Bad) carries s1e1 and s1e2 as distinct streams; movie ids are
// keyed bare. Everything else answers an empty source list.
const CATALOG = {
  movie: new Set(['1368337', '550']),
  tv: new Map([
    ['1400', new Set(['1-1', '0-3'])],
    ['1396', new Set(['1-1', '1-2'])],
  ]),
};

const sourceUrls = (isTv, id, season, episode) => {
  const q = isTv ? `${season}-${episode}` : '0-0';
  const base = `/rivo/media/${id}/${q}`;
  return [
    { key: 'source1', kind: 'hls', quality: '1080p', url: `https://1.rivo.st${base}/m3u8-proxy.m3u8?node=1&q=${q}&p=***` },
    { key: 'source2', kind: 'hls', quality: '1080p', url: `https://2.rivo.st${base}/m3u8-proxy.m3u8?node=2&q=${q}&p=***` },
    { key: 'source3', kind: 'mp4', quality: '1080p', url: `https://1.rivo.st${base}/moviebox.mp4?node=1&q=${q}&p=***` },
  ];
};

const master = () => `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=5853482,RESOLUTION=1920x1080,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2"
m3u8-1080-proxy.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3104895,RESOLUTION=1280x720,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2"
m3u8-720-proxy.m3u8
#EXT-X-ENDLIST
`;

const leaf = () => `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TARGETDURATION:6
#EXTINF:60.000000,
0.ts
#EXTINF:60.000000,
1.ts
#EXTINF:60.000000,
2.ts
#EXTINF:60.000000,
3.ts
#EXT-X-ENDLIST
`;

function rivoFetch({ knobs = {} } = {}) {
  const apiCalls = [];
  const poolCalls = [];

  const fetchResource = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = options.headers || {};
    if (url.hostname === 'f.rivo.st') {
      apiCalls.push({ path: url.pathname, query: url.search, headers });
      const k = knobs.api || {};
      if (k.status) return new Response('err', { status: k.status });
      const m = url.pathname.match(/^\/api\/source\/(movie|tv)\/(\d+)$/);
      if (!m) return new Response('not found', { status: 404 });
      const isTv = m[1] === 'tv';
      const id = m[2];
      const season = isTv ? url.searchParams.get('s') : null;
      const episode = isTv ? url.searchParams.get('e') : null;
      const available = isTv
        ? (CATALOG.tv.get(id)?.has(`${season}-${episode}`) ?? false)
        : CATALOG.movie.has(id);
      const provider = k.provider ?? (available ? 'rivo-backend' : 'none');
      const body = { provider, sources: available ? sourceUrls(isTv, id, season ?? 0, episode ?? 0) : [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const node = url.hostname === '1.rivo.st' ? 1 : url.hostname === '2.rivo.st' ? 2 : null;
    if (node) {
      poolCalls.push({ node, path: url.pathname, query: url.search, headers });
      const nk = knobs.nodes?.[node] || {};
      const name = url.pathname.split('/').pop();
      if (nk.status) return new Response('err', { status: nk.status });
      if (name === 'm3u8-proxy.m3u8') {
        if (nk.garbage) return new Response(HTML_BAIT, { status: 200, headers: { 'content-type': 'text/html' } });
        return new Response(master(), { status: 200, headers: { 'content-type': 'application/x-mpegURL' } });
      }
      if (name === 'm3u8-1080-proxy.m3u8' || name === 'm3u8-720-proxy.m3u8') {
        return new Response(leaf(), { status: 200, headers: { 'content-type': 'application/x-mpegURL' } });
      }
      if (name.endsWith('.ts')) {
        if (nk.segBait === 'png') return new Response(PNG_BAIT, { status: 200, headers: { 'content-type': 'video/mp2t' } });
        return new Response(mp2t(), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      }
    }
    return new Response(`unexpected host ${url.hostname}`, { status: 404 });
  };

  const resolve = createProviderResolver({
    fetchResource,
    getPolicy: () => ({
      enabled: ['rivo'],
      order: ['rivo'],
      providerTimeout: 5,
      totalTimeout: 10,
      cacheSeconds: 60,
    }),
  });
  return { resolve, apiCalls, poolCalls };
}

// The platform wraps adapter failures: the thrown message is the generic
// 502 text and the per-provider detail lands in error.provider_errors.
async function rivoError(promise) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'expected rejection');
  assert.equal(error.status, 502);
  assert.equal(error.message, 'No provider returned playable HLS');
  assert.match(error.provider_errors?.rivo || '', /RIVO has no playable source/);
  return error;
}

test('rivo movie: exact-keyed API, provider echo, keyless mp2t chain, signed master', async () => {
  const { resolve, apiCalls, poolCalls } = rivoFetch();
  const out = await resolve({ kind: 'movie', tmdb: 1368337 });
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].path, '/api/source/movie/1368337');
  assert.equal(apiCalls[0].query, '');
  assert.match(apiCalls[0].headers['user-agent'], UA_RE);
  assert.equal(apiCalls[0].headers.referer, `${API}/`);
  assert.equal(apiCalls[0].headers.origin, API);
  // One healthy source is enough: master + highest leaf + first segment,
  // all on the first pool node; the 720 leaf and the direct mp4 are never
  // touched.
  assert.equal(poolCalls.length, 3);
  for (const call of poolCalls) {
    assert.equal(call.node, 1);
    assert.match(call.headers['user-agent'], UA_RE);
    assert.equal(call.headers.referer, `${API}/`);
    assert.equal(call.headers.origin, API);
    assert.ok(!call.path.endsWith('moviebox.mp4'), 'mp4 source must be excluded');
    assert.ok(!call.path.endsWith('m3u8-720-proxy.m3u8'), 'non-best variant must not be fetched');
  }
  assert.equal(out.provider, 'rivo');
  assert.equal(out.kind, 'movie');
  assert.equal(out.server, 'source1');
  assert.ok(out.master.startsWith('https://1.rivo.st/rivo/media/1368337/0-0/m3u8-proxy.m3u8?node=1&q=0-0&p=***'), out.master);
  assert.equal(out.streams[0].type, 'hls');
  assert.equal(out.streams[0].playlist, out.master);
  assert.equal(out.variants[0].width, 1920);
  assert.equal(out.variants[1].width, 1280);
});

test('rivo series: player ?s=&e= query and exact S/E in the master path', async () => {
  const { resolve, apiCalls, poolCalls } = rivoFetch();
  const out = await resolve({ kind: 'series', tmdb: 1400, season: 1, episode: 1 });
  assert.equal(apiCalls[0].path, '/api/source/tv/1400');
  assert.equal(apiCalls[0].query, '?s=1&e=1');
  assert.equal(out.kind, 'series');
  assert.equal(out.season, 1);
  assert.equal(out.episode, 1);
  assert.ok(out.master.includes('/rivo/media/1400/1-1/m3u8-proxy.m3u8'), out.master);
  assert.ok(poolCalls.every(c => c.path.includes('/1400/1-1/')));
});

test('rivo season 0: passed through exactly, no clamping', async () => {
  const { resolve, apiCalls } = rivoFetch();
  const out = await resolve({ kind: 'series', tmdb: 1400, season: 0, episode: 3 });
  assert.equal(apiCalls[0].query, '?s=0&e=3');
  assert.ok(out.master.includes('/1400/0-3/'), out.master);
});

test('rivo absent episode: empty source list fails honestly, no media fetch', async () => {
  const { resolve, apiCalls, poolCalls } = rivoFetch();
  const error = await rivoError(resolve({ kind: 'series', tmdb: 1400, season: 1, episode: 2 }));
  assert.match(error.provider_errors.rivo, /tv 1400 S1 E2 returned no sources \(provider=none\)/);
  assert.equal(apiCalls.length, 1);
  assert.equal(poolCalls.length, 0);
});

test('rivo unknown movie and type-mismatched id: honest empty responses', async () => {
  const { resolve, poolCalls } = rivoFetch();
  const movie = await rivoError(resolve({ kind: 'movie', tmdb: 424242 }));
  assert.match(movie.provider_errors.rivo, /movie 424242 returned no sources/);
  const mismatch = await rivoError(resolve({ kind: 'series', tmdb: 1368337, season: 1, episode: 1 }));
  assert.match(mismatch.provider_errors.rivo, /tv 1368337 S1 E1 returned no sources/);
  assert.equal(poolCalls.length, 0);
});

test('rivo untrusted provider field: source list rejected before any fetch', async () => {
  const { resolve, poolCalls } = rivoFetch({ knobs: { api: { provider: 'x' } } });
  const error = await rivoError(resolve({ kind: 'movie', tmdb: 550 }));
  assert.match(error.provider_errors.rivo, /movie 550 returned no sources \(provider=x\)/);
  assert.equal(poolCalls.length, 0);
});

test('rivo pool node 5xx: fail over to the next source', async () => {
  const { resolve, poolCalls } = rivoFetch({ knobs: { nodes: { 1: { status: 500 } } } });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'source2');
  assert.ok(out.master.startsWith('https://2.rivo.st/'), out.master);
  // read() retries a 5xx once per source; only the master is ever reached
  // on the dead node, and the healthy node answers the full chain.
  assert.equal(poolCalls.filter(c => c.node === 1).length, 2);
  assert.equal(poolCalls.filter(c => c.node === 2).length, 3);
});

test('rivo pool 200 garbage master (non-playlist body): rejected, fail over', async () => {
  const { resolve, poolCalls } = rivoFetch({ knobs: { nodes: { 1: { garbage: true } } } });
  const out = await resolve({ kind: 'movie', tmdb: 550 });
  assert.equal(out.server, 'source2');
  assert.deepEqual(poolCalls.filter(c => c.node === 1).map(c => c.path),
    ['/rivo/media/550/0-0/m3u8-proxy.m3u8']);
  assert.equal(poolCalls.filter(c => c.node === 2).length, 3);
});

test('rivo segment bait (PNG) on the first source: byte gate, next source healthy', async () => {
  const { resolve, poolCalls } = rivoFetch({ knobs: { nodes: { 1: { segBait: 'png' } } } });
  const out = await resolve({ kind: 'series', tmdb: 1396, season: 1, episode: 2 });
  assert.equal(out.server, 'source2');
  assert.ok(poolCalls.some(c => c.node === 1 && c.path.endsWith('/1396/1-2/0.ts')));
  assert.ok(poolCalls.some(c => c.node === 2 && c.path.endsWith('/1396/1-2/0.ts')));
});

test('rivo all sources dead: 502 with per-source errors', async () => {
  const { resolve, poolCalls } = rivoFetch({ knobs: { nodes: { 1: { status: 500 }, 2: { status: 500 } } } });
  const error = await rivoError(resolve({ kind: 'movie', tmdb: 550 }));
  assert.match(error.provider_errors.rivo, /source1: HTTP 500/);
  assert.match(error.provider_errors.rivo, /source2: HTTP 500/);
  assert.equal(poolCalls.length, 4); // 2 masters per source (one retry each)
});

test('hlsSources: filters to keyless HLS on the rivo.st origin family', async () => {
  const body = {
    provider: 'rivo-backend',
    sources: [
      { key: 'source1', kind: 'hls', quality: '1080p', url: 'https://1.rivo.st/a/m3u8-proxy.m3u8?node=1&q=1-1&p=***' },
      { key: 'source2', kind: 'mp4', quality: '1080p', url: 'https://1.rivo.st/a/moviebox.mp4?node=1&q=1-1&p=***' },
      { key: 'source3', kind: 'hls', quality: '720p', url: 'https://evil.example.com/a/m3u8-proxy.m3u8?x=1' },
      { key: 'source4', kind: 'hls', quality: '720p', url: 'not a url' },
      { key: 'source5', kind: 'hls' },
      { key: 'source6', kind: 'hls', quality: '480p', url: 'https://rivo.st/a/m3u8-proxy.m3u8?x=1' },
    ],
  };
  assert.deepEqual(hlsSources(body).map(s => s.key), ['source1', 'source6']);
  assert.deepEqual(hlsSources({ sources: 'nope' }), []);
  assert.deepEqual(hlsSources(null), []);
});
