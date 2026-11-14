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

test('follows event Watch links and encoded alternate players without following ads or looping', async () => {
  const directory = page('') + '<a href="https://ads.test/">Ad</a><table class="links-table"><tr><td><a class="watch-btn" href="https://watch.test/match">Watch</a></td></tr></table>';
  const parsed = parseSportsEvent(directory, event);
  assert.equal(parsed.has_payload, true); assert.equal(parsed.stream_url, 'https://watch.test/match');
  const calls = [];
  const source = createSportsSource({ hosts: ['sports.test'], fetchResource: async url => {
    calls.push(url);
    if (url.includes('/live/')) return new Response(directory);
    if (url === 'https://watch.test/match') return new Response(page('https://player.test/broken') + `<script>var ad = '&lt;/script&gt;&lt;script&gt;';</script><button class="stream-btn" data-e="${encoded('https://player.test/working')}">Alternate</button><iframe src="https://watch.test/match"></iframe>`);
    if (url === 'https://player.test/broken') return new Response('Unavailable', { status: 503 });
    if (url === 'https://player.test/working') return new Response('<source src="/live.m3u8">');
    if (url === 'https://player.test/live.m3u8') return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
    assert.fail('Unexpected sports request');
  } });
  const result = await source.hls(await source.resolve(event));
  assert.equal(result.url, 'https://player.test/live.m3u8');
  assert.equal(result.headers.referer, 'https://player.test/working');
  assert.equal(calls.filter(url => url === 'https://watch.test/match').length, 1);
  assert.ok(!calls.some(url => url.includes('ads.test')));
});

test('a saturated schedule crawl does not block playback requests', { timeout: 3000 }, async () => {
  const blocked = Promise.withResolvers(), saturated = Promise.withResolvers();
  let background = 0;
  const source = createSportsSource({ hosts: ['sports.test'], fetchResource: async url => {
    if (url.endsWith('/nba')) return new Response(Array.from({ length: 4 }, (_, i) => `<a href="/live/nba/2027-01-15/game-${i}">Game</a>`).join(''));
    if (url.includes('/live/')) {
      if (++background === 4) saturated.resolve();
      await blocked.promise;
      return new Response(page('https://player.test/live.m3u8'));
    }
    return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n');
  } });
  const listing = source.list('nba');
  try {
    await saturated.promise;
    const result = await source.hls({ ...event, stream_url: 'https://player.test/live.m3u8' });
    assert.equal(result.url, 'https://player.test/live.m3u8');
    assert.equal(background, 4, 'Playback started while all catalog slots were occupied');
  } finally { blocked.resolve(); await listing; }
});

test('tries supported sports players first and retains other published players as fallbacks', async () => {
  const known = 'https://strmfree.st/embed/basketball/fixture1080p', other = 'https://player.test/embed';
  const calls = []; let supportedAvailable = true;
  const source = createSportsSource({ fetchResource: async url => {
    calls.push(url);
    if (url === known && !supportedAvailable) return new Response('Unavailable', { status: 503 });
    return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n');
  } });
  const item = { ...event, stream_urls: [other, known] };
  assert.equal((await source.hls(item)).url, known);
  assert.deepEqual(calls, [known]);
  supportedAvailable = false; calls.length = 0;
  assert.equal((await source.hls(item)).url, other);
  assert.deepEqual(calls, [known, other]);
});

