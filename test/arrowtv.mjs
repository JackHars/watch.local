import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { createProviderResolver } from '../api/providers.mjs';

// ArrowTV (arrowtv.net) fixture: mirrors the verified Cinezo/Punkflix chain —
// a keyless TMDB-addressed JSON API (punkflix.net) whose stream.hls points at
// a signed v7 master on media.punkflix.net; the master carries audio
// renditions and a 1080p/4K video ladder, each level a VOD fMP4 playlist whose
// #EXT-X-MAP init and ~6 s segments the CDN mislabels as image/jpeg (ftyp
// init, styp/sidx/moof/mdat segments). Media validation is byte-based, never
// content-type. The JSON `id` doubles as the title/episode identity check.
const REFERER = 'https://player.cinezo.live/';

const ftyp = Buffer.from('000000186674797069736f6d00000200', 'hex');
const styp = Buffer.from('00000010737479706d73686400000000', 'hex');
const sidx = Buffer.concat([Buffer.from('0000002073696478', 'hex'), Buffer.alloc(24)]);
const moof = (seed) => {
  const body = Buffer.alloc(64);
  for (let i = 0; i < body.length; i++) body[i] = (i + seed) & 0xff;
  return Buffer.concat([Buffer.from('00000048', 'hex'), Buffer.from('moof'), body]);
};
const mdat = (seed) => {
  const body = Buffer.alloc(64);
  for (let i = 0; i < body.length; i++) body[i] = (0x5a + i + seed) & 0xff;
  return Buffer.concat([Buffer.from('00000048', 'hex'), Buffer.from('mdat'), body]);
};
const videoSegment = (seed) => Buffer.concat([styp, sidx, moof(seed), mdat(seed)]);
const audioSegment = (seed) => Buffer.concat([ftyp, moof(seed)]);

