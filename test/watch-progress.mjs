import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchProgressStore } from '../api/watch-progress.mjs';

const movie = { type: 'movie', id: 550, title: 'A movie', backdrop_path: '/movie.jpg', position: 600, duration: 7200, playbackId: 'movie-session', sequence: 1 };
const episode = { ...movie, type: 'tv', id: 1396, season: 2, episode: 3, title: 'A series', duration: 2700, playbackId: 'episode-session' };

test('watch progress persists separately from accounts and stays isolated per account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-progress-'));
  try {
    const store = createWatchProgressStore(directory);
    const alice = (await store.createProfile('alice', { name: 'Alice', color: '#527de0' })).id;
    const bob = (await store.createProfile('bob', { name: 'Bob', color: '#27865f' })).id;
    await Promise.all([store.save('alice', alice, movie), store.save('bob', bob, { ...movie, position: 1800 })]);
    const restarted = createWatchProgressStore(directory);
    assert.equal((await restarted.get('alice', alice, movie)).position, 600);
    assert.equal((await restarted.get('bob', bob, movie)).position, 1800);
    assert.deepEqual(await restarted.profiles('new-user'), []);
    assert.equal((await restarted.list('alice', alice))[0].backdrop_path, '/movie.jpg');
    assert.ok(!('playbackId' in (await restarted.list('alice', alice))[0]));
    assert.equal((await stat(join(directory, 'watch-progress.json'))).mode & 0o777, 0o600);
    await assert.rejects(readFile(join(directory, 'iptv.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('continue watching uses the latest episode, orders recent watches first, and excludes finished titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-progress-'));
  try {
    const store = createWatchProgressStore(directory);
    const alice = (await store.createProfile('alice', { name: 'Alice', color: '#527de0' })).id;
    await store.save('alice', alice, movie);
    await store.save('alice', alice, episode);
    await store.save('alice', alice, { ...episode, episode: 4, position: 300, playbackId: 'next-episode' });
    let items = await store.list('alice', alice);
    assert.deepEqual(items.map(item => item.key), ['tv:1396:2:4', 'movie:550']);
    assert.equal((await store.get('alice', alice, episode)).position, 600);
    await store.save('alice', alice, { ...episode, episode: 4, position: 2700, ended: true, playbackId: 'next-episode', sequence: 2 });
    assert.deepEqual((await store.list('alice', alice)).map(item => item.key), ['movie:550']);
    await store.save('alice', alice, { ...movie, position: 6900, sequence: 2 });
    assert.deepEqual(await store.list('alice', alice), []);
    assert.equal((await store.get('alice', alice, movie)).completed, true);
    assert.deepEqual((await store.list('alice', alice, { includeCompleted: true })).map(item => item.key), ['movie:550', 'tv:1396:2:4']);
    // Starting over clears completion and records the newly watched position.
    await store.save('alice', alice, { ...movie, position: 30, sequence: 3 });
    assert.equal((await store.list('alice', alice))[0].position, 30);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('late heartbeats cannot overwrite the final position, and bad timelines cannot corrupt saved data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-progress-'));
  try {
    const store = createWatchProgressStore(directory);
    const alice = (await store.createProfile('alice', { name: 'Alice', color: '#527de0' })).id;
    await store.save('alice', alice, { ...movie, position: 900, sequence: 3 });
    await store.save('alice', alice, { ...movie, position: 650, sequence: 2 });
    assert.equal((await store.get('alice', alice, movie)).position, 900);
    for (const invalid of [{ duration: 0 }, { duration: Infinity }, { position: -1 }, { position: 8000 }, { id: true }, { type: 'live' }, { sequence: 0 }, { ended: 'true' }]) {
      assert.throws(() => store.save('alice', alice, { ...movie, ...invalid }), { status: 400 });
    }
    assert.throws(() => store.save('alice', alice, { ...episode, season: -1 }), { status: 400 });
    assert.equal((await store.get('alice', alice, movie)).position, 900);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profiles keep the same movie separate, validate names and colours, and cannot cross account boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-profiles-'));
  try {
    const store = createWatchProgressStore(directory);
    const [jack, sam] = await Promise.all([
      store.createProfile('owner', { name: ' Jack ', color: '#527DE0' }),
      store.createProfile('owner', { name: 'Sam', color: '#27865f' }),
    ]);
    assert.equal(jack.name, 'Jack'); assert.equal(jack.color, '#527de0');
    await store.save('owner', jack.id, movie);
    await store.save('owner', sam.id, { ...movie, position: 1800 });
    assert.equal((await store.get('owner', jack.id, movie)).position, 600);
    assert.equal((await store.get('owner', sam.id, movie)).position, 1800);
    await assert.rejects(store.get('other-account', jack.id, movie), { status: 404 });
    await assert.rejects(store.save('other-account', jack.id, movie), { status: 404 });
    await assert.rejects(store.list('owner', undefined), { status: 400 });
    await assert.rejects(store.createProfile('owner', { name: 'JACK', color: '#ffffff' }), { status: 409 });
    for (const input of [{ name: '', color: '#123456' }, { name: 'x'.repeat(41), color: '#123456' }, { name: 'Sam\nGuest', color: '#123456' }, { name: 'Guest', color: 'red;display:none' }])
      await assert.rejects(store.createProfile('owner', input), { status: 400 });
    const restarted = createWatchProgressStore(directory);
    assert.equal((await restarted.profiles('owner')).length, 2);
    assert.equal((await restarted.get('owner', sam.id, movie)).position, 1800);
    assert.deepEqual(await restarted.profiles('other-account'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy progress migrates once to Main with a private backup and all movie/episode positions intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-profile-migration-'));
  try {
    const record = { ...movie, key: 'movie:550', completed: false, updatedAt: 123 };
    const episodeRecord = { ...episode, key: 'tv:1396:2:3', position: 850, completed: false, updatedAt: 124 };
    const old = JSON.stringify({ version: 1, users: { owner: { 'movie:550': record, 'tv:1396:2:3': episodeRecord }, empty: {} } });
    await writeFile(join(directory, 'watch-progress.json'), old);
    const store = createWatchProgressStore(directory), [main] = await store.profiles('owner');
    assert.equal(main.name, 'Main'); assert.equal(main.migrated, true);
    assert.equal((await store.get('owner', main.id, movie)).position, 600);
    assert.equal((await store.get('owner', main.id, episode)).position, 850);
    assert.deepEqual(await store.profiles('empty'), []);
    const other = await store.createProfile('owner', { name: 'New profile', color: '#8952c7' });
    assert.deepEqual(await store.list('owner', other.id), []);
    const restarted = createWatchProgressStore(directory);
    assert.deepEqual(await restarted.profiles('owner'), [main, other]);
    assert.equal((await restarted.get('owner', main.id, episode)).position, 850);
    assert.deepEqual((await restarted.list('owner', main.id)).map(item => item.key), ['tv:1396:2:3', 'movie:550']);
    assert.equal(await readFile(join(directory, 'watch-progress.pre-profiles.json'), 'utf8'), old);
    assert.equal((await stat(join(directory, 'watch-progress.pre-profiles.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(directory, 'watch-progress.json'))).version, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed migration preserves the original history instead of replacing it with empty profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-profile-migration-'));
  try {
    const old = JSON.stringify({ version: 1, users: { owner: { 'movie:550': { ...movie, key: 'movie:550', updatedAt: 123 } } } });
    await writeFile(join(directory, 'watch-progress.json'), old);
    await mkdir(join(directory, 'watch-progress.json.tmp'));
    await assert.rejects(createWatchProgressStore(directory).profiles('owner'), { code: 'EISDIR' });
    assert.equal(await readFile(join(directory, 'watch-progress.json'), 'utf8'), old);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
