import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScorezoneSource, matchScorezoneEvent } from '../api/scorezone.mjs';

const start = Date.UTC(2026, 10, 18, 0, 30, 0);
const event = { title: 'Boston Bruins vs Los Angeles Kings', sport: 'nhl', starts_at: start / 1000 };
const stage = { Cnm: 'NHL', Events: [{ Eid: '1835287', Esd: '20261118003000', T1: [{ Nm: 'Boston Bruins' }], T2: [{ Nm: 'Los Angeles Kings' }] }] };
const video = Buffer.alloc(188 * 4, 0x47);

test('ScoreZone matches both teams, league and start time without substituting another game', () => {
  assert.equal(matchScorezoneEvent(event, [stage]).id, '1835287');
  assert.equal(matchScorezoneEvent({ ...event, title: 'Los Angeles Kings vs Boston Bruins' }, [stage]).id, '1835287');
  assert.equal(matchScorezoneEvent({ ...event, title: 'Boston Bruins vs New York Rangers' }, [stage]), null);
  assert.equal(matchScorezoneEvent({ ...event, sport: 'nba' }, [stage]), null);
  assert.equal(matchScorezoneEvent({ ...event, starts_at: event.starts_at + 7200 }, [stage]), null);
  assert.equal(matchScorezoneEvent(event, [stage, stage]), null);
});

test('ScoreZone verifies video, tries another channel, and renews a selected broadcast', async () => {
  let now = start, posts = 0, bad = true;
  const requests = [];
  const fetchResource = async (input, options = {}) => {
    const url = new URL(input), headers = new Headers(options.headers);
    requests.push({ host: url.hostname, path: url.pathname, method: options.method || 'GET' });
    if (url.hostname === 'testscore.pxxl.pro') {
      assert.equal(headers.get('origin'), 'https://scorezonetv.live');
      if (url.pathname.startsWith('/api/livescore/')) return Response.json({ Stages: [stage] });
      if (url.pathname === '/api/matches/channels') {
        assert.equal(url.searchParams.get('eventId'), '1835287');
        return Response.json({ key: 'fixture-match-key', channels: [{ id: 'bad', locked: false }, { id: 'good', locked: false }, { id: 'locked', locked: true }] });
      }
      if (url.pathname === '/api/matches/playback') {
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body); assert.equal(body.matchKey, 'fixture-match-key'); posts++;
        return Response.json({ url: `https://feed.scorezone.workers.dev/hls/${body.channelId}/index.m3u8` });
      }
    }
    if (url.hostname === 'feed.scorezone.workers.dev') {
      if (url.pathname.includes('/bad/')) return new Response('Denied', { status: 403 });
      if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n');
      if (url.pathname.endsWith('segment.ts')) return new Response(bad ? video : 'Denied', { status: bad ? 200 : 403, headers: bad ? { 'content-type': 'video/mp2t' } : {} });
    }
    assert.fail('Unexpected request: ' + url.origin + url.pathname);
  };
  const source = createScorezoneSource({ fetchResource, now: () => now });
  const selected = await source.resolve(event);
  assert.equal(selected.playback.provider, 'scorezone');
  assert.equal(selected.playback.channelId, 'good');
  assert.equal(posts, 2);
  assert.ok(requests.some(r => r.path.endsWith('segment.ts')));
  assert.equal((await source.media(selected.url, selected.playback)).url, selected.url);
  now += 5 * 60_000;
  assert.equal((await source.media(selected.url, selected.playback)).url, selected.url);
  assert.equal(posts, 3);
  bad = false;
  await assert.rejects(source.resolve(event, { fresh: true }), /ScoreZone returned HTTP 403|video/i);
});
