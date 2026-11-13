import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('finished games leave Live and native mobile retrieves the same playback error without another resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-sports-status-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  const { watchProgressStore } = await import('../api/watch-progress.mjs');
  const { createServer } = await import('../server.mjs');
  let server, status = 'LIVE', checks = 0, resolutions = 0;
  const now = Math.floor(Date.now() / 1000);
  const event = { sport: 'nba', slug: 'nba/2026-11-12/home-away', title: 'Home Team vs Away Team', starts_at: now - 7200, ends_at: now - 60, has_payload: true, stream_url: 'https://fixture.test/stream.m3u8' };
  const source = {
    async list(sport) { return { events: sport === 'nba' ? [event] : [], errors: [] }; },
    async status(events) { checks++; return new Map(events.map(e => [e.slug, { state: status, checkedAt: Date.now() }])); },
    async resolve(e) { resolutions++; return e; },
    async hls() { return { url: event.stream_url, headers: {} }; },
  };
  try {
    await initializeIPTV({ timstreamsSource: { list: async () => [] }, zliveSource: { async list() { return []; } }, sportsSource: source });
    const owner = settingsStore.user(settingsStore.get().ownerId);
    const profile = await watchProgressStore.createProfile(owner.id, { name: 'Viewer', color: '#527de0' });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const { items } = await fetch(base + '/ui/live').then(r => r.json());
    assert.equal(items.length, 1, 'An overtime game stays available past its estimated end');
    const params = new URLSearchParams({ type: 'live', id: items[0].stream_id, profileId: profile.id, requestId: 'a'.repeat(32) });
    const live = base + '/ui/playback.m3u8?' + params;
    const ready = await fetch(live, { headers: { Accept: 'application/json' } });
    assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { ready: true });
    const player = await fetch(live, { redirect: 'manual' }); assert.equal(player.status, 302); assert.equal(resolutions, 1);
    status = 'ENDED';
    assert.deepEqual((await fetch(base + '/ui/live').then(r => r.json())).items, []);
    params.set('requestId', 'b'.repeat(32));
    const ended = base + '/ui/playback.m3u8?' + params;
    const error = await fetch(ended, { redirect: 'manual' }); assert.equal(error.status, 410);
    assert.match((await error.json()).error, /sports event has ended/);
    const priorChecks = checks;
    const diagnostic = await fetch(ended, { headers: { Accept: 'application/json' } });
    assert.equal(diagnostic.status, 410); assert.match((await diagnostic.json()).error, /sports event has ended/);
    assert.equal(checks, priorChecks, 'Read the failed attempt without probing upstream again');
    assert.equal(resolutions, 1, 'Do not try to resolve an ended broadcast');
    params.set('profileId', '00000000-0000-4000-8000-000000000001');
    assert.equal((await fetch(base + '/ui/playback.m3u8?' + params, { headers: { Accept: 'application/json' } })).status, 404);
  } finally {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
