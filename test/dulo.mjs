import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';

// Dulo (dulo.mov) fixture: mirrors the verified zcluster chain — config with a
// WORKER_DOMAIN, a keyless /cdn resolve per zcdn subdomain, a master ladder with
// relative `~` URIs, and an fMP4 leaf (#EXT-X-MAP + moof segments that the worker
// mislabels as image/png). Media validation is byte-based, never content-type.
const SITE = 'https://dulo.mov/';
const DOMAIN = 'edge.test';
const play = domain => `https://zcdn1.${domain}/play/tok-1/~A/`;

const ftyp = Buffer.from('000000186674797069736f6d00000200', 'hex');
const moof = (seed) => {
  const body = Buffer.alloc(64);
  for (let i = 0; i < body.length; i++) body[i] = (i + seed) & 0xff;
  return Buffer.concat([Buffer.from('00001588', 'hex'), Buffer.from('moof'), body]);
};

function duloFetch({ domain = DOMAIN, failFirstHost = false, queued = false, htmlMaster = false, pngBaitSegment = false } = {}) {
  const calls = [];
  const mediaCalls = [];
  const master = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=3840x2160,CODECS="avc1.640034,mp4a.40.2"\n~A/2160.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\n~A/1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"\n~A/720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"\n~A/480.m3u8\n';
  const leaf = () => `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="~A/init.hvc1"\n#EXTINF:6.000,\n~A/seg1\n#EXTINF:6.000,\n~A/seg2\n#EXT-X-ENDLIST\n`;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const hls = (text, contentType = 'application/vnd.apple.mpegurl') => new Response(text, { headers: { 'content-type': contentType } });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers: options.headers || {} });
    if (u.hostname === 'dulo.mov') {
      if (u.pathname !== '/dulo-config.js') return new Response('not found', { status: 404 });
      // The real config is JS object syntax with single quotes (not JSON).
      return new Response(`window.__CONFIG__ = { WORKER_DOMAIN: '${domain}' };`, { headers: { 'content-type': 'text/javascript' } });
    }
    if (u.hostname.endsWith(`.${domain}`) && u.pathname === '/cdn') {
      if (failFirstHost && u.hostname === `zcdn1.${domain}`) return new Response('server error', { status: 500 });
      return json(queued ? { ready: false, status: 'queued' } : { ready: true, url: play(domain), rb: 'cafebabecafebabe' });
    }
    if (u.origin === `https://zcdn1.${domain}` || u.origin === `https://zcdn2.${domain}` || u.origin === `https://zcdn3.${domain}`) {
      mediaCalls.push({ url: u, referer: options.headers?.referer });
      if (htmlMaster && u.pathname === '/play/tok-1/~A/') return new Response('<html>player</html>', { headers: { 'content-type': 'text/html' } });
      const file = u.pathname.split('/').pop();
      if (file === '2160.m3u8') return hls(leaf());
      if (file === 'init.hvc1') return new Response(ftyp, { headers: { 'content-type': 'video/mp4' } });
      if (file === 'seg1') return new Response(pngBaitSegment ? Buffer.from('89504e470d0a1a0a504e470d0a1a0a', 'hex') : moof(1), { headers: { 'content-type': 'image/png' } });
      if (file === 'seg2') return new Response(moof(2), { headers: { 'content-type': 'image/png' } });
      if (u.pathname === '/play/tok-1/~A/') return hls(master);
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
}

const policy = (enabled = ['dulo', 'cinejoy']) => () => ({ order: ['dulo', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('Dulo movie: config -> /cdn -> master ladder -> fMP4 leaf, with site headers on media reads', async () => {
  const fixture = duloFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'dulo' });
  assert.equal(result.provider, 'dulo');
  assert.equal(result.tmdb, 27205);
  assert.equal(result.server, 'dulo');
  assert.equal(result.master, play(DOMAIN));
  assert.equal(result.variants[0].width, 3840);
  assert.equal(result.variants.length, 4);
  const cdn = fixture.calls.find(c => c.url.pathname === '/cdn');
  assert.equal(cdn.url.hostname, `zcdn1.${DOMAIN}`);
  assert.equal(cdn.url.searchParams.get('tmdb'), '27205');
  assert.equal(cdn.url.searchParams.get('type'), 'movie');
  assert.equal(cdn.url.searchParams.get('season'), null);
  for (const call of fixture.mediaCalls) assert.equal(call.referer, SITE);
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('/init.hvc1')));
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('/seg1')));
  assert.ok(fixture.calls.every(c => !String(c.url.search).includes('_rb')));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 27205, kind: 'movie', provider: 'dulo' })).cached, true);
  assert.equal(fixture.calls.length, before);
});

