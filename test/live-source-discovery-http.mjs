import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { video } from './zlive-fixtures.mjs';

test('a saved Tim Streams channel follows a catalog and CDN move through its original signed root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-tim-move-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch, id = 1100000012;
  const file = join(directory, 'timstreams.json');
  const oldChannel = { key: 'news', id, provider: 'timstreams', name: 'Fixture News', category: 'news', live: true, sources: ['https://obsolete.example/embed'] };
  await writeFile(file, JSON.stringify({ ids: { news: id }, nextId: id, channels: [oldChannel], updatedAt: Date.now(), guideAt: Date.now() }));
  let server, moved = false, catalogs = 0;
  const contacted = [];
  try {
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.hostname === '127.0.0.1') return original(input, options);
      contacted.push(url.hostname);
      if (url.hostname === 'tim-streams.com') {
        assert.equal(url.pathname, '/api/channels'); catalogs++;
        const source = moved ? 'https://next-player.example/channel/news' : 'https://old-player.example/channel/news';
        return Response.json({ channels: [{ url: 'news', name: 'Fixture News', streams: [{ url: source }] }] });
      }
      if (url.hostname === 'old-player.example') return new Response('<video src="https://old-media.example/news.m3u8"></video>');
      if (url.hostname === 'next-player.example') return Response.redirect('https://new-player.example/news', 302);
      if (url.hostname === 'new-player.example' && url.pathname === '/tune') return Response.redirect('https://new-media.example/live.m3u8?version=fixture');
      if (url.hostname === 'new-player.example') return new Response('<video><source src="/tune" type="application/vnd.apple.mpegurl"></video>');
      if (['old-media.example', 'new-media.example'].includes(url.hostname)) {
        if (url.hostname === 'old-media.example' && moved && url.pathname === '/chunk.ts') return new Response(null, { status: 410 });
        if (url.pathname.endsWith('/variant.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk.ts\n');
        if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nvariant.m3u8\n');
        if (url.pathname === '/chunk.ts') return new Response(video);
      }
      throw Error('Unexpected fixture request');
    };
    const { createServer } = await import('../server.mjs');
    const { initializeIPTV, refreshLive } = await import('../api/iptv.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    const { watchProgressStore } = await import('../api/watch-progress.mjs');
    await initializeIPTV({ sportsDirectory: directory, sportsSource: { list: async () => ({ events: [], errors: [] }) }, zliveSource: { list: async () => [] } });
    const profile = await watchProgressStore.createProfile(settingsStore.get().ownerId, { name: 'Viewer', color: '#527de0' });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const entry = base + '/ui/playback.m3u8?' + new URLSearchParams({ type: 'live', id, profileId: profile.id });
    const native = await fetch(entry, { redirect: 'manual' });
    assert.equal(native.status, 302);
    const root = native.headers.get('location');
    const child = async (parent, tag) => {
      const playlist = await fetch(parent); assert.equal(playlist.status, 200);
      const body = await playlist.text(); assert.ok(body.includes(tag));
      const url = body.split('\n').find(line => line.startsWith('http'));
      assert.ok(url.startsWith(base + '/iptv/media/')); return url;
    };
    const originalVariant = await child(root, '#EXT-X-STREAM-INF');
    const old = await child(originalVariant, '#EXTINF');
    assert.deepEqual(Buffer.from(await fetch(old).then(r => r.arrayBuffer())), video);
    assert.equal(catalogs, 1);

    moved = true;
    const failures = await Promise.all([fetch(old), fetch(old)]);
    assert.deepEqual(failures.map(r => r.status), [502, 502], 'old segments stay on their original timeline');
    // Native HLS players usually reload only their selected media playlist.
    const replacement = await child(originalVariant, '#EXTINF'); assert.notEqual(replacement, old);
    assert.deepEqual(Buffer.from(await fetch(replacement).then(r => r.arrayBuffer())), video);
    assert.equal(await child(await child(root, '#EXT-X-STREAM-INF'), '#EXTINF'), replacement);
    assert.equal(catalogs, 2);
    assert.ok(!contacted.includes('obsolete.example'));
    assert.ok(contacted.includes('new-media.example'));
    await refreshLive();
    assert.deepEqual(JSON.parse(await readFile(file)).channels[0].sources, ['news']);
    assert.deepEqual((await fetch(base + '/ui/live').then(r => r.json())).items.map(row => row.stream_id), [id]);
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
