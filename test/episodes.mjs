import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { episodePresentation, episodeCard } from '../public/episodes.mjs';

const today = '2026-11-17';
const episode = { episode_number: 3, name: 'A new chapter', air_date: today, overview: 'An episode.' };
const progress = { position: 1200, duration: 3600, completed: false };
const options = { today, id: 1396, season: 2, show: { name: 'A show' }, image: () => '', icon: name => `<svg data-icon="${name}"></svg>` };

test('future release dates get an upcoming overlay, while today and past episodes are playable', () => {
  for (const date of ['2026-11-16', today]) assert.equal(episodePresentation({ ...episode, air_date: date }, null, { today }).upcoming, false);
  const future = episodePresentation({ ...episode, air_date: '2026-11-24' }, null, { today });
  assert.equal(future.upcoming, true);
  assert.equal(future.release, 'Nov 24');
  assert.equal(episodePresentation({ ...episode, air_date: '2027-01-03' }, null, { today }).release, 'Jan 3, 2027');
  for (const date of [null, '', 'not-a-date', '2026-02-30']) assert.equal(episodePresentation({ ...episode, air_date: date }, null, { today }).upcoming, false);
  const undated = episodePresentation({ ...episode, air_date: null }, null, { today, seasonAirDate: '2027-01-03' });
  assert.equal(undated.upcoming, true);
  assert.equal(undated.release, 'Release date TBA');
});

test('saved playback shows progress or completion and takes precedence over incorrect future metadata', () => {
  let view = episodePresentation(episode, progress, { today });
  assert.equal(view.percent, 33); assert.equal(view.label, '40 min left');
  view = episodePresentation(episode, { ...progress, position: 3480, completed: true }, { today });
  assert.equal(view.percent, 100); assert.equal(view.label, 'Watched');
  view = episodePresentation({ ...episode, air_date: '2027-01-03' }, progress, { today });
  assert.equal(view.upcoming, false); assert.equal(view.percent, 33);
  for (const saved of [null, { position: 0, duration: 3600 }, { position: -1, duration: 3600 }, { position: 5, duration: NaN }]) {
    assert.equal(episodePresentation(episode, saved, { today }).percent, 0);
  }
  assert.equal(episodePresentation(episode, { position: 0, duration: 3600, completed: false }, { today }).completed, false);
});

test('upcoming cards cannot start playback, and watched cards offer replay with a full bar', () => {
  let $ = load(episodeCard({ ...episode, air_date: '2026-11-24' }, options));
  assert.ok($('.episode').is('[disabled]'));
  assert.equal($('.episode').attr('data-action'), undefined);
  assert.equal($('time').attr('datetime'), '2026-11-24');
  assert.match($('.episode').attr('aria-label'), /Upcoming, Nov 24/);
  $ = load(episodeCard(episode, { ...options, progress: { ...progress, completed: true } }));
  assert.equal($('.episode').attr('disabled'), undefined);
  assert.equal($('.episode').attr('data-action'), 'play');
  assert.equal($('.watch-progress>span').attr('style'), 'width:100%');
  assert.equal($('.episode-watch-label').text(), 'Watched');
  assert.match($('.episode').attr('aria-label'), /Watch again.*Watched/);
  $ = load(episodeCard(episode, { ...options, progress }));
  assert.match($('.episode').attr('aria-label'), /Resume.*33% watched, 40 min left/);
  assert.equal($('.watch-progress>span').attr('style'), 'width:33%');
});

test('titles and descriptions cannot inject HTML into episode indicators or playback attributes', () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const $ = load(episodeCard({ ...episode, name: malicious, overview: malicious }, { ...options, show: { name: malicious } }));
  assert.equal($('img').length, 0);
  assert.equal($('.episode strong').text(), `3. ${malicious}`);
  assert.equal($('.episode p').text(), malicious);
  assert.equal($('.episode').attr('data-title'), `${malicious} · S2 E3`);
});
