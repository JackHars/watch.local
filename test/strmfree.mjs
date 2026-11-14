import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStrmfreeSource, matchStrmfreeEvent, rawStrmfreeURL } from '../api/strmfree.mjs';
import { createSportsProvider } from '../api/sports.mjs';
import { probeSportsStream } from '../api/sports-probe.mjs';
import { sportsMediaURL } from '../api/sports-playback.mjs';

const now = 1800000000000;
const event = { sport: 'nba', title: 'Philadelphia 76ers vs Toronto Raptors', starts_at: now / 1000 - 60, ends_at: now / 1000 + 7200, slug: 'nba/2027-01-15/test-game', has_payload: true, stream_url: 'https://primary.test/live.m3u8' };
const candidate = { key: 'fixture-game', name: 'Toronto Raptors vs Philadelphia 76ers', category: 'basketball', league: 'NBA', match_timestamp: event.starts_at };

test('sports matching uses both teams, league and start time, tolerates reversed teams and rejects ambiguous or unrelated feeds', () => {
  assert.equal(matchStrmfreeEvent(event, [candidate]), candidate);
  assert.equal(matchStrmfreeEvent(event, [{ ...candidate, name: 'Toronto Raptors vs Detroit Pistons' }]), null);
  assert.equal(matchStrmfreeEvent(event, [{ ...candidate, match_timestamp: event.starts_at - 86400 }]), null);
  assert.equal(matchStrmfreeEvent(event, [{ ...candidate, league: 'WNBA' }]), null);
  assert.equal(matchStrmfreeEvent(event, [{ ...candidate, name: 'NBA TV' }]), null);
  assert.equal(matchStrmfreeEvent(event, [candidate, { ...candidate, key: 'another-broadcast' }]), null);
  assert.equal(matchStrmfreeEvent({ ...event, always_live: true }, [candidate]), null);
  const hockey = { ...event, sport: 'nhl', title: 'Utah Mammoth vs St. Louis Blues' };
  const nhl = { ...candidate, category: 'hockey', league: 'NHL', name: 'Saint Louis Blues vs Utah Mammoth' };
  assert.equal(matchStrmfreeEvent(hockey, [nhl]), nhl);
  const college = { ...event, sport: 'cfb', title: 'South Florida vs Memphis' };
  const ncaa = { ...candidate, category: 'football', league: 'NCAAF', name: 'Memphis Tigers vs South Florida Bulls' };
  assert.equal(matchStrmfreeEvent(college, [ncaa]), ncaa);
  const monroe = { ...candidate, category: 'football', league: 'NCAAF', name: "Louisiana Ragin' Cajuns vs UL Monroe Warhawks" };
  assert.equal(matchStrmfreeEvent({ ...event, sport: 'cfb', title: 'Louisiana-Monroe vs Louisiana' }, [monroe]), monroe);
});

