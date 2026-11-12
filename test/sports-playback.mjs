import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSportsPlayback, sportsMediaURL } from '../api/sports-playback.mjs';

const player = 'https://player.test/play/channel123456789', referer = 'https://events.test/match';
const markup = '<div id="scp" data-key="channel123456789" data-hls="/hls.js"></div>';
const time = 1800000000000;
const auth = (generation = 1, clock = time) => ({ ok: true, session: 'fixture-session', expires: clock / 1000 + 3600, renew_in: 300, key_auth: `fixture-key-auth-${generation}`, sources: [{ id: 'cdn', url: `https://cdn.test/token-${generation}/channel/index.m3u8` }], drm: null });

test('authorizes public player, falls back between sources and keeps key authorization off media CDNs', async () => {
  const calls = [];
  const service = createSportsPlayback({ now: () => time, request: async (url, from, options) => {
    calls.push({ url, from, options });
    if (url.endsWith('/authorize')) return { text: JSON.stringify({ ...auth(), sources: [{ id: 'broken', url: 'https://offline.test/index.m3u8' }, ...auth().sources] }) };
    if (url.includes('offline.test')) throw Error('HTTP 503');
    return { text: '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' };
  } });
  assert.equal(await service.resolve('<video></video>', player, referer), null);
  const stream = await service.resolve(markup, player, referer);
  assert.equal(stream.url, auth().sources[0].url);
  assert.deepEqual(JSON.parse(calls[0].options.body), { key: 'channel123456789', native: false, embed_origin: 'https://events.test' });
  assert.equal(calls[0].from, player);
  assert.doesNotMatch(JSON.stringify(stream), /fixture-session|fixture-key-auth/);
  const key = await service.media('https://cdn.test/sc-key/channel123456789/run123.key', stream.playback);
  assert.equal(key.url, 'https://player.test/sc-key/channel123456789/run123.key');
  assert.equal(key.headers['x-sc-auth'], 'fixture-key-auth-1');
  for (const url of ['https://cdn.test/token-1/channel/segment.ts', 'https://other.test/segment.ts', 'https://other.test/sc-key/anotherchannel/run123.key']) {
    const media = await service.media(url, stream.playback);
    assert.equal(media.headers['x-sc-auth'], undefined); assert.equal(media.headers.referer, player);
  }
  assert.equal(calls.filter(c => c.options?.method === 'POST').length, 1);
});

test('renews once for concurrent requests and keeps old playlist/key URLs working after token rotation', async () => {
  let clock = time, generation = 0;
  const posts = [];
  const service = createSportsPlayback({ now: () => clock, request: async (url, from, options) => {
    if (options?.method === 'POST') { posts.push({ url, body: JSON.parse(options.body) }); return { text: JSON.stringify(auth(++generation, clock)) }; }
    return { text: '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' };
  } });
  const original = await service.resolve(markup, player, referer);
  clock += 301000;
  const resources = await Promise.all(Array.from({ length: 6 }, () => service.media('https://cdn.test/token-1/channel/segment.ts', original.playback)));
  assert.equal(generation, 2); assert.equal(posts[1].url, 'https://player.test/api/v1/playback/renew');
  assert.equal(posts[1].body.session, 'fixture-session');
  assert.ok(resources.every(r => r.url === 'https://cdn.test/token-2/channel/segment.ts'));
  assert.equal(sportsMediaURL(resources[0].url,original.playback,resources[0].playback),'https://cdn.test/token-1/channel/segment.ts','Rotated provider tokens must not change client-visible segment identity');
  assert.equal((await service.media(original.url, original.playback)).url, auth(2).sources[0].url);
  assert.equal((await service.media('https://cdn.test/sc-key/channel123456789/run123.key', original.playback)).headers['x-sc-auth'], 'fixture-key-auth-2');
  clock += 301000;
  const later = await service.media(resources[0].url, resources[0].playback);
  assert.equal(later.url, 'https://cdn.test/token-3/channel/segment.ts');
  assert.equal((await service.media('https://cdn.test/token-1/channel/segment.ts', original.playback)).url, later.url);
});

