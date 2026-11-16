import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpcomingService, summarizeUpcoming } from '../api/upcoming.mjs';
import { parseProductionReport, fetchProductionReport } from '../api/production-report.mjs';
import { upcomingPresentation, upcomingCard } from '../public/upcoming.mjs';

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

const overview = 'A nightmarish town traps all those who enter. The residents try to unravel the mystery.';
const productionHTML = `<main><h1>From Season 5</h1><dl>
  <dt>Type</dt><dd>Series</dd><dt>Production Status</dt><dd>Filming / In Production</dd>
  <dt>Main release</dt><dd>2027</dd><dt>Scheduled start</dt><dd>July 06, 2026</dd>
  <dt>Plot</dt><p>The mystery of a nightmarish town that traps all those who enter.</p>
  </dl><time datetime="2026-11-09T13:37:13+00:00">November 9, 2026</time></main>`;
const reportOptions = { title: 'FROM', season: 5, overview, now: Date.parse(today) };

test('production reports preserve published windows and distinguish scheduled starts from actual starts', () => {
  const report = parseProductionReport(productionHTML, reportOptions);
  assert.equal(report.releaseWindow, '2027');
  assert.equal(report.productionStatus, 'Filming / In production');
  assert.equal(report.scheduledStart, '2026-07-06');
  assert.equal(report.updatedAt, '2026-11-09');
  assert.equal(report.confidence, 'reported');
  assert.equal(report.startedAt, undefined);
  assert.equal(parseProductionReport(productionHTML.replace('2027</dd>', '2024</dd>'), reportOptions).releaseWindow, null);
});

test('production reports reject other seasons, ambiguous names, and listing-index redirects', () => {
  assert.equal(parseProductionReport(productionHTML, { ...reportOptions, season: 4 }), null);
  assert.equal(parseProductionReport(productionHTML, { ...reportOptions, overview: 'A comedy about office colleagues.' }), null);
  assert.equal(parseProductionReport('<main><h1>Production Listings</h1></main>', reportOptions), null);
});

test('production lookup uses only public fields on a fixed origin and tolerates source outages', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://mande.net/production-listings/series/from/season-5');
    assert.equal(options.redirect, 'error');
    return new Response(productionHTML, { headers: { 'content-type': 'text/html' } });
  };
  const report = await fetchProductionReport(reportOptions, { fetcher, now: reportOptions.now });
  assert.equal(report.releaseWindow, '2027');
  assert.equal(calls, 1);
  assert.equal(await fetchProductionReport(reportOptions, { fetcher: async () => new Response('', { status: 503 }) }), null);
});

test('undated seasons can include a sourced report without fabricating a premiere date', async () => {
  const report = { ...parseProductionReport(productionHTML, reportOptions), url: 'https://mande.net/production-listings/series/from/season-5' };
  const service = createUpcomingService({ configured: () => true, tmdbRequest: async () => ({ name: 'FROM', overview, seasons: [{ season_number: 4, episode_count: 10, air_date: '2026-04-19' }, { season_number: 5, episode_count: 0, air_date: null }] }),
    catalog: async () => { throw Error('offline'); }, production: async input => { assert.equal(input.title, 'FROM'); assert.equal(input.season, 5); return report; }, now: () => Date.parse(today) });
  const result = await service(124364);
  assert.equal(result.season.premiereDate, null);
  assert.equal(result.report.releaseWindow, '2027');
  assert.equal('estimate' in result, false);
});

test('the card shows sourced expectations without a guessed countdown, and scheduled dates take priority', () => {
  const report = { ...parseProductionReport(productionHTML, reportOptions), url: 'https://mande.net/production-listings/series/from/season-5' };
  const data = { season: { number: 5, premiereDate: null }, report };
  const reported = upcomingPresentation(data, { today });
  assert.equal(reported.release, 'Expected 2027');
  assert.equal(reported.status, 'Reported');
  assert.equal(reported.eta, '');
  assert.match(upcomingCard(data), /Filming \/ In production/);
  assert.match(upcomingCard(data), /Production report/);
  const scheduled = upcomingPresentation({ ...data, season: { number: 5, premiereDate: '2026-11-16' } }, { today });
  assert.equal(scheduled.status, 'Scheduled');
  assert.equal(scheduled.eta, 'Tomorrow');
  assert.equal(scheduled.url, undefined);
  const unknown = upcomingPresentation({ season: data.season, estimate: { earliest: '2027-06-01', latest: '2027-12-31' } }, { today });
  assert.equal(unknown.release, 'Release date TBA');
  assert.equal(unknown.eta, '');
  assert.equal(upcomingPresentation({ ...data, report: { ...report, url: 'javascript:alert(1)' } }, { today }).status, 'Announced');
});