test('simultaneous viewers share resolution, check only their game, and can retry a failed lookup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-live-start-'));
  const ready = Promise.withResolvers(), release = Promise.withResolvers(), statuses = [];
  let lookups = 0, shouldFail = false, ended = false;
  const source = {
    async list(sport) { return { events: ['nba', 'nhl'].includes(sport) ? [{ ...event, sport, slug: `${sport}/2027-01-15/team-a-vs-team-b` }] : [] }; },
    async status(events) { statuses.push(events.map(e => e.sport)); return new Map(events.map(e => [e.slug, { state: ended ? 'ENDED' : 'LIVE', checkedAt: time }])); },
    async resolve(stored) { lookups++; ready.resolve(); await release.promise; if (shouldFail) throw Error('Temporary failure'); return { ...stored, has_payload: true, stream_url: 'https://player.test/live.m3u8' }; },
    async hls(item) { return { url: item.stream_url, playback: { provider: 'fixture' } }; },
  };
  try {
    const provider = createSportsProvider({ directory, source, now: () => time }); await provider.initialize();
    const id = (await provider.browserRows()).find(e => e.sport === 'nba').stream_id;
    statuses.length = 0;
    const first = provider.resolve(id); await ready.promise;
    const second = provider.resolve(id);
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(lookups, 1); assert.equal(results[0], results[1]);
    assert.deepEqual(statuses, [['nba'], ['nba']]);
    await provider.resolve(id); assert.equal(lookups, 1);
    shouldFail = true; await assert.rejects(provider.resolve(id, { fresh: true }), /Temporary failure/);
    shouldFail = false; await provider.resolve(id, { fresh: true }); assert.equal(lookups, 3);
    ended = true; await assert.rejects(provider.resolve(id), { status: 410 });
  } finally { release.resolve(); await rm(directory, { recursive: true, force: true }); }
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

test('video preflight exhausts published direct, StreamControl and StreamFree backups before discarding the primary', { timeout: 3000 }, async t => {
  for (const kind of ['direct', 'control', 'free']) await t.test(kind, async () => {
    const calls = [], player = 'https://player.test/embed/basketball/fixture1080p';
    const urls = kind === 'free' ? ['https://player.test/live-cdn/fixture1080p/index.m3u8', 'https://player.test/live/fixture1080p/index.m3u8'] : ['https://video.test/broken/index.m3u8', 'https://video.test/working/index.m3u8'];
    const source = createSportsSource({ fetchResource: async (url, options) => {
      const u = new URL(url), headers = new Headers(options.headers); calls.push(u.origin + u.pathname);
      if (url === player) {
        if (kind === 'control') return new Response('<div id="scp" data-key="fixturechannel" data-hls="/hls.js"></div>');
        return new Response(`const QUALITY = '1080p'; const SOURCE_SUFFIX = ''; const VARIANT = 'fixture' + QUALITY + SOURCE_SUFFIX;
          const _0x = ${JSON.stringify({ '1080p': { _t: 'fixture-token', _e: Date.now() / 1000 + 3600, _n: 'fixture-nonce' } })};
          const data = await window.sfFetch('/get-stream-key/fixture');`);
      }
      if (u.pathname.endsWith('/authorize')) return Response.json({ ok: true, session: 'fixture-session', expires: Date.now() / 1000 + 3600, renew_in: 300, sources: urls.map((url, id) => ({ id: String(id), url })) });
      if (u.pathname.startsWith('/get-stream-key/')) return Response.json({ server_name: 'cdn' });
      assert.match(headers.get('user-agent'), /Mozilla/, 'Preflight must use the same browser headers as playback');
      if (u.pathname.endsWith('index.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
      if (u.pathname.endsWith('segment.ts')) {
        assert.equal(headers.get('referer'), kind === 'direct' ? event.pageURL : player);
        const bad = u.pathname.includes('/broken/') || u.pathname.includes('/live-cdn/');
        return new Response(bad ? '<html>Unavailable</html>' : Buffer.alloc(752, 0x47));
      }
      assert.fail('Unexpected preflight request');
    } });
    const stream = await source.hls({ ...event, stream_urls: kind === 'direct' ? urls : [player] }, { verify: true });
    assert.equal(new URL(stream.url).origin + new URL(stream.url).pathname, urls[1]);
    assert.ok(calls.includes(new URL('segment.ts', urls[0]).href), 'First feed failed on video bytes, not its valid playlist');
    assert.ok(calls.includes(new URL('segment.ts', urls[1]).href), 'Second feed was verified before returning it');
  });
});
