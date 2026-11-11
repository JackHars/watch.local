import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSportsSource, createSportsProvider, parseSportsEvent, eventStatus, sportsArtworkURL } from '../api/sports.mjs';

const time = 1800000000000, start = time / 1000 - 60;
const event = { host: 'sports.test', sport: 'nba', slug: 'nba/2027-01-15/team-a-vs-team-b', title: 'Team A & Team B <Final>', starts_at: start, ends_at: start + 7200, always_live: false, has_payload: false, stream_url: null, pageURL: 'https://sports.test/event', icon: 'https://r2.thesportsdb.com/images/media/event/thumb/match.jpg' };
const encoded = text => Buffer.from(Buffer.from(text).map(byte => byte ^ 0x4f)).toString('base64');
const page = payload => `<h1>Team A &amp; Team B</h1><script>var sd = ${JSON.stringify({ starts_at: start, ends_at: start + 7200, e: encoded(payload) })};</script>`;

test('browser artwork accepts source images and rejects unsafe URLs or unrelated hosts',()=>{
  for(const url of [event.icon,'https://streameasto.cx/img/fixture','https://streamseast.ws/img/fixture','https://streamking.cx/img/fixture','https://www.thesportsdb.com/images/media/team/badge/team.png'])assert.equal(sportsArtworkURL(url),url);
  for(const url of ['',null,'data:image/svg+xml,anything','javascript:alert(1)','http://r2.thesportsdb.com/images/media/event/thumb/a.jpg','https://127.0.0.1/img/a','https://streameasto.cx.evil.test/img/a','https://name:secret@streameasto.cx/img/a','https://streameasto.cx:8443/img/a','https://streameasto.cx/live/nba/game'])assert.equal(sportsArtworkURL(url),'');
});

test('ports the Docker payload decoder without mistaking an event page for a stream', () => {
  const parsed = parseSportsEvent(page('<iframe src="//player.test/embed?id=1&amp;x=2"></iframe>'), event);
  assert.equal(parsed.title, 'Team A & Team B');
  assert.equal(parsed.stream_url, 'https://player.test/embed?id=1&x=2');
  assert.equal(parsed.has_payload, true); assert.equal(parsed.icon, '');
  assert.equal(parseSportsEvent(page(''), event).stream_url, null);
  assert.equal(eventStatus(parsed, () => time), 'LIVE');
  assert.equal(eventStatus(parsed, () => (start - 60) * 1000), 'UPCOMING');
  assert.equal(eventStatus(parsed, () => (start + 7200) * 1000), 'ENDED');
  assert.throws(() => parseSportsEvent('<html>Error</html>', event), /no sports metadata/);
});

test('discovers event metadata, follows player embeds to HLS and keeps required request headers', async () => {
  const calls = [];
  const source = createSportsSource({ hosts: ['sports.test'], fetchResource: async (url, options) => {
    calls.push({ url, headers: options.headers });
    const body = url.endsWith('/nba') ? `<a href="/live/${event.slug}">Match</a>` : url.includes('/live/') ? page('<iframe src="https://player.test/embed"></iframe>') : url === 'https://player.test/embed' ? '<iframe src="/frame"></iframe>' : url === 'https://player.test/frame' ? '<script>const player = {file: "/broadcast.m3u8?x=1&amp;y=2"};</script>' : '#EXTM3U\n#EXTINF:6,\nsegment.ts\n';
    return new Response(body);
  } });
  const listed = await source.list('nba'); assert.equal(listed.events.length, 1); assert.deepEqual(listed.errors, []);
  const live = await source.hls(await source.resolve(listed.events[0]));
  assert.equal(live.url, 'https://player.test/broadcast.m3u8?x=1&y=2');
  assert.equal(live.headers.referer, 'https://player.test/frame'); assert.equal(live.headers.origin, 'https://player.test');
  assert.equal(calls.at(-1).headers.Referer, live.headers.referer);
  const unsupported = createSportsSource({ fetchResource: async () => new Response('<html>Player requires JavaScript; no HLS link.</html>') });
  await assert.rejects(unsupported.hls({ ...event, stream_url: 'https://player.test/' }), { status: 502 });
});

test('stable IDs, categories, programme guides, refresh coalescing and preservation on source failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cinejoy-sports-'));
  let fail = false, calls = 0;
  const source = { async list(sport) { calls++; if (fail && sport === 'nba') throw Error('Unavailable'); return { events: sport === 'nba' ? [event] : [], errors: [] }; } };
  try {
    const p = createSportsProvider({ directory, source, now: () => time }); await p.initialize();
    await Promise.all([p.refresh(), p.refresh()]); assert.equal(calls, 11);
    const rows = await p.rows(id => `http://local/live/${id}.m3u8`), id = rows[0].stream_id;
    assert.equal(rows.length, 1); assert.equal(rows[0].stream_type, 'live'); assert.equal(rows[0].epg_channel_id, `sports-${id}`); assert.equal(rows[0].tv_archive, 0);
    const browser=(await p.browserRows())[0];assert.equal(browser.stream_id,id);assert.equal(browser.title,event.title);assert.equal(browser.sport,'nba');assert.equal(browser.category_name,'NBA');assert.equal(browser.artwork,event.icon);assert.equal(browser.starts_at,start);assert.equal(browser.status,'LIVE');assert.equal(browser.always_live,false);
    assert.deepEqual(await p.rows(String, 'unknown'), []);
    assert.equal((await p.categories())[0].category_name, 'Sports · NBA');
    const guide = await p.epg(id), program = guide.epg_listings[0];
    assert.equal(Buffer.from(program.title, 'base64').toString(), event.title); assert.equal(Number(program.start_timestamp), start); assert.equal(program.now_playing, 1);
    const xml = await p.xmltv(); assert.match(xml, /Team A &amp; Team B &lt;Final&gt;/); assert.match(xml, /channel="sports-1"/); assert.match(xml, /\+0000/);
    fail = true; await p.refresh(); assert.equal((await p.rows(String))[0].stream_id, id); assert.equal(p.status().errors.length, 1);
    const restarted = createSportsProvider({ directory, source, now: () => time }); await restarted.initialize(); assert.equal((await restarted.rows(String))[0].stream_id, id);
    assert.equal(p.status().withPlayer, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rechecks feeds on Play, distinguishes unpublished/upcoming/ended events, and expires stale listings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cinejoy-sports-'));
  let clock = time, published = false, resolveCalls = 0;
  const source = { async list(sport) { return { events: sport === 'nba' ? [event] : [], errors: [] }; }, async resolve(e) { resolveCalls++; return { ...e, has_payload: published, stream_url: published ? 'https://video.test/live.m3u8' : null }; }, async hls(e) { return { url: e.stream_url, headers: {} }; } };
  try {
    const p = createSportsProvider({ directory, source, now: () => clock }); await p.initialize(); const id = (await p.rows(String))[0].stream_id;
    await assert.rejects(p.resolve(id), { status: 503 }); published = true; assert.equal((await p.resolve(id)).url, 'https://video.test/live.m3u8'); assert.equal(resolveCalls, 2);
    await assert.rejects(p.resolve(999), { status: 404 });
    clock += 7200000; await assert.rejects(p.resolve(id), { status: 410 }); await p.refresh(); assert.equal((await p.rows(String)).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