test('transient renewal failure preserves valid media, expired sessions reauthorize, and DRM is not treated as clear HLS', async () => {
  let clock = time, failing = false, renewalFails = false, drm = null, generation = 0;
  const service = createSportsPlayback({ now: () => clock, request: async (url, from, options) => {
    if (options?.method === 'POST') {
      if (failing || renewalFails && url.endsWith('/renew')) throw Error('Temporarily unavailable');
      return { text: JSON.stringify({ ...auth(++generation, clock), drm }) };
    }
    return { text: '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' };
  } });
  const stream = await service.resolve(markup, player, referer);
  clock += 301000; failing = true;
  assert.equal((await service.media(stream.url, stream.playback)).url, stream.url);
  clock += 3600000;
  await assert.rejects(service.media(stream.url, stream.playback), /Temporarily unavailable/);
  failing = false; renewalFails = true;
  assert.equal((await service.media(stream.url, stream.playback)).url, auth(2).sources[0].url);
  clock += 3600000; drm = { system: 'widevine', license_url: 'https://license.test/' };
  await assert.rejects(service.media(stream.url, stream.playback), /requires a DRM player/);
});

test('StreamFree uses the published HLS configuration, renews it, and relays its MPEG-TS CDN fallback', async () => {
  let clock = time, requests = 0;
  const player = 'https://sports-player.test/embed/basketball/team-a-vs-team-b1080p';
  const page = () => `<script>
    const QUALITY = '1080p'; const SOURCE_SUFFIX = ''; const VARIANT = 'team-a-vs-team-b' + QUALITY + SOURCE_SUFFIX;
    const _0x = ${JSON.stringify({ '1080p': { _t: 'fixture-token-' + requests, _e: clock / 1000 + 3600, _n: 'fixture-nonce' } })};
    const data = await window.sfFetch('/get-stream-key/team-a-vs-team-b').then(r => r.json());
    throw Error('The server must never execute player code');
  </script>`;
  const service = createSportsPlayback({ now: () => clock, request: async url => {
    if (url === player) return { text: page() };
    if (url.endsWith('/get-stream-key/team-a-vs-team-b')) { requests++; return { text: JSON.stringify({ server_name: 'externalcdn', is_external: false }) }; }
    assert.ok(url.startsWith('https://sports-player.test/live-externalcdn/team-a-vs-team-b1080p/index.m3u8?'));
    return { text: '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' };
  } });
  const stream = await service.resolve(page(), player, referer);
  assert.equal(stream.playback.provider, 'streamfree');
  assert.equal(new URL(stream.url).searchParams.get('_t'), 'fixture-token-0');
  const fallback = 'https://cdn.sports-player.test/live/team-a/segment.js';
  const original = 'https://image-cdn.test/frame.webp#sf=' + encodeURIComponent(fallback);
  const segment = await service.media(original, stream.playback);
  assert.equal(segment.url, fallback); assert.equal(segment.headers.referer, player);
  assert.equal(sportsMediaURL(original,stream.playback),fallback);
  assert.equal(sportsMediaURL(original.replace('frame.webp','updated-image-token.webp'),stream.playback),fallback,'Use the stable video fallback before signing a segment link');
  assert.equal((await service.media('https://cdn.sports-player.test/audio.aac', stream.playback)).url, 'https://cdn.sports-player.test/audio.aac');
  clock += 1801000;
  const renewed = await Promise.all([service.media(stream.url, stream.playback), service.media(original, stream.playback)]);
  assert.equal(requests, 2);
  assert.equal(new URL(renewed[0].url).searchParams.get('_t'), 'fixture-token-1');
  assert.equal(renewed[1].url, fallback);
  await assert.rejects(service.media('https://image-cdn.test/frame.webp#sf=' + encodeURIComponent('file:///etc/passwd'), stream.playback), /Invalid sports media URL/);
});
