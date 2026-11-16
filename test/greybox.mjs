import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createProviderResolver } from '../api/providers.mjs';
import { scanSources } from '../api/greybox.mjs';

// GreyBox (greyboxtv.duckdns.org / vidoraplayer.duckdns.org) fixture — mirrors
// the live-verified contract (evidence artifact 5271515d13f7, re-verified
// live 2026-11-16):
//
//   * SSR watch pages on the front origin are id-keyed: unknown ids and
//     out-of-range season/episode -> 404 "Page not found" (honest, no
//     substitution); a valid page echoes `<title>Watch <Title>[ · S<s> E<e>]
//     · GreyBox</title>` and the exact watch path;
//   * GET /api/sources?type=&id=[&season=&episode=] on the player origin
//     streams NDJSON (application/x-ndjson): source/done events, closed
//     shortly after done; TV answers are keyed by the explicit season/
//     episode pair (a missing pair would substitute a default episode);
//   * every source url is /api/media?u=*** on the player origin (signed,
//     short-lived, re-resolved per play); the token routes to an HLS master
//     (proxied 1080/720 variants), then a VOD playlist that is either
//     keyless fMP4 (Orion/Nova: #EXT-X-MAP init + styp segments) or
//     AES-128 MPEG-TS (Vega: no MAP, key via the same proxy, no explicit
//     IV -> MEDIA-SEQUENCE big-endian, 0x47 syncs after decryption);
//   * the pool is unstable: relays return 200 with an error body ("relay
//     stream: fetch failed"), so the resolver fails over through the ranked
//     source list, validating each chain through the shared ctx.accept;
//   * all fetches carry only a browser UA (the proxy does not require
//     Referer/Origin).
const PLAYER = 'https://vidoraplayer.duckdns.org';
const UA_RE = /Mozilla\/5\.0/;

const TITLES = { 1368337: 'The Odyssey', 550: 'Sharktopus', 1400: 'Seinfeld', 1396: 'Breaking Bad' };
const CATALOG = {
  movie: new Set(['1368337', '550']),
  tv: new Map([
    ['1400', new Set(['1-1', '1-2', '0-3'])],
    ['1396', new Set(['1-1', '1-2'])],
  ]),
};

const ftyp = () => {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d], 0);
  return bytes;
};
const styp = () => {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 32, 0x73, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0x6d, 0x70, 0x34, 0x31], 0);
  return bytes;
};
const mp2t = () => {
  const bytes = new Uint8Array(188 * 4);
  for (let i = 0; i < 4; i++) bytes[i * 188] = 0x47;
  return bytes;
};
const PNG_BAIT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML_BAIT = '<html><body>404 Not Found</body></html>';

// Synthetic 16-byte AES key; Vega segments in the fixture are the TS stream
// encrypted with this key and the big-endian MEDIA-SEQUENCE IV, exactly the
// live Vega contract.
const VEGA_KEY = new Uint8Array(16).fill(0x5a);
const vegaSeg = () => {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, 1n);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(VEGA_KEY), Buffer.from(iv));
  cipher.setAutoPadding(false);
  return cipher.update(Buffer.from(mp2t()));
};

// NDJSON scan body for one identity. Ranked order after scanSources():
// orion-1080, nova-1080, orion-1080-dub, orion-720, vega-1080 (keyed last).
// Token scheme: m/v/i/s-<group>[marker]-<identity>, identity = <id> for
// movies and <id>-<s>-<e> for series (episode-keyed like the live proxy).
const ndjsonFor = (isTv, id, season = 0, episode = 0) => {
  const identity = isTv ? `${id}-${season}-${episode}` : String(id);
  const src = (slug, label, providerGroup, quality) => JSON.stringify({
    event: 'source', ms: 4000,
    source: {
      server: 'vidora', label, providerGroup, quality,
      url: `/api/media?u=${slug}`, type: 'vod', subtitles: [],
    },
  });
  return [
    JSON.stringify({ event: 'roster', ms: 0, providers: ['Orion', 'Nova', 'Vega'] }),
    src(`m-orion-${identity}`, 'Orion 1080p', 'Orion', '1080'),
    src(`m-nova-${identity}`, 'Nova 1080p', 'Nova', '1080'),
    src(`m-orion-dub-${identity}`, 'Orion 1080p · Russian', 'Orion', '1080'),
    src(`m-orion-p720-${identity}`, 'Orion 720p', 'Orion', '720'),
    src(`m-vega-${identity}`, 'Vega 1080p', 'Vega', '1080'),
    JSON.stringify({ event: 'done', ms: 20000, sources: [] }),
  ].join('\n') + '\n';
};