function arrowtvFetch({ kind = 'movie', tmdb = 1423191, season = 1, episode = 1, wrongId = false, noHls = false, htmlMaster = false, baitSegment = false } = {}) {
  const calls = [];
  const mediaCalls = [];
  const jsonPath = kind === 'series' ? `/tv/${tmdb}/${season}/${episode}.json` : `/movie/${tmdb}.json`;
  const vod = kind === 'series' ? `84773/${season}/${episode}` : '1423191';
  const media = `https://media.punkflix.net/vod/${vod}/`;
  const hls = `${media}master.m3u8?t=1700000000&s=deadbeef`;
  const jsonBody = {
    id: wrongId ? tmdb + 1 : tmdb,
    title: kind === 'series' ? 'A Shadow of the Past' : 'Resident Evil',
    year: kind === 'series' ? 2022 : 2026,
    type: kind === 'series' ? 'tv' : 'movie',
    container: 'mp4',
    stream: noHls ? undefined : { hls, original: 'unused', remux: 'unused' },
    audio: [{ language: 'EN', type: 'internal' }],
    subtitles: [],
    expires_in_sec: 14400,
  };
  const master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="en.m3u8?t=1&s=cafe"\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="hi.m3u8?t=1&s=cafe"\n'
    + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8?t=1&s=cafe"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=10100282,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\n1080.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=28717570,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\n2160.m3u8\n';
  const leaf = (level) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="${level}/init.jpg?k=initkey"\n#EXTINF:6.000,\n${level}/seg1.jpg?k=segkey\n#EXTINF:6.000,\n${level}/seg2.jpg?k=segkey\n#EXT-X-ENDLIST\n`;
  const audioLeaf = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="en/0000_init.jpg?k=ainit"\n#EXTINF:6.016,\nen/00001.jpg?k=akey\n#EXTINF:5.994,\nen/00002.jpg?k=akey\n#EXT-X-ENDLIST\n';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const hlsRes = (text) => new Response(text, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers: options.headers || {} });
    if (u.hostname === 'punkflix.net') {
      assert.equal(u.pathname, jsonPath);
      assert.equal(options.headers?.referer, REFERER);
      return json(noHls ? { id: jsonBody.id, stream: { original: 'unused' } } : jsonBody);
    }
    if (u.hostname === 'media.punkflix.net') {
      mediaCalls.push({ url: u, referer: options.headers?.referer });
      const p = u.pathname;
      if (p.endsWith('master.m3u8')) return htmlMaster ? new Response('<html>player</html>', { headers: { 'content-type': 'text/html' } }) : hlsRes(master);
      if (p.endsWith('2160.m3u8') || p.endsWith('1080.m3u8')) return hlsRes(leaf(p.endsWith('2160.m3u8') ? '2160' : '1080'));
      if (p.endsWith('en.m3u8')) return hlsRes(audioLeaf);
      if (p.endsWith('init.jpg')) return new Response(ftyp, { headers: { 'content-type': 'image/jpeg' } });
      if (p.endsWith('00001.jpg') || p.endsWith('00002.jpg')) return new Response(audioSegment(p.endsWith('00001.jpg') ? 1 : 2), { headers: { 'content-type': 'image/jpeg' } });
      if (p.endsWith('seg1.jpg') || p.endsWith('seg2.jpg')) {
        if (baitSegment && p.endsWith('seg1.jpg')) return new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { headers: { 'content-type': 'image/jpeg' } });
        return new Response(videoSegment(p.endsWith('seg1.jpg') ? 1 : 2), { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchResource, calls, mediaCalls };
}

const policy = (enabled = ['arrowtv', 'cinejoy']) => () => ({ order: ['arrowtv', 'cinejoy'], enabled, providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 });
const cinejoyStub = () => async () => ({ master: 'https://cinejoy.test/master.m3u8', headers: {}, server: 'cinejoy' });

test('ArrowTV movie: keyless punflix JSON -> 4K fMP4 ladder, with player referer on media reads', async () => {
  const fixture = arrowtvFetch();
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 1423191, kind: 'movie', provider: 'arrowtv' });
  assert.equal(result.provider, 'arrowtv');
  assert.equal(result.tmdb, 1423191);
  assert.equal(result.server, 'arrowtv');
  assert.match(result.master, /^https:\/\/media\.punkflix\.net\/vod\/1423191\/master\.m3u8/);
  assert.equal(result.variants[0].width, 3840);
  assert.equal(result.variants.length, 2);
  const jsonCall = fixture.calls.find(c => c.url.hostname === 'punkflix.net');
  assert.equal(jsonCall.url.pathname, '/movie/1423191.json');
  assert.equal(jsonCall.headers.referer, REFERER);
  for (const call of fixture.mediaCalls) assert.equal(call.referer, REFERER);
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('2160/init.jpg')));
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('2160/seg1.jpg')));
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('en/00001.jpg')));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 1423191, kind: 'movie', provider: 'arrowtv' })).cached, true);
  assert.equal(fixture.calls.length, before);
});

test('ArrowTV TV: preserves the exact season and episode in the JSON path and the result', async () => {
  const fixture = arrowtvFetch({ kind: 'series', tmdb: 84773, season: 3, episode: 2 });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 84773, kind: 'series', season: 3, episode: 2, provider: 'arrowtv' });
  assert.equal(result.provider, 'arrowtv');
  assert.equal(result.season, 3);
  assert.equal(result.episode, 2);
  const jsonCall = fixture.calls.find(c => c.url.hostname === 'punkflix.net');
  assert.equal(jsonCall.url.pathname, '/tv/84773/3/2.json');
  assert.match(result.master, /\/vod\/84773\/3\/2\/master\.m3u8/);
});

