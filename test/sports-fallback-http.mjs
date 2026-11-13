import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStrmfreeSource } from '../api/strmfree.mjs';

test('the same browser, native and IPTV event switches to Strmfree on relay failure without duplicate channels or P2P segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-sports-fallback-http-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch, time = Math.floor(Date.now() / 1000), video = Buffer.alloc(188 * 4, 0x47);
  const event = { sport: 'nba', title: 'Philadelphia 76ers vs Toronto Raptors', starts_at: time - 60, ends_at: time + 7200, slug: 'nba/2026-11-12/test-game', has_payload: true, stream_url: 'https://primary.test/master.m3u8' };
  const key = 'fixture-game';
  let server, failed = '', fallbacks = 0;
  try {
    globalThis.fetch = async (url, options) => {
      const u = new URL(url), headers = new Headers(options?.headers);
      if (u.hostname === '127.0.0.1') return original(url, options);
      if (u.hostname === 'primary.test') {
        if ((failed === 'playlist' && u.pathname.endsWith('.m3u8')) || (failed === 'segment' && u.pathname.endsWith('.ts'))) return new Response('Unavailable', { status: 503 });
        if (u.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nprimary.ts\n');
        return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
      }
      if (u.hostname === 'alternate.test') {
        if (u.pathname === '/streams') return Response.json({ streams: { basketball: [{ stream_key: key, name: 'Toronto Raptors vs Philadelphia 76ers', league: 'NBA', match_timestamp: time - 60 }] } });
        if (u.pathname.startsWith('/get-stream-key/')) { fallbacks++; return Response.json({ server_name: 'cdn' }); }
        if (u.pathname.startsWith('/embed/')) return new Response('const _0x = ' + JSON.stringify({ '1080p': { _t: 'fixture-signed-value', _e: time + 3600, _n: 'fixture-nonce' } }) + ';');
        if (u.pathname.endsWith('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:50\n#EXTINF:6,\nhttps://img.ttcdn-us.com/chunk.png#sf=' + encodeURIComponent('https://cdn1.strmfree.st/live/match/50.js') + '\n');
      }
      if (u.hostname === 'cdn1.strmfree.st') {
        assert.equal(headers.get('origin'), 'https://strmfree.st'); assert.equal(headers.get('referer'), 'https://strmfree.st/');
        if (headers.get('range')) return new Response(video, { status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-751/752' } });
        return new Response(options?.method === 'HEAD' ? null : video, { headers: { 'content-type': 'video/mp2t' } });
      }
      assert.fail('Unexpected upstream host: ' + u.hostname);
    };
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    const { watchProgressStore } = await import('../api/watch-progress.mjs');
    const { createServer } = await import('../server.mjs');
    await initializeIPTV({ timstreamsSource: { list: async () => [] }, sportsDirectory: directory,
      sportsSource: { list: async sport => ({ events: sport === 'nba' ? [event] : [] }), resolve: async e => e, hls: async e => ({ url: e.stream_url }) },
      strmfreeSource: createStrmfreeSource({ mirrors: ['alternate.test'], directoryURL: null, fetchResource: (...args) => fetch(...args) }),
      zliveSource: { list: async () => [], guide: async () => ({}) },
    });
    const login = settingsStore.get(), profile = await watchProgressStore.createProfile(login.ownerId, { name: 'Sports', color: '#527de0' });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, auth = new URLSearchParams({ username: login.username, password: login.password });
    const rows = await fetch(base + '/player_api.php?' + auth + '&action=get_live_streams').then(r => r.json());
    assert.equal(rows.length, 1); const id = rows[0].stream_id;
    const play = fresh => fetch(base + '/ui/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'live', id, profileId: profile.id, fresh }) }).then(r => r.json());
    const initial = await play(false); assert.equal(initial.provider, 'sports');
    const native = await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams({ type: 'live', id, profileId: profile.id }), { redirect: 'manual' });
    assert.equal(native.status, 302);
    const iptv = `${base}/live/${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}/${id}.m3u8`;
    assert.equal((await fetch(initial.url)).status, 200); assert.equal(fallbacks, 0);
    failed = 'playlist';
    for (const entry of [initial.url, native.headers.get('location'), iptv]) {
      const response = await fetch(entry); assert.equal(response.status, 200);
      const manifest = await response.text(); assert.match(manifest, /MEDIA-SEQUENCE:50/);
      const segmentURL = manifest.split('\n').find(line => line.startsWith('http'));
      const payload = JSON.parse(Buffer.from(new URL(segmentURL).pathname.split('/')[3].split('.')[0], 'base64url'));
      assert.equal(payload.live.sportsSource, 'strmfree'); assert.equal(payload.live.eventId, id);
      assert.ok(payload.u.startsWith('https://cdn1.strmfree.st/')); assert.doesNotMatch(payload.u, /ttcdn/);
      const segment = await fetch(segmentURL); assert.equal(segment.status, 200); assert.deepEqual(Buffer.from(await segment.arrayBuffer()), video);
      assert.equal((await fetch(segmentURL, { method: 'HEAD' })).status, 200);
    }
    assert.equal((await play(false)).provider, 'strmfree'); assert.equal(fallbacks, 1);
    assert.equal((await fetch(base + '/ui/live').then(r => r.json())).items.length, 1);
    const playlist = await fetch(base + '/get.php?' + auth + '&content=live').then(r => r.text());
    assert.equal((playlist.match(/#EXTINF:/g) || []).length, 1);

    // A failed segment must never receive a playlist or unrelated replacement
    // bytes. The next refresh of the original root adopts the ready fallback.
    failed = 'segment'; const fresh = await play(true); assert.equal(fresh.provider, 'sports');
    const primaryManifest = await fetch(fresh.url).then(r => r.text());
    const failedSegment = primaryManifest.split('\n').find(line => line.startsWith('http'));
    assert.equal((await fetch(failedSegment)).status, 502);
    assert.match(await fetch(fresh.url).then(r => r.text()), /MEDIA-SEQUENCE:50/);
    await settingsStore.configure({ live: { strmfree: false } });
    failed = 'playlist'; const disabled = await play(true);
    const before = fallbacks; assert.equal((await fetch(disabled.url)).status, 502); assert.equal(fallbacks, before);
    assert.equal((await fetch(base + '/player_api.php?' + auth + '&action=get_live_streams').then(r => r.json()))[0].stream_id, id);
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
