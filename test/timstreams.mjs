import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimstreamsSource, timstreamsTicket, decodeTimstreamsTicket } from '../api/timstreams.mjs';

const ticket = 'https://video.test/p/fixture-ticket';
const media = 'https://video.test/live/channel.m3u8';
const packed = code => `<script>(function(){var _data=[${[...code].map(c => ((c.charCodeAt(0) + 251) % 256) ^ 221).join(',')}],_xor=221,_shift=251,_text='';window.eval(_text);})();</script>`;
const encode = (url, seed = 31) => {
  const key = new URL(ticket).pathname.split('/').pop();
  return Buffer.from([seed, ...[...url].map((c, i) => c.charCodeAt(0) ^ key.charCodeAt(i % key.length) ^ ((seed + i) & 255))]);
};
const config = packed(`globalThis.__timExecuted = true; loadStreamUrl("${ticket}", function(url) {});`);

test('Tim Streams decodes only configuration data and bounded HLS tickets, never player code', () => {
  assert.equal(timstreamsTicket(config), ticket); assert.equal(globalThis.__timExecuted, undefined);
  assert.equal(decodeTimstreamsTicket(encode(media), ticket), media);
  for (const html of ['', packed('console.log("No stream")'), packed('loadStreamUrl("https://localhost/p/fixture-ticket", cb)'), 'x'.repeat(1024 * 1024 + 1)]) assert.throws(() => timstreamsTicket(html), { status: 502 });
  for (const url of ['http://video.test/live.m3u8', 'https://127.0.0.1/live.m3u8', 'https://watch.local/live.m3u8', 'https://user:pass@video.test/live.m3u8', 'https://video.test/error.html']) assert.throws(() => decodeTimstreamsTicket(encode(url), ticket), { status: 502 });
  assert.throws(() => decodeTimstreamsTicket(Buffer.alloc(9000), ticket), { status: 502 });
});

test('Tim Streams imports stable channels, genres and source alternatives without persisting signed tickets', async () => {
  const source = createTimstreamsSource({ fetchResource: async url => {
    assert.equal(url, 'https://tim-streams.com/api/channels');
    return Response.json({ channels: [
      { url: 'fixture-news', name: 'Fixture\nNews', genre: 5, flag: 'us', streams: [{ url: 'https://player.test/news' }, { url: 'https://player.test/news' }, { url: 'https://player.test/backup' }, { url: 'javascript:bad()' }] },
      { url: 'empty', name: 'Empty', streams: [] },
      { url: '../unsafe', name: 'Unsafe', streams: [{ url: 'https://player.test/' }] },
    ] });
  } });
  const rows = await source.list();
  assert.equal(rows.length, 1); assert.equal(rows[0].key, 'fixture-news'); assert.equal(rows[0].name, 'Fixture News');
  assert.equal(rows[0].category, 'news'); assert.equal(rows[0].flag, 'US'); assert.equal(rows[0].provider, 'timstreams');
  assert.deepEqual(rows[0].sources, ['https://player.test/news', 'https://player.test/backup']);
  assert.ok(!JSON.stringify(rows).includes('fixture-ticket'));
});

test('Tim Streams follows player redirects, supplies headers and checks actual video before returning playback', async () => {
  const visited = []; let broken = false;
  const fetchResource = async (value, options) => {
    const url = new URL(value); visited.push(url.pathname);
    assert.equal(options.headers['user-agent'], 'Mozilla/5.0');
    if (url.hostname === 'player.test') {
      assert.equal(options.headers.referer, 'https://tim-streams.com/');
      if (url.pathname === '/channel') return new Response(null, { status: 302, headers: { location: '/play/fixture-session' } });
      return new Response(config);
    }
    assert.equal(options.headers.referer, 'https://player.test/play/fixture-session'); assert.equal(options.headers.origin, 'https://player.test');
    if (url.pathname.startsWith('/p/')) return new Response(encode(media));
    if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk.ts\n');
    if (broken) return new Response('Unavailable', { status: 403 });
    const ts = Buffer.alloc(188 * 4); for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
    return new Response(ts);
  };
  const source = createTimstreamsSource({ fetchResource });
  const result = await source.resolve('https://player.test/channel'); assert.equal(result.url, media);
  assert.deepEqual(visited, ['/channel', '/play/fixture-session', '/p/fixture-ticket', '/live/channel.m3u8', '/live/chunk.ts']);
  broken = true; await assert.rejects(source.resolve('https://player.test/channel'), /Tim Streams video check returned HTTP 403/);
  const unsafe = createTimstreamsSource({ fetchResource: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  await assert.rejects(unsafe.resolve('https://player.test/channel'), /unsupported media address/);
});

test('channel grouping combines broadcaster backups while preserving regional channels and numbered networks', async () => {
  const { groupChannels } = await import('../api/channel-groups.mjs');
  const row = (title, country, id, extra = {}) => ({ title, country, kind: 'channel', stream_id: id, ...extra });
  const groups = groupChannels([
    row('ESPN', 'US', 1), row('ESPN HD Backup 2', 'US', 2), row('ESPN', 'GB', 3), row('ESPN2', 'US', 4),
    row('ESPN', 'US', 5, { artwork: '/logo.png', program: 'The game', starts_at: 10, ends_at: 20 }),
    { title: 'A game', kind: 'event', stream_id: 6 },
  ]);
  assert.equal(groups.length, 3); assert.deepEqual(groups[0].members.map(row => row.stream_id), [1, 2, 5]);
  assert.equal(groups[0].item.stream_id, 1); assert.equal(groups[0].item.artwork, '/logo.png'); assert.equal(groups[0].item.program, 'The game');
});

test('Tim Streams keeps stable IDs and renews the player headers alongside signed streams', async () => {
  const { createTimstreamsProvider, TIMSTREAMS_ID_BASE } = await import('../api/timstreams.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(tmpdir() + '/watchlocal-timstreams-'); let clock = Date.now(), generation = 1, offline = false;
  const source = {
    list: async () => { if (offline) throw Error('Offline'); return [{ key: 'fixture', name: 'Fixture Channel', category: 'news', flag: 'US', sources: ['https://player.test/fixture'] }]; },
    resolve: async () => ({ url: `https://video.test/${generation}/live.m3u8`, headers: { referer: `https://player.test/play/${generation}` } }),
  };
  try {
    const provider = createTimstreamsProvider({ directory, source, now: () => clock }); await provider.initialize();
    const rows = await provider.rows(String); const id = rows[0].stream_id; assert.ok(id > TIMSTREAMS_ID_BASE);
    const first = await provider.resolve(id); clock += 61000; generation++;
    const renewed = await provider.media(first.url, first.playback);
    assert.equal(renewed.url, 'https://video.test/2/live.m3u8'); assert.equal(renewed.headers.referer, 'https://player.test/play/2');
    assert.equal(renewed.playback.provider, 'timstreams');
    const restored = createTimstreamsProvider({ directory, source, now: () => clock }); await restored.initialize();
    offline = true; await restored.refresh({ force: true }); assert.equal((await restored.rows(String))[0].stream_id, id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
