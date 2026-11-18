import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScorezoneSource } from '../api/scorezone.mjs';

test('browser, native and IPTV sports use ScoreZone before the failing last-resort source, with one event card', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-scorezone-http-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch, start = Math.floor(Date.now() / 1000) - 60, video = Buffer.alloc(188 * 4, 0x47);
  const event = { sport: 'nhl', title: 'Boston Bruins vs Los Angeles Kings', starts_at: start, ends_at: start + 7200, slug: 'nhl/2026-11-17/test-game', has_payload: true, stream_url: 'https://primary.test/index.m3u8' };
  const date = new Date(start * 1000), stamp = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  let server, primaryWorks = false, strmfreeWorks = false, scorezoneWorks = true, scorezonePosts = 0, strmfreeAttempts = 0;
  try {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input), headers = new Headers(options.headers);
      if (url.hostname === '127.0.0.1') return original(input, options);
      if (url.hostname === 'primary.test') {
        if (!primaryWorks) return new Response('Unavailable', { status: 503 });
        if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nprimary.ts\n');
        return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
      }
      if (url.hostname === 'strmfree.test') {
        if (!strmfreeWorks) return new Response('Unavailable', { status: 503 });
        if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:20\n#EXTINF:6,\nsegment.ts\n');
        return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
      }
      if (url.hostname === 'testscore.pxxl.pro') {
        assert.equal(headers.get('origin'), 'https://scorezonetv.live');
        if (url.pathname.startsWith('/api/livescore/')) return Response.json({ Stages: [{ Cnm: 'NHL', Events: [{ Eid: 'fixture-game', Esd: stamp, T1: [{ Nm: 'Boston Bruins' }], T2: [{ Nm: 'Los Angeles Kings' }] }] }] });
        if (url.pathname === '/api/matches/channels') return Response.json({ key: 'fixture-key', channels: scorezoneWorks ? [{ id: 'nesn', locked: false }] : [] });
        if (url.pathname === '/api/matches/playback') { scorezonePosts++; return Response.json({ url: 'https://feed.scorezone.workers.dev/hls/nesn/index.m3u8' }); }
      }
      if (url.hostname === 'feed.scorezone.workers.dev') {
        if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:40\n#EXTINF:6,\nsegment.ts\n');
        return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
      }
      assert.fail('Unexpected upstream host: ' + url.hostname);
    };
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    const { watchProgressStore } = await import('../api/watch-progress.mjs');
    const { createServer } = await import('../server.mjs');
    await initializeIPTV({ sportsDirectory: directory,
      sportsSource: { list: async sport => ({ events: sport === 'nhl' ? [event] : [] }), resolve: async e => e, hls: async e => {
        if (!primaryWorks) throw Object.assign(new Error('Primary feed is down'), { status: 503 });
        return { url: e.stream_url };
      } },
      strmfreeSource: { status: () => ({}), validatesStreams: true, resolve: async () => {
        strmfreeAttempts++;
        if (!strmfreeWorks) throw Object.assign(new Error('No media'), { status: 503 });
        const url = 'https://strmfree.test/index.m3u8';
        return { url, playback: { provider: 'strmfree', root: url } };
      }, media: async (url, context) => ({ url, playback: context }) },
      scorezoneSource: createScorezoneSource({ fetchResource: (...args) => fetch(...args) }),
      timstreamsSource: { list: async () => [] }, zliveSource: { list: async () => [], guide: async () => ({}) },
    });
    const login = settingsStore.get(), profile = await watchProgressStore.createProfile(login.ownerId, { name: 'Sports', color: '#527de0' });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, auth = new URLSearchParams({ username: login.username, password: login.password });
    const rows = await fetch(base + '/player_api.php?' + auth + '&action=get_live_streams').then(r => r.json());
    assert.equal(rows.length, 1); const id = rows[0].stream_id;
    const play = fresh => fetch(base + '/ui/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'live', id, profileId: profile.id, fresh }) }).then(r => r.json());
    primaryWorks = true;
    const initial = await play(false); assert.equal(initial.provider, 'sports');
    const initialManifest = await fetch(initial.url).then(r => r.text());
    assert.match(initialManifest, /segment\.ts/);
    assert.equal((await fetch(initialManifest.split('\n').find(line => line.startsWith('http')))).status, 200);
    primaryWorks = false;
    assert.match(await fetch(initial.url).then(r => r.text()), /MEDIA-SEQUENCE:40/);
    assert.equal((await play(false)).provider, 'scorezone');
    for (const target of [initial.url, `${base}/live/${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}/${id}.m3u8`]) {
      const response = await fetch(target); assert.equal(response.status, 200);
      const manifest = await response.text(); assert.match(manifest, /MEDIA-SEQUENCE:40/);
      const segment = manifest.split('\n').find(line => line.startsWith('http'));
      assert.equal((await fetch(segment)).status, 200);
    }
    assert.equal(strmfreeAttempts, 0); assert.ok(scorezonePosts >= 1);
    assert.equal((await play(false)).provider, 'scorezone');
    const native = await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams({ type: 'live', id, profileId: profile.id }), { redirect: 'manual' });
    assert.equal(native.status, 302);
    assert.match(await fetch(native.headers.get('location')).then(r => r.text()), /MEDIA-SEQUENCE:40/);
    assert.equal((await fetch(base + '/ui/live').then(r => r.json())).items.length, 1);
    const playlist = await fetch(base + '/get.php?' + auth + '&content=live').then(r => r.text());
    assert.equal((playlist.match(/#EXTINF:/g) || []).length, 1);
    await settingsStore.configure({ live: { scorezone: false } });
    const before = scorezonePosts;
    assert.equal((await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams({ type: 'live', id, profileId: profile.id, fresh: 1 }), { headers: { Accept: 'application/json' } })).status, 503);
    assert.equal(scorezonePosts, before);
    assert.ok(strmfreeAttempts >= 1);
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