test('Dulo TV: preserves the exact season and episode in the /cdn query and the result', async () => {
  const fixture = duloFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 1396, kind: 'series', season: 3, episode: 2, provider: 'dulo' });
  assert.equal(result.provider, 'dulo');
  assert.equal(result.season, 3);
  assert.equal(result.episode, 2);
  const cdn = fixture.calls.find(c => c.url.pathname === '/cdn');
  assert.equal(cdn.url.searchParams.get('type'), 'tv');
  assert.equal(cdn.url.searchParams.get('season'), '3');
  assert.equal(cdn.url.searchParams.get('episode'), '2');
});

test('Dulo TV: season 0 stays season 0 in the query', async () => {
  const fixture = duloFetch();
  const resolve = createProviderResolver(fixture);
  await resolve({ tmdb: 1396, kind: 'series', season: 0, episode: 1, provider: 'dulo' });
  const cdn = fixture.calls.find(c => c.url.pathname === '/cdn');
  assert.equal(cdn.url.searchParams.get('season'), '0');
});

test('Dulo: the live config domain is used for the zcdn hosts, and an absent domain falls back to the last verified one', async () => {
  const alt = duloFetch({ domain: 'alt-edge.test' });
  const resolve = createProviderResolver(alt);
  await resolve({ tmdb: 27205, kind: 'movie', provider: 'dulo' });
  assert.equal(alt.calls.find(c => c.url.pathname === '/cdn').url.hostname, 'zcdn1.alt-edge.test');
  const noDomain = duloFetch();
  noDomain.fetchResource = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === 'dulo.mov') return new Response('window.__CONFIG__ = { other: 1 };', { headers: { 'content-type': 'text/javascript' } });
    if (u.hostname === 'zcdn1.c3204a347-edge.workers.dev' && u.pathname === '/cdn') return new Response(JSON.stringify({ ready: true, url: 'https://zcdn1.c3204a347-edge.workers.dev/play/tok-2/~B/', rb: 'cafebabecafebabe' }));
    if (u.origin === 'https://zcdn1.c3204a347-edge.workers.dev') {
      const file = u.pathname.split('/').pop();
      if (u.pathname.endsWith('/~B/')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n~B/lo.m3u8\n');
      if (file === 'lo.m3u8') return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n~B/s1\n#EXT-X-ENDLIST\n');
      if (file === 's1') return new Response(moof(7), { headers: { 'content-type': 'image/png' } });
      return new Response('nf', { status: 404 });
    }
    return new Response('nf', { status: 404 });
  };
  const fallback = await createProviderResolver(noDomain)({ tmdb: 27205, kind: 'movie', provider: 'dulo' });
  assert.equal(fallback.provider, 'dulo');
  assert.match(fallback.master, /c3204a347-edge\.workers\.dev/);
});

test('Dulo fanout: a failing zcdn host is skipped and the next host serves the stream', async () => {
  const fixture = duloFetch({ failFirstHost: true });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 27205, kind: 'movie', provider: 'dulo' });
  assert.equal(result.provider, 'dulo');
  const cdnHosts = fixture.calls.filter(c => c.url.pathname === '/cdn').map(c => c.url.hostname);
  // The central read() retries 5xx once, so the failed host appears twice before the adapter moves on.
  assert.equal(cdnHosts[0], `zcdn1.${DOMAIN}`);
  assert.equal(cdnHosts.at(-1), `zcdn2.${DOMAIN}`);
  assert.ok(cdnHosts.every(h => h === `zcdn1.${DOMAIN}` || h === `zcdn2.${DOMAIN}`));
});

test('Dulo queued answers fail honestly and fall back to the next provider', async () => {
  const fixture = duloFetch({ queued: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 999999999, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.dulo, /queued/);
});

test('Dulo rejects a non-HLS player response at the play URL and falls back', async () => {
  const fixture = duloFetch({ htmlMaster: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 27205, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.dulo, /HLS/);
});

test('Dulo rejects an image-bait first segment (bytes, not content-type, decide)', async () => {
  const fixture = duloFetch({ pngBaitSegment: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 27205, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.dulo, /not .*video|bait/i);
});

test('Dulo exclusions skip the provider and a pinned disabled provider is rejected', async () => {
  const fixture = duloFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 27205, kind: 'movie', exclude: ['dulo'] });
  assert.equal(result.provider, 'cinejoy');
  assert.equal(fixture.calls.length, 0);
  const disabled = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
  await assert.rejects(disabled({ tmdb: 27205, kind: 'movie', provider: 'dulo' }), /disabled/);
});

test('Dulo serves IPTV movie routes through the signed local HLS relay with fMP4 segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-dulo-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = duloFetch();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['dulo'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/27205.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.match(master, /RESOLUTION=3840x2160/);
    assert.doesNotMatch(master, /dulo\.mov|edge\.test/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXT-X-MAP:/);
    assert.match(leaf, /#EXTINF:/);
    assert.doesNotMatch(leaf, /dulo\.mov|edge\.test/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const bytes = Buffer.from(await (await original(segmentURL)).arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString(), 'moof');
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
