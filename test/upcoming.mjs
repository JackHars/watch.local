import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpcomingService, summarizeUpcoming } from '../api/upcoming.mjs';

const today = '2026-11-15';
const tmdb = { seasons: [
  { season_number: 1, episode_count: 9, air_date: '2022-02-18' },
  { season_number: 2, episode_count: 10, air_date: '2025-01-17' },
  { season_number: 3, episode_count: 0, air_date: null },
] };
const maze = { id: 44933, url: 'https://www.tvmaze.com/shows/44933/severance' };
const seasons = [
  { number: 1, premiereDate: '2022-02-18', episodeOrder: 9 },
  { number: 2, premiereDate: '2025-01-17', episodeOrder: 10 },
  { number: 3, premiereDate: null, episodeOrder: null },
];

test('an announced season without a date is shown without a fabricated premiere', () => {
  const result = summarizeUpcoming({ tmdb, maze, seasons, today, tmdbId: 95396 });
  assert.deepEqual(result.season, { number: 3, premiereDate: null });
  assert.equal(result.source, 'TMDB');
  assert.equal(result.sourceUrl, 'https://www.themoviedb.org/tv/95396');
  assert.equal(result.nextEpisode, null);
});

test('future premiere and next episode dates are distinct from an already airing season', () => {
  const dated = summarizeUpcoming({ tmdb, maze, seasons: [...seasons.slice(0, 2), { number: 3, premiereDate: '2027-01-08', episodeOrder: 10 }], episodes: [{ season: 3, number: 1, name: 'Premiere', airdate: '2027-01-08' }], today, tmdbId: 95396 });
  assert.deepEqual(dated.season, { number: 3, premiereDate: '2027-01-08' });
  assert.deepEqual(dated.nextEpisode, { season: 3, number: 1, name: 'Premiere', airDate: '2027-01-08' });
  const current = summarizeUpcoming({ tmdb: { seasons: tmdb.seasons.slice(0, 2) }, maze, seasons: seasons.slice(0, 2), episodes: [{ season: 2, number: 11, name: 'Finale', airdate: '2026-12-01' }], today, tmdbId: 95396 });
  assert.equal(current.season, null);
  assert.equal(current.nextEpisode.airDate, '2026-12-01');
  const tmdbNext = summarizeUpcoming({ tmdb: { seasons: tmdb.seasons.slice(0, 2), next_episode_to_air: { season_number: 2, episode_number: 11, name: 'Finale', air_date: '2026-12-01' } }, today, tmdbId: 95396 });
  assert.equal(tmdbNext.nextEpisode.airDate, '2026-12-01');
  assert.equal(tmdbNext.source, 'TMDB');
});

test('no future listings produces no announcement, and source URLs are constrained', () => {
  const result = summarizeUpcoming({ tmdb: { seasons: tmdb.seasons.slice(0, 2) }, maze: { url: 'https://evil.example/' }, seasons: seasons.slice(0, 2), today, tmdbId: 95396 });
  assert.deepEqual(result, { season: null, nextEpisode: null });
  const future = summarizeUpcoming({ maze: { url: 'https://evil.example/' }, seasons, today, tmdbId: 95396 });
  assert.equal(future.sourceUrl, null);
});

test('the service uses an exact IMDb lookup, caches results, and works without a TMDB credential', async () => {
  const seen = [];
  const fetcher = async url => {
    seen.push(url);
    if (url.endsWith('/lookup/shows?imdb=tt11280740')) return new Response(JSON.stringify(maze));
    if (url.endsWith('/shows/44933/seasons')) return new Response(JSON.stringify(seasons));
    if (url.endsWith('/shows/44933/episodes')) return new Response(JSON.stringify([]));
    throw Error('Unexpected URL');
  };
  const service = createUpcomingService({ catalog: async path => {
    assert.equal(path, '/tv/95396/external_ids');
    return { imdb_id: 'tt11280740' };
  }, configured: () => false, tmdbRequest: () => assert.fail('TMDB should not be contacted'), fetcher, now: () => Date.parse(today) });
  const [a, b] = await Promise.all([service(95396), service(95396)]);
  assert.deepEqual(a, b);
  assert.equal(a.season.number, 3);
  await service(95396);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(url => url.startsWith('https://api.tvmaze.com/')));
});

test('TMDB season data remains available when TVMaze is offline', async () => {
  const service = createUpcomingService({ catalog: async () => { throw Error('offline'); }, configured: () => true,
    tmdbRequest: async () => ({ ...tmdb, external_ids: { imdb_id: 'tt11280740' } }), fetcher: async () => { throw Error('offline'); }, now: () => Date.parse(today) });
  const result = await service(95396);
  assert.deepEqual(result.season, { number: 3, premiereDate: null });
  assert.equal(result.source, 'TMDB');
});

test('a confirmed TMDB premiere is used without contacting the fallback', async () => {
  const dated = { ...tmdb, seasons: [...tmdb.seasons.slice(0, 2), { season_number: 3, episode_count: 8, air_date: '2027-02-10' }], external_ids: { imdb_id: 'tt11280740' } };
  const service = createUpcomingService({ configured: () => true, tmdbRequest: async () => dated,
    catalog: async () => assert.fail('IMDb lookup is unnecessary'), fetcher: async () => assert.fail('TVMaze should not be contacted'), now: () => Date.parse(today) });
  const result = await service(95396);
  assert.deepEqual(result.season, { number: 3, premiereDate: '2027-02-10' });
  assert.equal(result.source, 'TMDB');
});

test('TVMaze fills a date only when TMDB has an undated season', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('/lookup/shows?')) return new Response(JSON.stringify(maze));
    if (url.endsWith('/seasons')) return new Response(JSON.stringify([...seasons.slice(0, 2), { number: 3, premiereDate: '2027-01-08', episodeOrder: 8 }]));
    if (url.endsWith('/episodes')) return new Response(JSON.stringify([]));
    throw Error('Unexpected request');
  };
  const service = createUpcomingService({ configured: () => true, tmdbRequest: async () => ({ ...tmdb, external_ids: { imdb_id: 'tt11280740' } }),
    catalog: async () => assert.fail('TMDB already supplied IMDb ID'), fetcher, now: () => Date.parse(today) });
  const result = await service(95396);
  assert.deepEqual(result.season, { number: 3, premiereDate: '2027-01-08' });
  assert.equal(result.source, 'TVMaze');
  assert.equal(calls.length, 3);
});
