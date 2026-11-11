import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSearchResults, improveSearchResults } from '../api/search.mjs';

const now = Date.parse('2026-11-11T12:00:00Z');
const movie = (id, title, extra = {}) => ({ id, title, media_type: 'movie', ...extra });
const show = (id, name, extra = {}) => ({ id, name, media_type: 'tv', ...extra });
const ids = items => items.map(item => `${item.media_type}:${item.id}`);
const vision = [
  movie(1, 'Vision Quest', { popularity: 2.6, vote_count: 147, release_date: '1985-02-15' }),
  movie(2, 'Vision Quest', { popularity: .5, vote_count: 0, release_date: '2025-05-27' }),
  show(3, 'VisionQuest', { popularity: 221, vote_count: 328, first_air_date: '2026-10-13' }),
  movie(4, 'VisionQuest Official Podcast', { popularity: 99999, vote_count: 999999, release_date: '2026-11-10' }),
];

test('spacing is equivalent; popularity separates exact matches without promoting a popular partial match', () => {
  for (const query of ['vision quest', 'VisionQuest', '  VISION   QUEST  ', 'vision-quest']) {
    const result = rankSearchResults(vision, query, { now });
    assert.deepEqual(ids(result), ['tv:3', 'movie:1', 'movie:2', 'movie:4']);
  }
  assert.equal(vision[0].id, 1, 'ranking must not mutate the cached provider list');
});

test('accented, original, and punctuated titles match naturally; franchise extras remain behind the title', () => {
  const items = [movie(1, 'Amélie: Behind the Scenes', { popularity: 1000 }), movie(2, 'Amélie'), movie(3, 'Seven Samurai', { original_title: '七人の侍' })];
  assert.equal(rankSearchResults(items, 'amelie')[0].id, 2);
  assert.equal(rankSearchResults(items, '七人の侍')[0].id, 3);
  assert.equal(rankSearchResults([movie(1, 'Spider-Man: Homecoming'), movie(2, 'Spider-Man')], 'spider man')[0].id, 2);
  assert.equal(rankSearchResults([movie(1, 'Office Party'), show(2, 'The Office', { popularity: 70 })], 'office')[0].id, 2);
});

test('release years disambiguate remakes without treating title numbers as release dates', () => {
  assert.equal(rankSearchResults(vision, 'vision quest 1985', { now })[0].id, 1);
  assert.equal(rankSearchResults([movie(1, 'Blade Runner'), movie(2, 'Blade Runner 2049', { release_date: '2017-10-04' })], 'blade runner 2049')[0].id, 2);
});

test('current interest breaks close ties, raw ratings do not; duplicate media identities appear once', () => {
  const items = [movie(1, 'Shared Name', { vote_average: 10, vote_count: 1 }), show(1, 'Shared Name', { vote_average: 8, vote_count: 1000 }), movie(1, 'Shared Name')];
  assert.deepEqual(ids(rankSearchResults(items, 'shared name', { now })), ['tv:1', 'movie:1']);
  assert.equal(rankSearchResults([movie(1, 'Shared Name'), show(2, 'Shared Name')], 'shared name', { now, trending: [show(2, 'Shared Name')] })[0].id, 2);
  assert.deepEqual(ids(rankSearchResults([movie(1, 'Same'), movie(2, 'Same')], 'same')), ['movie:1', 'movie:2']);
});

test('sparse provider cards gain ranking metadata with bounded parallel detail reads', async () => {
  let calls = 0, active = 0, peak = 0;
  const input = Array.from({ length: 30 }, (_, index) => movie(index + 1, 'Match', { overview: 'Keep this summary', poster_path: '/original.jpg' }));
  const result = await improveSearchResults(input, 'match', { now, getDetails: async (type, id) => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    assert.equal(type, 'movie');
    return { popularity: id, vote_count: id * 100, overview: 'Replace?', poster_path: '/replace.jpg' };
  } });
  assert.equal(calls, 12); assert.equal(peak, 4);
  assert.equal(result[0].id, 12);
  assert.equal(result[0].overview, 'Keep this summary'); assert.equal(result[0].poster_path, '/original.jpg');
  assert.equal(input[0].popularity, undefined);
  let extraCalls = 0;
  await improveSearchResults(vision, 'vision quest', { getDetails: async () => { extraCalls++; } });
  assert.equal(extraCalls, 0, 'complete cards need no extra network requests');
});

test('unavailable or slow optional detail reads do not break search; caller cancellation still propagates', async () => {
  const input = [movie(1, 'Vision Quest'), show(2, 'VisionQuest')];
  assert.equal((await improveSearchResults(input, 'vision quest', { getDetails: async () => { throw Error('offline'); } })).length, 2);
  const slow = (type, id, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const started = Date.now();
  assert.equal((await improveSearchResults(input, 'vision quest', { budgetMs: 30, getDetails: slow })).length, 2);
  assert.ok(Date.now() - started < 500);
  const controller = new AbortController();
  const pending = improveSearchResults(input, 'vision quest', { getDetails: slow, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