test('Strmfree tries healthy mirrors, refreshes signatures and converts P2P references to raw TS with CDN-specific headers', async () => {
  let time = now, embeds = 0, catalogs = 0, metadata = 0;
  const video = Buffer.alloc(188 * 4, 0x47), requests = [];
  const source = createStrmfreeSource({ now: () => time, mirrors: ['down.test', 'mirror.test'], directoryURL: null,
    fetchResource: async (url, options) => {
      const u = new URL(url), headers = new Headers(options.headers); requests.push(u.hostname + u.pathname);
      if (u.hostname === 'down.test') return new Response('Unavailable', { status: 503 });
      if (u.pathname === '/streams') { catalogs++; return Response.json({ streams: { basketball: [{ ...candidate, stream_key: candidate.key }] } }); }
      if (u.pathname.startsWith('/get-stream-key/')) { metadata++; return Response.json({ server_name: 'cdn' }); }
      if (u.pathname.startsWith('/embed/')) { embeds++; const sign={ _t: 'fixture-signature-' + embeds, _e: time / 1000 + 120, _n: 'fixture-nonce' };return new Response('const _0x = ' + JSON.stringify({ '1080p': sign, '2160p': sign }) + ';'); }
      if (u.pathname.endsWith('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://img.ttcdn-us.com/chunk.png#sf=' + encodeURIComponent('https://cdn1.strmfree.st/live/test/1.js') + '\n');
      if (u.hostname === 'cdn1.strmfree.st') {
        assert.equal(headers.get('origin'), 'https://strmfree.st'); assert.equal(headers.get('referer'), 'https://strmfree.st/');
        return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
      }
      assert.fail('Unexpected fixture host');
    } });
  const first = await source.resolve(event); assert.equal(first.playback.provider, 'strmfree');
  await source.verify(first); assert.equal(catalogs, 1); assert.equal(embeds, 1);
  assert.ok(!requests.some(path => path.startsWith('img.ttcdn')));
  assert.ok(!requests.some(path => path.includes('2160p')), 'A generic sign table is not proof of a 4K broadcast');
  assert.equal(sportsMediaURL('https://img.ttcdn-us.com/a.png#sf=' + encodeURIComponent('https://cdn1.strmfree.st/live/test/1.js'), first.playback), 'https://cdn1.strmfree.st/live/test/1.js');
  await source.resolve(event); assert.equal(metadata, 1);
  time += 100000;
  const renewed = await source.media(first.url, first.playback); assert.notEqual(renewed.url, first.url); assert.equal(embeds, 2);
  assert.equal(source.status().events, 1);
  await assert.rejects(source.resolve({ ...event, title: 'Different Team vs Another Team' }), { status: 503 });
  assert.equal(metadata, 2, 'Unmatched events must not resolve an arbitrary broadcast');
  for (const value of ['https://img.ttcdn-us.com/no-raw.png', 'https://cdn.test/a#sf=%', 'https://cdn.test/a#sf=http://127.0.0.1/private', 'file:///etc/passwd']) assert.throws(() => rawStrmfreeURL(value));
});

test('a changed mirror directory does not admit local addresses and malformed catalog responses fall through to another mirror', async () => {
  const calls = [];
  const source = createStrmfreeSource({ mirrors: ['strmfree.st'], now: () => now, fetchResource: async url => {
    const u = new URL(url); calls.push(u.hostname);
    if (u.hostname === 'strmfree.link') return Response.json(['http://127.0.0.1', 'https://strmfree.pk', 'bad.local', 'strmfree.st']);
    if (u.hostname === 'strmfree.pk') return new Response('<html>Maintenance</html>');
    if (u.hostname === 'strmfree.st') return Response.json({ streams: { basketball: [{ ...candidate, stream_key: candidate.key }] } });
    assert.fail('Untrusted mirror');
  } });
  assert.equal((await source.events()).length, 1); assert.deepEqual(calls, ['strmfree.link', 'strmfree.pk', 'strmfree.st']);
  await source.events(); assert.equal(calls.length, 3);
});

test('video preflight rejects bad segments and follows only the highest master variant and its encryption key', async () => {
  const stream = { url: 'https://video.test/master.m3u8' }, calls = [];
  let broken = false;
  const fetchResource = async url => {
    calls.push(url);
    if (url.endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000,RESOLUTION=1920x1080\nhigh.m3u8\n');
    if (url.endsWith('/high.m3u8')) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\n1.ts\n');
    if (url.endsWith('/key.bin')) return new Response(Buffer.alloc(16));
    if (url.endsWith('/1.ts')) return broken ? new Response('<html>Try later</html>') : new Response(Buffer.alloc(752, 42));
    assert.fail('Unexpected variant');
  };
  await probeSportsStream(stream, { fetchResource }); assert.ok(!calls.some(url => url.includes('low.m3u8')));
  broken = true; await assert.rejects(probeSportsStream(stream, { fetchResource }), /page or image/);
});

test('sports resolution falls back on failure, failed video preflight and timeout, preserves IDs and honors disabling', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-sports-fallback-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let mode = 'healthy', fallbackCalls = 0, enabled = true;
  const source = {
    list: async sport => ({ events: sport === 'nba' ? [event] : [] }),
    async resolve(value) { if (mode === 'error') throw Error('Primary unavailable'); if (mode === 'timeout') return new Promise(() => {}); return value; },
    hls: async value => ({ url: value.stream_url }),
    async verify() { if (mode === 'bad-video') throw Error('Bad primary video'); },
  };
  const alternate = { url: 'https://alternate.test/backup.m3u8', playback: { provider: 'strmfree', root: 'https://alternate.test/backup.m3u8' } };
  const fallback = { resolve: async value => { assert.equal(value.title, event.title); fallbackCalls++; return alternate; }, verify: async () => {} };
  const p = createSportsProvider({ directory, source, fallback, fallbackEnabled: () => enabled, now: () => now, providerTimeout: 30 }); await p.initialize();
  const rows = await p.rows(String), id = rows[0].stream_id;
  const primary = await p.resolve(id); assert.equal(primary.playback.sportsSource, 'primary'); assert.equal(fallbackCalls, 0);
  for (mode of ['error', 'bad-video', 'timeout']) {
    const selected = await p.resolve(id, { fresh: true }); assert.equal(selected.playback.sportsSource, 'strmfree'); assert.equal(selected.playback.eventId, id);
  }
  assert.equal(fallbackCalls, 3); assert.equal((await p.rows(String))[0].stream_id, id);
  assert.equal((await p.media(primary.url, primary.playback)).url, alternate.url);
  const current = await p.resolve(id); assert.equal(fallbackCalls, 3);
  enabled = false; mode = 'error'; await assert.rejects(p.resolve(id), /Primary unavailable/);
  await assert.rejects(p.media(current.url, current.playback), { status: 403 }); assert.equal(fallbackCalls, 3);
  enabled = true; mode = 'healthy'; const retry = await p.resolve(id, { fresh: true });
  const recovered = await p.recover(retry.playback); assert.equal(recovered.playback.sportsSource, 'strmfree');
  assert.equal((await p.rows(String)).length, 1);
});

// Simulate mirrors that answer metadata while their actual video is unavailable.
function fallbackFixture({ mirrors = ['first.test', 'second.test'], published, working }) {
  const calls = [], video = Buffer.alloc(752, 0x47);
  const source = createStrmfreeSource({ now: () => now, mirrors, directoryURL: null, fetchResource: async (url, options) => {
    const u = new URL(url), headers = new Headers(options.headers); calls.push(u.hostname + u.pathname);
    if (u.pathname === '/streams') return Response.json({ streams: { basketball: [{ ...candidate, stream_key: candidate.key }] } });
    if (u.pathname.startsWith('/get-stream-key/')) return Response.json({ server_name: 'origin' });
    if (u.pathname.startsWith('/api/v1/sources/')) return published ? Response.json({ stream_key: candidate.key, sources: published(u.hostname) }) : new Response('Not found', { status: 404 });
    if (u.pathname.startsWith('/embed/')) {
      const sign = { _t: 'fixture-' + (u.pathname.endsWith('_2') ? 'backup' : 'main'), _e: now / 1000 + 3600, _n: 'fixture-nonce' };
      return new Response('const _0x = ' + JSON.stringify({ '1080p': sign, '720p': sign, '540p': sign }) + ';');
    }
    if (u.pathname.endsWith('index.m3u8') || u.pathname.endsWith('segment.ts')) {
      assert.equal(headers.get('origin'), u.origin);
      assert.ok(headers.get('referer').startsWith(u.origin + '/embed/'), 'Manifest and segment requests require player headers');
      if (u.pathname.endsWith('index.m3u8')) {
        assert.equal(u.searchParams.get('_t'), u.pathname.includes('_2/') ? 'fixture-backup' : 'fixture-main');
        return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
      }
      return new Response(working(u) ? video : '<html>No video</html>');
    }
    assert.fail('Unexpected fallback request');
  } });
  return { source, calls };
}
const publishedFeed = (quality = '1080p', suffix = '') => ({ live: true, url: `/embed/basketball/${candidate.key}${quality}${suffix}` });

test('Strmfree keeps trying mirrors after valid metadata and playlists fail video checks', async () => {
  const { source, calls } = fallbackFixture({ working: url => url.hostname === 'second.test' });
  const stream = await source.resolve(event);
  assert.equal(new URL(stream.url).hostname, 'second.test');
  for (const quality of ['1080p', '720p', '540p']) assert.ok(calls.includes(`first.test/live/${candidate.key}${quality}/segment.ts`));
  const before = calls.length; assert.equal(await source.resolve(event), stream); assert.equal(calls.length, before, 'Only the verified winner is cached');
});

test('Strmfree falls back to a working lower rendition after a valid HD playlist returns bad video', async () => {
  const { source, calls } = fallbackFixture({ working: url => url.pathname.includes('720p/') });
  const stream = await source.resolve(event);
  assert.equal(new URL(stream.url).pathname, `/live/${candidate.key}720p/index.m3u8`);
  assert.ok(!calls.some(path => path.startsWith('second.test')), 'A good lower rendition avoids unnecessary mirror requests');
});

test('Strmfree follows published numbered backups, skips offline feeds and does not reuse another feed signature', async () => {
  const { source, calls } = fallbackFixture({
    published: host => host === 'first.test' ? [] : [{ ...publishedFeed('540p'), live: false }, publishedFeed(), publishedFeed('1080p', '_2')],
    working: url => url.pathname.includes('_2/'),
  });
  const stream = await source.resolve(event);
  assert.equal(new URL(stream.url).pathname, `/live/${candidate.key}1080p_2/index.m3u8`);
  assert.ok(!calls.some(path => path.startsWith('first.test/embed/') || path.startsWith('first.test/live/')), 'Do not guess signed URLs when the mirror has no live feeds');
  assert.ok(!calls.some(path => path.includes('540p')), 'Do not request an explicitly offline feed');
  assert.ok(calls.includes(`second.test/embed/basketball/${candidate.key}1080p_2`));
});

test('an unpublished event reports unavailable video and a fresh retry can pick up a newly published feed', async () => {
  let live = false;
  const { source, calls } = fallbackFixture({ published: () => live ? [publishedFeed()] : [], working: () => true });
  await assert.rejects(source.resolve(event), { status: 503, message: 'Strmfree has not published live video for this event yet.' });
  assert.ok(calls.includes('first.test/api/v1/sources/' + candidate.key));
  assert.ok(calls.includes('second.test/api/v1/sources/' + candidate.key));
  assert.ok(!calls.some(path => path.includes('/embed/') || path.includes('/live/')));
  live = true; assert.ok((await source.resolve(event, { fresh: true })).url);
});

test('exhausting enabled sports providers returns an availability error instead of the last mirror HTTP error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-sports-unavailable-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const tried = [];
  const source = { list: async sport => ({ events: sport === 'nba' ? [event] : [] }), resolve: async () => { tried.push('primary'); throw Error('Unsupported advertising page'); } };
  const fallback = { resolve: async () => { tried.push('fallback'); throw Object.assign(Error('Strmfree returned HTTP 403.'), { status: 502 }); } };
  const provider = createSportsProvider({ directory, source, fallback, now: () => now }); await provider.initialize();
  const [{ stream_id }] = await provider.rows(String);
  await assert.rejects(provider.resolve(stream_id), error => error.status === 503 && /All enabled sports sources were tried/.test(error.message) && !error.message.includes('403'));
  assert.deepEqual(tried, ['primary', 'fallback']);
});
