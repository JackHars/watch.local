import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultConfig } from '../api/settings.mjs';
import { environment } from '../api/environment.mjs';
import { rememberedProfileId, rememberProfile } from '../public/profiles.mjs';
import { migratedPreference, watchlistPreference } from '../public/preferences.mjs';

test('renames only the old default server name and preserves private configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-branding-'));
  try {
    assert.equal(defaultConfig().server.name, 'watch.local');
    assert.equal(defaultConfig().metadata.tmdbCredential, '');
    const initial = createSettingsStore(directory); await initial.initialize();
    await initial.setTMDBCredential('private-fixture-credential');
    await initial.configure({ server: { name: 'FreeIPTV', webPort80: true }, metadata: { tmdbFallback: true } });
    const before = JSON.parse(await readFile(join(directory, 'iptv.json')));
    const migrated = createSettingsStore(directory); await migrated.initialize();
    const expected = structuredClone(before); expected.config.server.name = 'watch.local';
    assert.deepEqual(migrated.get(), expected);
    await migrated.configure({ server: { name: 'Living room' } });
    const custom = createSettingsStore(directory); await custom.initialize();
    assert.equal(custom.config().server.name, 'Living room');
    assert.deepEqual(custom.publicConfig().metadata, { configured: true, tmdbFallback: true });
    assert.ok(!JSON.stringify(custom.publicConfig()).includes('private-fixture-credential'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profile and watchlist choices migrate without crossing profiles or reviving cleared choices', () => {
  const previous = globalThis.localStorage, values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  try {
    values.set('freeiptv.profile.alice', 'profile-a');
    values.set('freeiptv.profile.bob', 'profile-b');
    assert.equal(rememberedProfileId('alice'), 'profile-a');
    assert.equal(values.get('watchlocal.profile.alice'), 'profile-a');
    rememberProfile('alice', null);
    assert.equal(rememberedProfileId('alice'), null);
    assert.equal(rememberedProfileId('bob'), 'profile-b');
    const movie = [{ id: 42, type: 'movie', title: 'A saved title' }];
    values.set('freeiptv.list.alice.profile-a', JSON.stringify(movie));
    assert.deepEqual(watchlistPreference('alice', 'profile-a'), movie);
    assert.deepEqual(watchlistPreference('alice', 'profile-b'), []);
    values.set('watchlocal.list.alice.profile-a', '[]');
    values.set('freeiptv.list.alice.profile-a', JSON.stringify(movie));
    assert.deepEqual(watchlistPreference('alice', 'profile-a'), []);
    values.set('freeiptv.list.old-account', JSON.stringify(movie));
    assert.deepEqual(watchlistPreference('old-account', 'main', true), movie);
    assert.deepEqual(watchlistPreference('old-account', 'second', true), []);
    values.set('freeiptv.profile.full', 'kept-profile');
    globalThis.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    assert.equal(rememberedProfileId('full'), 'kept-profile');
    assert.equal(values.get('freeiptv.profile.full'), 'kept-profile');
    globalThis.localStorage.getItem = () => { throw new Error('Blocked'); };
    assert.equal(migratedPreference('anything'), null);
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});

test('new environment names take precedence while old deployments remain compatible', () => {
  const old = process.env.FREEIPTV_DATA_DIR, current = process.env.WATCHLOCAL_DATA_DIR;
  try {
    delete process.env.WATCHLOCAL_DATA_DIR; process.env.FREEIPTV_DATA_DIR = '/private/old';
    assert.equal(environment('DATA_DIR'), '/private/old');
    process.env.WATCHLOCAL_DATA_DIR = '/private/new';
    assert.equal(environment('DATA_DIR'), '/private/new');
  } finally {
    if (old === undefined) delete process.env.FREEIPTV_DATA_DIR; else process.env.FREEIPTV_DATA_DIR = old;
    if (current === undefined) delete process.env.WATCHLOCAL_DATA_DIR; else process.env.WATCHLOCAL_DATA_DIR = current;
  }
});
