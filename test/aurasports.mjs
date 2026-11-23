import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAurasportsSource, matchAurasportsEvent } from '../api/aurasports.mjs';
import { wrappedVideo, video } from './zlive-fixtures.mjs';

const start = 1794961800;
const event = { sport: 'nba', title: 'Toronto Raptors vs New York Knicks', starts_at: start };
const row = { id: 'espn-401910002', date: start * 1000, teams: { home: { name: 'Toronto Raptors' }, away: { name: 'New York Knicks' } }, sources: [
  { url: 'https://play.aurasportsplayer.cfd/event/espn-401910002?source=0' },
  { url: 'https://play.aurasportsplayer.cfd/event/espn-401910002?source=1' },
] };
const groups = [{ category_name: 'nba', schedule: [row] }];

test('AuraSports matches the exact teams, sport and start time', () => {
  assert.equal(matchAurasportsEvent(event, groups), row);
  assert.equal(matchAurasportsEvent({ ...event, title: 'New York Knicks vs Toronto Raptors' }, groups), row);
  assert.equal(matchAurasportsEvent({ ...event, title: 'Toronto Raptors vs Brooklyn Nets' }, groups), null);
  assert.equal(matchAurasportsEvent({ ...event, sport: 'nhl' }, groups), null);
  assert.equal(matchAurasportsEvent({ ...event, starts_at: start + 3 * 3600 }, groups), null);
  assert.equal(matchAurasportsEvent(event, [{ ...groups[0], schedule: [row, { ...row, id: 'espn-401910003' }] }]), null);
});

test('AuraSports rejects unsupported embeds and decodes PNG video before selecting its next source', async () => {
  const calls = [], image = wrappedVideo();
  const fetchResource = async (input, options = {}) => {
    const url = new URL(input), headers = new Headers(options.headers); calls.push(url.href);
    if (url.pathname === '/api/schedule') return Response.json(groups);
    if (url.hostname === 'play.aurasportsplayer.cfd') return new Response(`<iframe src="${url.searchParams.get('source') === '0' ? 'https://ads.example/frame/espn-401910002' : 'https://frame.embedme.cfd/frame/espn-401910002?source=1'}"></iframe>`);
    if (url.hostname === 'frame.embedme.cfd') return new Response('var streamUrl = "https://hls.meth-streams-hd.cfd/live/espn-401910002/index.m3u8";');
    if (url.hostname === 'hls.meth-streams-hd.cfd') return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://cdn.test/first.image\n#EXTINF:6,\nhttps://cdn.test/second.image\n');
    if (url.hostname === 'cdn.test') { assert.equal(headers.get('range'), null, 'encoded PNG needs a complete upstream response'); return new Response(image, { headers: { 'content-type': 'image/png' } }); }
    assert.fail('Unexpected fetch: ' + url);
  };
  const source = createAurasportsSource({ fetchResource });
  const stream = await source.resolve(event);
  assert.equal(stream.playback.provider, 'aurasports');
  assert.equal(stream.url, 'https://hls.meth-streams-hd.cfd/live/espn-401910002/index.m3u8');
  assert.ok(calls.some(url => url.includes('source=1')));
  assert.ok(calls.some(url => url.endsWith('first.image')));
  assert.equal(video[0], 0x47);
  const count = calls.length;
  assert.equal((await source.resolve(event)).url, stream.url);
  assert.equal(calls.length, count, 'successful source is cached briefly');
  assert.equal((await source.media(stream.url, stream.playback)).headers.origin, 'https://frame.embedme.cfd');
});

test('an event player with no published playlist stays unavailable', async () => {
  const source = createAurasportsSource({ fetchResource: async input => {
    const url = new URL(input);
    if (url.pathname === '/api/schedule') return Response.json(groups);
    if (url.hostname === 'play.aurasportsplayer.cfd') return new Response('<iframe src="https://frame.aurasportsplayer.cfd/frame/espn-401910002"></iframe>');
    assert.equal(url.hostname, 'frame.aurasportsplayer.cfd');
    return new Response('<title>Coverage starts later</title>');
  } });
  await assert.rejects(source.resolve(event), { status: 503, message: /not published a playlist/ });
});

test('AuraSports only requests links declared for the selected event and checks redirects', async () => {
  const visited = [];
  const source = createAurasportsSource({ fetchResource: async input => {
    const url = new URL(input); visited.push(url.href);
    if (url.pathname === '/api/schedule') return Response.json([{ category_name: 'nba', schedule: [{ ...row, sources: [
      { url: 'https://127.0.0.1/event/' + row.id }, { url: 'https://wrong.example/event/espn-987' },
      { url: 'https://publisher.example/event/' + row.id },
    ] }] }]);
    if (url.hostname === 'publisher.example') return new Response('<iframe src="https://advert.example/frame/' + row.id + '"></iframe>' +
      '<iframe allowfullscreen src="https://different-game.example/frame/espn-987"></iframe>' +
      '<iframe id="player-frame" src="/frame/' + row.id + '"></iframe>');
    assert.fail('Unexpected host');
  } });
  // The relative frame links back to the wrapper. Only one embedded page is followed.
  await assert.rejects(source.resolve(event));
  assert.deepEqual(visited.map(v => new URL(v).hostname), ['aurasports.cfd', 'publisher.example', 'publisher.example']);

  const redirects = [];
  const redirected = createAurasportsSource({ fetchResource: async input => {
    const url = new URL(input); redirects.push(url.hostname);
    if (url.pathname === '/api/schedule') return Response.json([{ category_name: 'nba', schedule: [{ ...row, sources: [], iframeUrl: 'https://player.example/event/' + row.id }] }]);
    return Response.redirect('https://private.lan/frame/' + row.id, 302);
  } });
  await assert.rejects(redirected.resolve(event), /unsupported/);
  assert.deepEqual(redirects, ['aurasports.cfd', 'player.example']);
});

test('a replacement manifest redirect cannot select a different game or the excluded feed', async () => {
  const contacted = [];
  const obsolete = 'https://old.example/stream';
  const source = createAurasportsSource({ fetchResource: async input => {
    const url = new URL(input); contacted.push(url.hostname);
    if (url.pathname === '/api/schedule') return Response.json([{ category_name: 'nba', schedule: [{ ...row, sources: [], watchUrl: 'https://event.example/watch/opaque' }] }]);
    if (url.hostname === 'event.example') return new Response('<video><source src="https://alias.example/wrong.m3u8"><source src="https://alias.example/old.m3u8"></video>');
    assert.equal(url.hostname, 'alias.example');
    return Response.redirect(url.pathname === '/old.m3u8' ? obsolete : 'https://wrong-game.example/live/espn-123/playlist.m3u8');
  } });
  await assert.rejects(source.resolve(event, { fresh: true, excludeURL: obsolete }), /unsupported/);
  assert.deepEqual(contacted, ['aurasports.cfd', 'event.example', 'alias.example', 'alias.example']);
});
