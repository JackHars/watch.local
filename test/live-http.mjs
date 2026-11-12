import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { channel, wrappedVideo, video } from './zlive-fixtures.mjs';
import { zliveHeaders } from '../api/zlive-resolver.mjs';

test('ZLive and sports share browser/native/Xtream/M3U/EPG routes, decoding only channel video', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-live-http-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  const now = Math.floor(Date.now() / 1000);
  const headersSeen = [], requests = [];
  let downloads = 0, resolutions = 0, catalogs = 0, server;
  const upstream = http.createServer((req, res) => {
    headersSeen.push(req.headers);
    if (req.headers.origin !== zliveHeaders.origin || req.headers.referer !== zliveHeaders.referer) { res.writeHead(403); return res.end(); }
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:6,\nvideo.image\n');
    if (req.url === '/video.image') { downloads++; res.setHeader('Content-Type', 'image/png'); return res.end(wrappedVideo()); }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}`;
  const event = { host: 'sports.test', sport: 'nba', slug: 'nba/2026-10-22/test-match', title: 'Fixture Game', starts_at: now - 60, ends_at: now + 3600, has_payload: true, stream_url: remote + '/master.m3u8', pageURL: 'https://zlive.st/' };
  const sportsSource = { async list(sport) { return { events: sport === 'nba' ? [event] : [], errors: [] }; }, async resolve(e) { return e; }, async hls(e) { return { url: e.stream_url, headers: zliveHeaders }; } };
  const zliveSource = {
    async list() { catalogs++; return [channel, { ...channel, key: 'another-tv', name: 'Another TV', group: 'Kids' }]; },
    async guide() { return { [channel.key]: [{ title: 'Now & Next', description: 'A <programme>', start: now - 60, stop: now + 3600 }] }; },
    async resolve() { resolutions++; return { url: remote + '/master.m3u8', headers: zliveHeaders }; },
  };
  try {
    await initializeIPTV({ sportsDirectory: directory, sportsSource, zliveSource });
    const settings = settingsStore.get();
    server = createServer({ onRequest: event => requests.push(event) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = new URLSearchParams({ username: settings.username, password: settings.password });
    const api = (action, extra = {}) => fetch(base + '/player_api.php?' + new URLSearchParams({ ...Object.fromEntries(auth), action, ...extra })).then(r => r.json());
    const request = (path, value, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(value) });
    let rows = await api('get_live_streams');
    assert.equal(rows.length, 3);
    const tv = rows.find(r => r.name === channel.name), sport = rows.find(r => r.name.includes('Fixture Game'));
    assert.ok(tv.stream_id > 1000000000); assert.ok(sport.stream_id < 1000000000);
    assert.equal((await api('get_live_categories')).length, 3);
    assert.deepEqual((await api('get_live_streams', { category_id: tv.category_id })).map(r => r.stream_id), [tv.stream_id]);
    const web = await fetch(base + '/ui/live').then(r => r.json());
    assert.equal(web.items.find(r => r.provider === 'sports').stream_id, sport.stream_id);
    assert.equal(web.items.find(r => r.stream_id === tv.stream_id).program, 'Now & Next');
    const status = await fetch(base + '/ui/settings').then(r => r.json());
    assert.deepEqual(status.config.live, { sports: true, zlive: true });
    assert.equal(status.live.zlive.channels, 2);
    const epg = await api('get_short_epg', { stream_id: tv.stream_id });
    assert.equal(epg.epg_listings[0].channel_id, tv.epg_channel_id);
    assert.equal(Buffer.from(epg.epg_listings[0].title, 'base64').toString(), 'Now & Next');
    const xml = await fetch(base + '/xmltv.php?' + auth).then(r => r.text());
    assert.equal((xml.match(/<tv /g) || []).length, 1);
    assert.equal((xml.match(/<channel /g) || []).length, 3);
    assert.ok(xml.lastIndexOf('</channel>') < xml.indexOf('<programme '));
    assert.match(xml, /Now &amp; Next/); assert.match(xml, /A &lt;programme&gt;/);
    const playlist = await fetch(base + '/get.php?' + auth + '&content=live').then(r => r.text());
    assert.ok(playlist.includes(tv.direct_source)); assert.ok(playlist.includes(sport.direct_source));
    assert.match(playlist, /group-title="ZLive · Entertainment"/);

    const master = await fetch(tv.direct_source).then(r => r.text());
    assert.match(master, /^#EXTM3U/); assert.doesNotMatch(master, /ENDLIST/);
    const segment = master.split('\n').find(l => l.startsWith('http'));
    assert.match(segment, /\/segment\.ts$/);
    assert.equal(segment, (await fetch(tv.direct_source).then(r => r.text())).split('\n').find(l => l.startsWith('http')), 'live segment URLs stay stable across reloads');
    let r = await fetch(segment); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'video/mp2t');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), video);
    r = await fetch(segment, { headers: { Range: 'bytes=188-375' } }); assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 188-375/${video.length}`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), video.subarray(188, 376));
    r = await fetch(segment, { method: 'HEAD' }); assert.equal(r.headers.get('content-length'), String(video.length)); assert.equal((await r.text()).length, 0);
    assert.equal(downloads, 1); assert.equal(resolutions, 1);
    assert.ok(headersSeen.every(h => !h.range), 'client ranges must not be applied to the image wrapper');

    const { profile } = await request('/ui/profiles', { name: 'Viewer', color: '#527de0' }).then(r => r.json());
    const input = { type: 'live', id: tv.stream_id, profileId: profile.id };
    const browser = await request('/ui/play', input).then(r => r.json()); assert.equal(browser.provider, 'zlive');
    r = await fetch(base + '/ui/playback.m3u8?' + new URLSearchParams(input), { redirect: 'manual' }); assert.equal(r.status, 302);
    assert.match(await fetch(r.headers.get('location')).then(r => r.text()), /#EXTM3U/);
    assert.equal((await fetch(tv.direct_source.replace(encodeURIComponent(settings.password), 'wrong'))).status, 401);
    assert.equal((await fetch(base + '/ui/live/refresh', { method: 'POST', headers: { Origin: 'https://untrusted.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request('/ui/live/refresh', {})).status, 200); assert.equal(catalogs, 2);

    assert.equal((await request('/ui/settings', { live: { zlive: false } }, 'PUT')).status, 200);
    assert.deepEqual((await api('get_live_streams')).map(r => r.stream_id), [sport.stream_id]);
    assert.equal((await fetch(tv.direct_source)).status, 403); assert.equal((await fetch(segment)).status, 403);
    assert.equal((await request('/ui/settings', { live: { zlive: true, sports: false } }, 'PUT')).status, 200);
    rows = await api('get_live_streams'); assert.equal(rows.length, 2); assert.equal(rows.find(r => r.name === channel.name).stream_id, tv.stream_id);
    assert.equal((await fetch(sport.direct_source)).status, 403);
    assert.ok(requests.every(r => !r.target.includes(settings.password)));
  } finally {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