test('ArrowTV TV: season 0 stays season 0 in the JSON path', async () => {
  const fixture = arrowtvFetch({ kind: 'series', tmdb: 84773, season: 0, episode: 1 });
  const resolve = createProviderResolver(fixture);
  await resolve({ tmdb: 84773, kind: 'series', season: 0, episode: 1, provider: 'arrowtv' });
  const jsonCall = fixture.calls.find(c => c.url.hostname === 'punkflix.net');
  assert.equal(jsonCall.url.pathname, '/tv/84773/0/1.json');
});

test('ArrowTV validates the default audio rendition and never fetches the unused tracks', async () => {
  const fixture = arrowtvFetch();
  const resolve = createProviderResolver(fixture);
  await resolve({ tmdb: 1423191, kind: 'movie', provider: 'arrowtv' });
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('en/0000_init.jpg')));
  assert.ok(fixture.mediaCalls.some(c => c.url.pathname.endsWith('en/00001.jpg')));
  assert.ok(!fixture.mediaCalls.some(c => c.url.pathname.endsWith('hi.m3u8')), 'the unused Hindi track must not be fetched');
  assert.ok(!fixture.mediaCalls.some(c => c.url.pathname.endsWith('subs.m3u8')), 'subtitles are app-level, not part of source validation');
});

test('ArrowTV rejects a JSON answer for a different title (identity check) and falls back', async () => {
  const fixture = arrowtvFetch({ wrongId: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1423191, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.arrowtv, /different title/);
});

test('ArrowTV rejects a response without stream.hls and falls back to the next provider', async () => {
  const fixture = arrowtvFetch({ noHls: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1423191, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.arrowtv, /no stream\.hls/);
});

test('ArrowTV rejects a non-HLS player response at the master and falls back', async () => {
  const fixture = arrowtvFetch({ htmlMaster: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1423191, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.arrowtv, /HLS/);
});

test('ArrowTV rejects an image-bait first segment (bytes, not content-type, decide)', async () => {
  const fixture = arrowtvFetch({ baitSegment: true });
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1423191, kind: 'movie' });
  assert.equal(result.provider, 'cinejoy');
  assert.match(result.provider_errors.arrowtv, /not .*video|bait/i);
});

test('ArrowTV exclusions skip the provider and a pinned disabled provider is rejected', async () => {
  const fixture = arrowtvFetch();
  const resolve = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy() });
  const result = await resolve({ tmdb: 1423191, kind: 'movie', exclude: ['arrowtv'] });
  assert.equal(result.provider, 'cinejoy');
  assert.equal(fixture.calls.length, 0);
  const disabled = createProviderResolver({ ...fixture, cinejoy: cinejoyStub(), getPolicy: policy(['cinejoy']) });
  await assert.rejects(disabled({ tmdb: 1423191, kind: 'movie', provider: 'arrowtv' }), /disabled/);
});

test('ArrowTV serves IPTV movie routes through the signed local HLS relay with fMP4 segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-arrowtv-http-'));
  const original = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = arrowtvFetch();
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? original(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory, zliveSource: { list: async () => [] }, timstreamsSource: { list: async () => [] } });
    await settingsStore.configure({ playback: { enabled: ['arrowtv'] } });
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = settingsStore.get();
    const response = await original(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/1423191.m3u8`);
    assert.equal(response.status, 200);
    const master = await response.text();
    assert.match(master, /^#EXTM3U/);
    assert.match(master, /RESOLUTION=3840x2160/);
    assert.doesNotMatch(master, /punkflix|cinezo|arrowtv/);
    const leafURL = master.split('\n').find(line => line.startsWith('http'));
    const leaf = await (await original(leafURL)).text();
    assert.match(leaf, /#EXT-X-MAP:/);
    assert.match(leaf, /#EXTINF:/);
    assert.doesNotMatch(leaf, /punkflix|cinezo|arrowtv/);
    const segmentURL = leaf.split('\n').find(line => line.startsWith('http') && !line.endsWith('.m3u8'));
    const bytes = Buffer.from(await (await original(segmentURL)).arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString(), 'styp');
  } finally {
    globalThis.fetch = original;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
