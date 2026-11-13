import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { video, wrappedVideo } from './zlive-fixtures.mjs';

test('one channel card uses Tim Streams when primary video fails, with native/Xtream relays and independent settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-timstreams-http-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  let server, primaryDown = true, timDown = false, timResolves = 0, primaryChecks = 0;
  const headers = { referer: 'https://player.test/play/fixture', origin: 'https://player.test', 'user-agent': 'Mozilla/5.0' };
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/tim/') && req.headers.referer !== headers.referer) { res.writeHead(403); return res.end(); }
    if (req.url.endsWith('.m3u8')) return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk.ts\n');
    if (req.url.startsWith('/primary/')) {
      primaryChecks++; if (primaryDown) { res.writeHead(503); return res.end(); }
      return res.end(wrappedVideo());
    }
    if (timDown) { res.writeHead(503); return res.end(); }
    res.setHeader('Content-Type', 'video/mp2t'); return res.end(video);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}`;
  const channel = { key: 'auto-cnn', name: 'CNN', group: 'Other', live: true, sources: ['primary'] };
  try {
    await initializeIPTV({ sportsDirectory: directory,
      sportsSource: { list: async () => ({ events: [], errors: [] }) },
      zliveSource: { list: async () => [channel], resolve: async () => ({ url: remote + '/primary/live.m3u8', headers: {} }) },
      timstreamsSource: { list: async () => [{ ...channel, provider: 'timstreams', key: 'cnn', sources: ['https://player.test/cnn'] }, { ...channel, provider: 'timstreams', key: 'new', name: 'New Network', category: 'news', sources: ['https://player.test/new'] }], resolve: async () => { timResolves++; return { url: remote + '/tim/live.m3u8', headers }; } },
    });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, value, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(value) });
    const web = await fetch(base + '/ui/live').then(r => r.json());
    assert.equal(web.items.length, 2); const cnn = web.items.find(r => r.title === 'CNN');
    assert.equal(cnn.source_count, 2); assert.equal(cnn.provider, 'zlive');
    const settings = settingsStore.get(), auth = new URLSearchParams({ username: settings.username, password: settings.password });
    const api = (action, extra = {}) => fetch(base + '/player_api.php?' + new URLSearchParams({ ...Object.fromEntries(auth), action, ...extra })).then(r => r.json());
    const rows = await api('get_live_streams'), primary = rows.find(r => r.stream_id === cnn.stream_id), tim = rows.find(r => r.stream_id > 1100000000);
    assert.equal(rows.length, 3); assert.equal(new Set(rows.map(r => r.stream_id)).size, 3);
    assert.equal((await api('get_live_categories')).length, 1, 'shared genres are not duplicated');
    assert.match(await fetch(base + '/get.php?' + auth + '&content=live').then(r => r.text()), /New Network/);
    assert.match(await fetch(base + '/xmltv.php?' + auth).then(r => r.text()), /timstreams-cnn/);
    assert.equal((await api('get_short_epg', { stream_id: tim.stream_id })).epg_listings.length, 0);
    const { profile } = await request('/ui/profiles', { name: 'Viewer', color: '#527de0' }).then(r => r.json());
    const input = { type: 'live', id: cnn.stream_id, profileId: profile.id };
    const play = await request('/ui/play', input).then(r => r.json());
    assert.equal(play.provider, 'timstreams'); assert.equal(primaryChecks, 1); assert.equal(timResolves, 1);
    const manifest = await fetch(play.url).then(r => r.text());
    const segment = manifest.split('\n').find(line => line.startsWith('http'));
    const bytes = await fetch(segment); assert.equal(bytes.status, 200); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), video);
    const native = await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams(input), { redirect: 'manual' });
    assert.equal(native.status, 302); assert.match(await fetch(native.headers.get('location')).then(r => r.text()), /#EXTM3U/);
    assert.match(await fetch(primary.direct_source).then(r => r.text()), /#EXTM3U/);
    // A failure after successful startup primes the same root URL to switch.
    primaryDown = false;
    const restarted = await request('/ui/play', { ...input, fresh: true }).then(r => r.json());
    assert.equal(restarted.provider, 'zlive');
    const primaryManifest = await fetch(restarted.url).then(r => r.text());
    const primarySegment = primaryManifest.split('\n').find(line => line.startsWith('http'));
    primaryDown = true;
    assert.equal((await fetch(primarySegment)).status, 502);
    const recovered = await fetch(restarted.url).then(r => r.text());
    const nextSegment = recovered.split('\n').find(line => line.startsWith('http'));
    const next = await fetch(nextSegment); assert.equal(next.status, 200);
    assert.deepEqual(Buffer.from(await next.arrayBuffer()), video);
    await request('/ui/settings', { live: { timstreams: false } }, 'PUT');
    assert.equal((await fetch(base + '/ui/live').then(r => r.json())).items.length, 1);
    assert.equal((await fetch(tim.direct_source)).status, 403);
    await request('/ui/settings', { live: { zlive: false, timstreams: true } }, 'PUT');
    const onlyTim = (await fetch(base + '/ui/live').then(r => r.json())).items;
    assert.equal(onlyTim.length, 2); assert.equal(onlyTim.find(r => r.title === 'CNN').stream_id, tim.stream_id);
  } finally {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