const masterFor = (group, identity) => `#EXTM3U
#EXT-X-VERSION:8
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-STREAM-INF:BANDWIDTH=4192000,RESOLUTION=1920x1080,FRAME-RATE=24
/api/media?u=${'v-' + group + '-1080-' + identity}
#EXT-X-STREAM-INF:BANDWIDTH=1928000,RESOLUTION=1280x720,FRAME-RATE=24
/api/media?u=${'v-' + group + '-720-' + identity}
#EXT-X-ENDLIST
`;

const vodFmp4 = (group, identity) => `#EXTM3U
#EXT-X-VERSION:8
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="/i-${group}-${identity}"
#EXTINF:60.000000,
/s-${group}-0-${identity}
#EXTINF:60.000000,
/s-${group}-1-${identity}
#EXTINF:60.000000,
/s-${group}-2-${identity}
#EXTINF:60.000000,
/s-${group}-3-${identity}
#EXT-X-ENDLIST
`;

const vodTs = (identity) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="/k-vega"
#EXTINF:60.000000,
/s-vega-0-${identity}
#EXTINF:60.000000,
/s-vega-1-${identity}
#EXTINF:60.000000,
/s-vega-2-${identity}
#EXTINF:60.000000,
/s-vega-3-${identity}
#EXT-X-ENDLIST
`;

function greyboxFetch({ knobs = {} } = {}) {
  const frontCalls = [];
  const sourcesCalls = [];
  const mediaCalls = [];
  const k = knobs;

  // Identity suffix = trailing numeric parts of a token (id, or id-s-e).
  const identityOf = (parts, from) => {
    const nums = parts.slice(from).filter(p => /^\d+$/.test(p));
    return nums.join('-') || '0';
  };

  const fetchResource = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = options.headers || {};
    if (url.hostname === 'greyboxtv.duckdns.org') {
      frontCalls.push({ path: url.pathname, headers });
      if (k.watchStatus) return new Response('Page not found · GreyBox', { status: k.watchStatus });
      const m = url.pathname.match(/^\/(tv|movie)\/watch\/(\d+)(?:\/(\d+)\/(\d+))?$/);
      if (!m) return new Response('Page not found · GreyBox', { status: 404 });
      const isTv = m[1] === 'tv';
      const id = m[2];
      const available = isTv
        ? (CATALOG.tv.get(id)?.has(`${m[3]}-${m[4]}`) ?? false)
        : CATALOG.movie.has(id);
      if (!available) return new Response('Page not found · GreyBox', { status: 404 });
      const title = k.watchTitle
        || (isTv ? `Watch ${TITLES[id]} · S${m[3]} E${m[4]} · GreyBox` : `Watch ${TITLES[id]} · GreyBox`);
      const echo = isTv ? `/tv/${id}/${m[3]}/${m[4]}` : `/movie/watch/${id}`;
      return new Response(
        `<html><head><title>${title}</title></head><body><a href="${echo}">watch</a></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (url.hostname === 'vidoraplayer.duckdns.org') {
      if (url.pathname === '/api/sources') {
        sourcesCalls.push({ query: url.search, headers });
        if (k.ndjson !== undefined) return new Response(k.ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
        const type = url.searchParams.get('type');
        const id = url.searchParams.get('id');
        const season = url.searchParams.get('season');
        const episode = url.searchParams.get('episode');
        const available = type === 'tv'
          ? (CATALOG.tv.get(id)?.has(`${season}-${episode}`) ?? false)
          : CATALOG.movie.has(id);
        return new Response(
          available ? ndjsonFor(type === 'tv', id, Number(season ?? 0), Number(episode ?? 0)) : '',
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        );
      }
      const u = url.searchParams.get('u');
      const token = u ?? url.pathname.replace(/^\//, '');
      mediaCalls.push({ token, path: url.pathname, query: url.search, headers });
      const override = k.media?.[token];
      if (override === 'relay') return new Response('relay stream: fetch failed', { status: 200, headers: { 'content-type': 'text/plain' } });
      if (override === 'html') return new Response(HTML_BAIT, { status: 200, headers: { 'content-type': 'text/html' } });
      if (override === '500') return new Response('err', { status: 500 });
      const parts = token.split('-');
      const role = parts[0];
      const group = parts[1] ?? '';
      if (role === 'k') {
        if (k.key404) return new Response('nf', { status: 404 });
        return new Response(VEGA_KEY, { status: 200, headers: { 'content-type': 'video/mp2t' } });
      }
      if (role === 'i') return new Response(ftyp(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (role === 's') {
        if (group === 'vega') return new Response(vegaSeg(), { status: 200, headers: { 'content-type': 'video/mp2t' } });
        if (k.segBait && group.startsWith(k.segBait)) return new Response(PNG_BAIT, { status: 200, headers: { 'content-type': 'video/mp4' } });
        return new Response(styp(), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (role === 'v') {
        const identity = identityOf(parts, 3);
        return new Response(
          group === 'vega' ? vodTs(identity) : vodFmp4(group, identity),
          { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
        );
      }
      if (role === 'm') {
        const identity = identityOf(parts, 2);
        return new Response(masterFor(group, identity), { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      return new Response('unknown token', { status: 404 });
    }
    return new Response(`unexpected host ${url.hostname}`, { status: 404 });
  };

  const resolve = createProviderResolver({
    fetchResource,
    getPolicy: () => ({
      enabled: ['greybox'],
      order: ['greybox'],
      providerTimeout: 30,
      totalTimeout: 60,
      cacheSeconds: 60,
    }),
  });
  return { resolve, frontCalls, sourcesCalls, mediaCalls };
}

async function greyboxError(promise) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'expected rejection');
  assert.equal(error.status, 502);
  assert.equal(error.message, 'No provider returned playable HLS');
  assert.match(error.provider_errors?.greybox || '', /^GreyBox /);
  return error;
}

test('greybox movie: id-keyed watch page, exact-keyed NDJSON scan, keyless fMP4 chain', async () => {
  const { resolve, frontCalls, sourcesCalls, mediaCalls } = greyboxFetch();
  const out = await resolve({ kind: 'movie', tmdb: 1368337 });
  assert.equal(frontCalls.length, 1);
  assert.equal(frontCalls[0].path, '/movie/watch/1368337');
  assert.match(frontCalls[0].headers['user-agent'], UA_RE);
  assert.equal(sourcesCalls.length, 1);
  assert.equal(sourcesCalls[0].query, '?type=movie&id=1368337');
  // One healthy source is enough: master + 1080 variant + init + first
  // segment. The 720 variant and every other source are never touched.
  assert.deepEqual(
    mediaCalls.map(c => c.token),
    ['m-orion-1368337', 'v-orion-1080-1368337', 'i-orion-1368337', 's-orion-0-1368337'],
  );
  for (const call of [...frontCalls, ...sourcesCalls, ...mediaCalls]) {
    assert.match(call.headers['user-agent'], UA_RE);
    assert.equal(call.headers.referer, undefined, 'proxy needs no Referer');
  }
  assert.equal(out.provider, 'greybox');
  assert.equal(out.kind, 'movie');
  assert.equal(out.server, 'greybox:Orion');
  assert.ok(out.streams.every(s => s.playlist.startsWith(`${PLAYER}/api/media?`)));
  assert.ok(out.streams.every(s => s.playlist.includes("?u=")));
  assert.equal(out.streams[0].type, 'hls');
  assert.equal(out.variants[0].width, 1920);
  assert.equal(out.variants[1].width, 1280);
});

test('greybox series: explicit season/episode in the scan, episode-keyed media', async () => {
  const { resolve, frontCalls, sourcesCalls, mediaCalls } = greyboxFetch();
  const out = await resolve({ kind: 'series', tmdb: 1400, season: 1, episode: 1 });
  assert.equal(frontCalls[0].path, '/tv/watch/1400/1/1');
  assert.equal(sourcesCalls[0].query, '?type=tv&id=1400&season=1&episode=1');
  assert.equal(out.season, 1);
  assert.equal(out.episode, 1);
  assert.equal(out.master, `${PLAYER}/api/media?u=m-orion-1400-1-1`);
  assert.deepEqual(
    mediaCalls.map(c => c.token),
    ['m-orion-1400-1-1', 'v-orion-1080-1400-1-1', 'i-orion-1400-1-1', 's-orion-0-1400-1-1'],
  );

  const second = await resolve({ kind: 'series', tmdb: 1400, season: 1, episode: 2 });
  assert.equal(second.master, `${PLAYER}/api/media?u=m-orion-1400-1-2`);
  assert.ok(second.master !== out.master, 'episode-scoped sources must be distinct');
});

test('greybox season 0: passed through exactly, no clamping', async () => {
  const { resolve, sourcesCalls } = greyboxFetch();
  const out = await resolve({ kind: 'series', tmdb: 1400, season: 0, episode: 3 });
  assert.equal(sourcesCalls[0].query, '?type=tv&id=1400&season=0&episode=3');
  assert.equal(out.master, `${PLAYER}/api/media?u=m-orion-1400-0-3`);
});

test('greybox unknown movie: 404 watch page fails honestly, no scan or media', async () => {
  const { resolve, sourcesCalls, mediaCalls } = greyboxFetch();
  const error = await greyboxError(resolve({ kind: 'movie', tmdb: 424242 }));
  assert.match(error.provider_errors.greybox, /movie 424242 \(watch page HTTP 404\)/);
  assert.equal(sourcesCalls.length, 0);
  assert.equal(mediaCalls.length, 0);
});

test('greybox out-of-range episode and type-mismatched id: honest 404, no substitution', async () => {
  const { resolve, sourcesCalls, mediaCalls } = greyboxFetch();
  const oob = await greyboxError(resolve({ kind: 'series', tmdb: 1396, season: 1, episode: 3 }));
  assert.match(oob.provider_errors.greybox, /tv 1396 S1 E3 \(watch page HTTP 404\)/);
  const mismatch = await greyboxError(resolve({ kind: 'movie', tmdb: 1400 }));
  assert.match(mismatch.provider_errors.greybox, /movie 1400 \(watch page HTTP 404\)/);
  assert.equal(sourcesCalls.length, 0);
  assert.equal(mediaCalls.length, 0);
});

test('greybox watch page 200 without echo: rejected before the scan', async () => {
  const { resolve, sourcesCalls, mediaCalls } = greyboxFetch({ knobs: { watchTitle: 'Page not found · GreyBox' } });
  const error = await greyboxError(resolve({ kind: 'movie', tmdb: 1368337 }));
  assert.match(error.provider_errors.greybox, /watch page does not echo movie 1368337/);
  assert.equal(sourcesCalls.length, 0);
  assert.equal(mediaCalls.length, 0);
});

test('greybox empty scan despite valid watch page: no sources, no media fetch', async () => {
  const { resolve, sourcesCalls, mediaCalls } = greyboxFetch({ knobs: { ndjson: '' } });
  const error = await greyboxError(resolve({ kind: 'movie', tmdb: 1368337 }));
  assert.match(error.provider_errors.greybox, /returned no sources for movie 1368337/);
  assert.equal(sourcesCalls.length, 1);
  assert.equal(mediaCalls.length, 0);
});

test('greybox relay error on the first source: fail over to the next', async () => {
  const { resolve, mediaCalls } = greyboxFetch({ knobs: { media: { 'm-orion-1368337': 'relay' } } });
  const out = await resolve({ kind: 'movie', tmdb: 1368337 });
  assert.equal(out.server, 'greybox:Nova');
  assert.ok(out.master.endsWith('m-nova-1368337'));
  assert.deepEqual(
    mediaCalls.map(c => c.token).slice(0, 2),
    ['m-orion-1368337', 'm-nova-1368337'],
  );
});

test('greybox segment PNG bait on the first source: byte gate, next source healthy', async () => {
  const { resolve, mediaCalls } = greyboxFetch({ knobs: { segBait: 'orion' } });
  const out = await resolve({ kind: 'movie', tmdb: 1368337 });
  assert.equal(out.server, 'greybox:Nova');
  assert.ok(mediaCalls.some(c => c.token === 's-orion-0-1368337'), 'baited segment was fetched and rejected');
  assert.ok(mediaCalls.some(c => c.token === 's-nova-0-1368337'), 'healthy source segment fetched');
});

test('greybox all keyless sources dead: Vega AES-128 TS chain is the last resort', async () => {
  const knobs = {
    media: {
      'm-orion-1368337': 'relay',
      'm-nova-1368337': 'relay',
      'm-orion-dub-1368337': 'relay',
      'm-orion-p720-1368337': 'relay',
    },
  };
  const { resolve, mediaCalls } = greyboxFetch({ knobs });
  const out = await resolve({ kind: 'movie', tmdb: 1368337 });
  assert.equal(out.server, 'greybox:Vega');
  assert.ok(out.master.endsWith('m-vega-1368337'));
  assert.deepEqual(
    mediaCalls.map(c => c.token).slice(4),
    ['m-vega-1368337', 'v-vega-1080-1368337', 's-vega-0-1368337', 'k-vega'],
  );
});

test('greybox every source dead: 502 with per-source errors', async () => {
  const knobs = {
    media: {
      'm-orion-1368337': 'relay',
      'm-nova-1368337': 'relay',
      'm-orion-dub-1368337': '500',
      'm-orion-p720-1368337': 'html',
      'm-vega-1368337': 'relay',
    },
  };
  const { resolve, mediaCalls } = greyboxFetch({ knobs });
  const error = await greyboxError(resolve({ kind: 'movie', tmdb: 1368337 }));
  assert.match(error.provider_errors.greybox, /GreyBox has no playable source/);
  assert.match(error.provider_errors.greybox, /Orion 1080p/);
  assert.match(error.provider_errors.greybox, /Nova 1080p/);
  assert.match(error.provider_errors.greybox, /Vega 1080p/);
  // ctx.read retries a 5xx once per source, so the 500 master is fetched
  // twice; the 200-body failures (relay/html) are not retried.
  assert.equal(mediaCalls.length, 6);
});

test('scanSources: parses NDJSON events, dedupes, filters foreign origins, ranks keyed last', () => {
  const body = [
    JSON.stringify({ event: 'roster', ms: 0, providers: ['Orion', 'Nova', 'Vega'] }),
    'not json at all',
    JSON.stringify({ event: 'source', source: { label: 'Orion 1080p', providerGroup: 'Orion', quality: '1080', url: '/api/media?u=gb1' } }),
    JSON.stringify({ event: 'source', source: { label: 'Nova 1080p', providerGroup: 'Nova', quality: '1080', url: '/api/media?u=gb2' } }),
    JSON.stringify({ event: 'source', source: { label: 'Orion 1080p · Russian', providerGroup: 'Orion', quality: '1080', url: '/api/media?u=gb3' } }),
    JSON.stringify({ event: 'source', source: { label: 'Orion 720p', providerGroup: 'Orion', quality: '720', url: '/api/media?u=gb4' } }),
    JSON.stringify({ event: 'source', source: { label: 'Vega 1080p', providerGroup: 'Vega', quality: '1080', url: '/api/media?u=gb5' } }),
    JSON.stringify({ event: 'source', source: { label: 'External', providerGroup: 'X', quality: '1080', url: 'https://evil.example.com/a?x=1' } }),
    JSON.stringify({ event: 'source', source: { label: 'NoUrl', providerGroup: 'X' } }),
    JSON.stringify({ event: 'done', sources: [
      { label: 'Orion 1080p', providerGroup: 'Orion', quality: '1080', url: '/api/media?u=gb1' },
      { label: 'Dup via done', providerGroup: 'Nova', quality: '720', url: '/api/media?u=gb6' },
    ] }),
  ].join('\n');
  const out = scanSources(body);
  assert.deepEqual(out.map(s => s.label), [
    'Orion 1080p', 'Nova 1080p', 'Orion 1080p · Russian', 'Orion 720p', 'Dup via done', 'Vega 1080p',
  ]);
  assert.ok(out.every(s => s.url.startsWith(`${PLAYER}/api/media?`)));
  assert.ok(out.every(s => s.url.includes("?u=")));
  assert.deepEqual(scanSources(''), []);
  assert.deepEqual(scanSources(null), []);
});

