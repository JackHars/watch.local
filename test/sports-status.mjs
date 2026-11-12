import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreboardStatus, createSportsStatus } from '../api/sports-status.mjs';
import { eventStatus } from '../api/sports.mjs';

const time = Date.parse('2026-11-12T02:00:00Z');
const event = { sport: 'nba', slug: 'nba/2026-11-12/home-away', title: 'Home Team vs Away Team', starts_at: Date.parse('2026-11-12T00:00:00Z') / 1000, ends_at: time / 1000 + 3600 };
const game = (state = 'post', date = '2026-11-12T00:00:00Z', teams = ['Away Team', 'Home Team']) => ({
  date, status: { type: { state, completed: state === 'post' } },
  competitions: [{ competitors: teams.map(displayName => ({ team: { displayName } })) }],
});

test('scoreboard matching uses both teams and start time, including reversed order and doubleheaders', () => {
  assert.equal(scoreboardStatus(event, [game()]), 'ENDED');
  assert.equal(scoreboardStatus(event, [game('in')]), 'LIVE');
  assert.equal(scoreboardStatus(event, [game('pre')]), 'UPCOMING');
  assert.equal(scoreboardStatus(event, [game('post', undefined, ['Away Team', 'Other Team'])]), null);
  assert.equal(scoreboardStatus(event, [game('post', '2026-11-11T00:00:00Z')]), null);
  assert.equal(scoreboardStatus(event, [game('post', '2026-11-11T23:00:00Z'), game('in')]), 'LIVE');
  assert.equal(scoreboardStatus(event, [game('post'), game('in')]), null, 'Ambiguous fixtures must not mark the wrong game finished');
  assert.equal(scoreboardStatus({ ...event, title: 'LA Clippers vs Away Team' }, [game('in', undefined, ['Los Angeles Clippers', 'Away Team'])]), 'LIVE');
});

test('scoreboard fetches coalesce, use the league calendar day, refresh, and tolerate temporary outages', async () => {
  let clock = time, calls = 0, state = 'in', offline = false;
  const status = createSportsStatus({ now: () => clock, request: async (url, _referer, options) => {
    calls++; assert.equal(url, 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261111');
    assert.equal(options.timeout, 5000);
    if (offline) throw Error('Offline');
    return { text: JSON.stringify({ events: [game(state)] }) };
  } });
  const [a, b] = await Promise.all([status([event, { ...event, slug: 'duplicate' }]), status([event])]);
  assert.equal(calls, 1); assert.equal(a.get(event.slug).state, 'LIVE'); assert.deepEqual(a.get(event.slug), b.get(event.slug));
  await status([event]); assert.equal(calls, 1);
  clock += 60001; state = 'post'; assert.equal((await status([event])).get(event.slug).state, 'ENDED'); assert.equal(calls, 2);
  clock += 60001; offline = true; assert.equal((await status([event])).get(event.slug).state, 'ENDED');
  await status([event]); assert.equal(calls, 3, 'Back off failed scoreboard requests');
  clock += 180001; assert.equal((await status([event])).size, 0, 'Stale live status must not survive indefinitely');
  assert.equal((await status([{ ...event, sport: 'boxing' }])).size, 0);
});

test('verified completion overrides estimated end time, while verified live status allows overtime', () => {
  const check = state => ({ state, checkedAt: time });
  assert.equal(eventStatus({ ...event, broadcast_status: check('ENDED') }, () => time), 'ENDED');
  assert.equal(eventStatus({ ...event, ends_at: time / 1000 - 300, broadcast_status: check('LIVE') }, () => time), 'LIVE');
  assert.equal(eventStatus({ ...event, ends_at: time / 1000 - 300, broadcast_status: check('LIVE') }, () => time + 180001), 'ENDED');
  assert.equal(eventStatus(event, () => time), 'LIVE');
});
