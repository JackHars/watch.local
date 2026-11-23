import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAurasportsSource } from '../api/aurasports.mjs';
import { video, wrappedVideo } from './zlive-fixtures.mjs';

test('sports fall through to AuraSports and signed browser/IPTV media decodes PNG to video', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-aurasports-http-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch, start = Math.floor(Date.now() / 1000) - 60;
  const event = { sport: 'nba', title: 'Toronto Raptors vs New York Knicks', starts_at: start, ends_at: start + 7200, slug: 'nba/2026-11-17/raptors-knicks', has_payload: false };
  let server, imageRequests = 0, moved = false;
  try {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === '127.0.0.1') return original(input, options);
      if (url.pathname === '/api/schedule') return Response.json([{ category_name: 'nba', schedule: [{ id: 'espn-401910002', date: start * 1000, teams: { home: { name: 'Toronto Raptors' }, away: { name: 'New York Knicks' } },
        ...(moved ? { watchUrl: 'https://new-player.example/watch/espn-401910002' } : { sources: [{ url: 'https://play.aurasportsplayer.cfd/event/espn-401910002?source=0' }] }) }] }]);
      if (url.hostname === 'new-player.example') return new Response('<iframe id="player-frame" src="https://new-frame.example/embed/opaque"></iframe>');
      if (url.hostname === 'new-frame.example') return new Response('<video><source type="application/vnd.apple.mpegurl" src="https://new-media.example/tune"></video>');
      if (url.hostname === 'new-media.example') return Response.redirect('https://new-cdn.example/broadcast/opaque/main.m3u8');
      if (url.hostname === 'new-cdn.example') {
        if (url.pathname.endsWith('main.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nnew-segment.ts\n');
        assert.equal(url.pathname, '/broadcast/opaque/new-segment.ts');
        return new Response(video);
      }
      if (url.hostname === 'play.aurasportsplayer.cfd') return new Response('<iframe src="https://frame.aurasportsplayer.cfd/frame/espn-401910002?source=0"></iframe>');
      if (url.hostname === 'frame.aurasportsplayer.cfd') return new Response('var streamUrl = "https://hls.meth-streams-hd.cfd/live/espn-401910002/index.m3u8";');
      if (url.hostname === 'hls.meth-streams-hd.cfd') return moved ? Response.json({ error: 'moved' }) : new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://cdn.test/first.m3u8\n#EXTINF:6,\nhttps://cdn.test/second.image\n');
      if (url.hostname === 'cdn.test') {
        imageRequests++;
        const headers = new Headers(options.headers);
        assert.equal(headers.get('range'), null);
        assert.equal(headers.get('origin'), null);
        return new Response(wrappedVideo({ format: 'KWP1' }), { headers: { 'content-type': 'image/png' } });
      }
      assert.fail('Unexpected upstream host: ' + url.hostname);
    };
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    const { watchProgressStore } = await import('../api/watch-progress.mjs');
    const { createServer } = await import('../server.mjs');
    await initializeIPTV({ sportsDirectory: directory,
      sportsSource: { list: async sport => ({ events: sport === 'nba' ? [event] : [] }), resolve: async () => { throw Object.assign(new Error('Primary unavailable'), { status: 503 }); } },
      strmfreeSource: { status: () => ({}), resolve: async () => { throw Object.assign(new Error('Strmfree unavailable'), { status: 503 }); } },
      scorezoneSource: { status: () => ({}), resolve: async () => { throw Object.assign(new Error('ScoreZone unavailable'), { status: 503 }); } },
      aurasportsSource: createAurasportsSource({ fetchResource: (...args) => fetch(...args) }),
      timstreamsSource: { list: async () => [] }, zliveSource: { list: async () => [], guide: async () => ({}) },
    });
    const login = settingsStore.get(), profile = await watchProgressStore.createProfile(login.ownerId, { name: 'Sports', color: '#527de0' });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, auth = new URLSearchParams({ username: login.username, password: login.password });
    const rows = await fetch(base + '/player_api.php?' + auth + '&action=get_live_streams').then(r => r.json());
    assert.equal(rows.length, 1); const id = rows[0].stream_id;
    const play = await fetch(base + '/ui/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'live', id, profileId: profile.id }) }).then(r => r.json());
    assert.equal(play.provider, 'aurasports');
    const playlist = await fetch(play.url).then(r => r.text());
    assert.match(playlist, /segment\.ts/);
    const segment = playlist.split('\n').find(line => line.startsWith('http'));
    assert.deepEqual(Buffer.from(await fetch(segment).then(r => r.arrayBuffer())), video);
    const native = await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams({ type: 'live', id, profileId: profile.id }), { redirect: 'manual' });
    assert.equal(native.status, 302);
    assert.match(await fetch(native.headers.get('location')).then(r => r.text()), /segment\.ts/);
    assert.equal((await fetch(base + '/ui/live').then(r => r.json())).items.length, 1);
    const iptv = await fetch(base + '/get.php?' + auth + '&content=live').then(r => r.text());
    assert.equal((iptv.match(/#EXTINF:/g) || []).length, 1);
    assert.ok(imageRequests >= 2);
    moved = true;
    for (let i = 0; i < 2; i++) {
      const renewed = await fetch(play.url);
      assert.equal(renewed.status, 200, 'the previously signed root follows the provider move');
      const line = (await renewed.text()).split('\n').find(line => line.startsWith('http'));
      assert.ok(line.startsWith(base + '/iptv/media/'));
      assert.deepEqual(Buffer.from(await fetch(line).then(r => r.arrayBuffer())), video);
    }
    await settingsStore.configure({ live: { aurasports: false } });
    const disabled = await fetch(base + '/ui/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'live', id, profileId: profile.id, fresh: true }) });
    assert.equal(disabled.status, 503);
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
