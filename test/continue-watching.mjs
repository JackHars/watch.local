import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchProgressStore } from '../api/watch-progress.mjs';
import { createContinueWatching } from '../api/continue-watching.mjs';

const watched = { type: 'tv', id: 123, season: 1, episode: 1, title: 'Test Series', backdrop_path: '/show.jpg', position: 2400, duration: 2400, ended: true, playbackId: 'fixture-session', sequence: 1 };
const episode = (number, extra = {}) => ({ episode_number: number, name: 'Episode ' + number, air_date: '2020-01-01', runtime: 40, ...extra });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-next-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWatchProgressStore(directory);
  const profile = (await store.createProfile('owner', { name: 'Main', color: '#527de0' })).id;
  const other = (await store.createProfile('owner', { name: 'Other', color: '#27865f' })).id;
  let now = Date.parse('2026-11-13T19:00:00Z');
  const data = {
    '/tv/123': { seasons: [{ season_number: 0, episode_count: 1 }, { season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }] },
    '/tv/123/season/1': { episodes: [episode(2), episode(1)] },
    '/tv/123/season/2': { episodes: [episode(1), episode(2)] },
  };
  const calls = [];
  const catalog = async path => { calls.push(path); if (!data[path]) throw Error('Metadata unavailable'); return structuredClone(data[path]); };
  const list = createContinueWatching({ store, catalog, now: () => now });
  return { store, profile, other, directory, list, data, calls, advance: () => { now += 300001; } };
}

test('completed episodes become unwatched Up next suggestions without altering saved history, including after restart', async t => {
  const f = await fixture(t); await f.store.save('owner', f.profile, watched);
  const [next] = await f.list('owner', f.profile);
  assert.equal(next.key, 'tv:123:1:2'); assert.equal(next.position, 0); assert.equal(next.duration, 2400);
  assert.equal(next.nextEpisode, true); assert.equal(next.title, 'Test Series'); assert.equal(next.episodeTitle, 'Episode 2');
  assert.equal(await f.store.get('owner', f.profile, next), null);
  assert.equal((await f.store.get('owner', f.profile, watched)).completed, true);
  assert.deepEqual(await f.list('owner', f.other), []);
  await assert.rejects(f.list('another-owner', f.profile), { status: 404 });
  const restarted = createWatchProgressStore(f.directory);
  const list = createContinueWatching({ store: restarted, catalog: async path => f.data[path] });
  assert.equal((await list('owner', f.profile))[0].episode, 2);
  await f.list('owner', f.profile); assert.equal(f.calls.length, 1, 'Suggestions reuse metadata work');
});

test('resumes partial episodes normally, preserves next-episode progress, skips already completed episodes and hides finished movies', async t => {
  const f = await fixture(t);
  await f.store.save('owner', f.profile, { ...watched, episode: 2, position: 320, ended: false });
  assert.equal((await f.list('owner', f.profile))[0].position, 320); assert.equal(f.calls.length, 0);
  await f.store.save('owner', f.profile, watched);
  const [resume] = await f.list('owner', f.profile);
  assert.equal(resume.episode, 2); assert.equal(resume.position, 320); assert.equal(resume.nextEpisode, undefined);
  await f.store.save('owner', f.profile, { ...watched, episode: 2, sequence: 2 });
  await f.store.save('owner', f.profile, { ...watched, sequence: 2 });
  const [next] = await f.list('owner', f.profile);
  assert.equal(next.season, 2); assert.equal(next.episode, 1);
  await f.store.save('owner', f.profile, { ...watched, type: 'movie', id: 456 });
  assert.equal((await f.list('owner', f.profile)).length, 1);
});

test('season finales advance to the next regular season; series finales disappear', async t => {
  const f = await fixture(t); await f.store.save('owner', f.profile, { ...watched, episode: 2 });
  const [next] = await f.list('owner', f.profile); assert.equal(next.season, 2); assert.equal(next.episode, 1);
  assert.ok(!f.calls.some(path => path.endsWith('/season/0')));
  await f.store.save('owner', f.profile, { ...watched, season: 2, episode: 2 });
  assert.deepEqual(await f.list('owner', f.profile), []);
});

test('future episodes and seasons are not offered; released episodes appear after the suggestion cache expires', async t => {
  const f = await fixture(t);
  f.data['/tv/123/season/1'].episodes = [episode(1), episode(2, { air_date: '2026-11-14' }), episode(3)];
  await f.store.save('owner', f.profile, watched); assert.deepEqual(await f.list('owner', f.profile), []);
  f.data['/tv/123/season/1'].episodes[1].air_date = '2026-11-13'; f.advance();
  assert.equal((await f.list('owner', f.profile))[0].episode, 2);
  f.data['/tv/123/season/1'].episodes = [episode(1)]; f.data['/tv/123'].seasons[2].air_date = '2027-01-01'; f.advance();
  assert.deepEqual(await f.list('owner', f.profile), []);
});

test('metadata outages do not erase progress or prevent other cards; a later request retries successfully', async t => {
  const f = await fixture(t); await f.store.save('owner', f.profile, watched);
  await f.store.save('owner', f.profile, { ...watched, type: 'movie', id: 456, ended: false, position: 100 });
  const season = f.data['/tv/123/season/1']; delete f.data['/tv/123/season/1'];
  assert.deepEqual((await f.list('owner', f.profile)).map(x => x.type), ['movie']);
  f.data['/tv/123/season/1'] = season;
  assert.deepEqual((await f.list('owner', f.profile)).map(x => x.type), ['movie', 'tv']);
});

test('slow catalogs have bounded concurrency and cannot hold the home page indefinitely', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 10; id++) await f.store.save('owner', f.profile, { ...watched, id });
  await f.store.save('owner', f.profile, { ...watched, type: 'movie', id: 456, ended: false, position: 100 });
  let requests = 0;
  const list = createContinueWatching({ store: f.store, timeoutMs: 20, catalog: () => { requests++; return new Promise(() => {}); } });
  assert.equal((await list('owner', f.profile))[0].type, 'movie'); assert.equal(requests, 4);
});

test('completed series do not crowd older unfinished watches out of the row', async t => {
  const f = await fixture(t);
  await f.store.save('owner', f.profile, { ...watched, type: 'movie', id: 456, ended: false, position: 100 });
  for (let id = 1; id <= 51; id++) await f.store.save('owner', f.profile, { ...watched, id });
  const list = createContinueWatching({ store: f.store, catalog: async path => path.includes('/season/') ? { episodes: [] } : { seasons: [] } });
  const items = await list('owner', f.profile);
  assert.equal(items.length, 1); assert.equal(items[0].id, 456);
});
