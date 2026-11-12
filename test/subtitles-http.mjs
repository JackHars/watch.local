import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the URLs consumed by AVKit/Safari, including cookie-free signed
// subtitle requests and seeking into a later WebVTT segment.
test('mobile and desktop playback deliver synchronized HLS subtitles through the signed relay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-subtitles-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch;
  const { settingsStore } = await import('../api/settings.mjs');
  const { watchProgressStore } = await import('../api/watch-progress.mjs');
  const { createServer } = await import('../server.mjs');
  const calls = [];
  const source = 'https://video.fixture.test';
  const providerHeaders = { origin: 'https://provider.test', referer: 'https://provider.test/player' };
  const video = Buffer.alloc(188 * 4, 0x47);
  video.set([0x47, 0x40, 0, 0x10, 0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]);
  // A video starting at PTS 900000 (10 seconds), rather than timestamp zero.
  video.set([0x21, 0, 0x37, 0x77, 0x41], 13);
  const media = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXTINF:60,\nvideo.ts\n#EXTINF:60,\nvideo.ts\n#EXTINF:5.25,\nvideo.ts\n#EXT-X-ENDLIST\n';
  const captions = '1\n00:00:01,000 --> 00:00:04,000\nFirst caption\n\n2\n00:00:59,500 --> 00:01:01,250\nAcross the boundary\n\n3\n00:01:02,000 --> 00:01:05,000\nAfter seeking\n';
  let server;
  try {
    await settingsStore.initialize();
    await settingsStore.configure({ playback: { enabled: ['zstream'] } });
    const owner = settingsStore.user(settingsStore.get().ownerId);
    await settingsStore.upsertUser({ username: 'captions', password: 'fixture-password' }, owner, owner.id);
    const profile = await watchProgressStore.createProfile(owner.id, { name: 'Captions', color: '#527de0' });
    globalThis.fetch = async (url, options) => {
      const u = new URL(url);
      if (u.hostname === '127.0.0.1') return original(url, options);
      calls.push(u);
      if (u.hostname === 'api.zstream.mov') {
        const input = JSON.parse(options.body);
        const path = input.type === 'show' ? '/episode/master.m3u8' : `/movie/${input.tmdb_id}/index.m3u8`;
        return Response.json({ streams: [{ type: 'hls', playlist: source + path, headers: providerHeaders }] });
      }
      if (u.origin === source) {
        const headers = new Headers(options?.headers);
        for (const [key, value] of Object.entries(providerHeaders)) assert.equal(headers.get(key), value);
        if (u.pathname.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2"\nindex.m3u8\n');
        if (u.pathname === '/movie/554/index.m3u8') return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="native",NAME="English",LANGUAGE="en",URI="subtitles.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="native"\nvideo.m3u8\n');
        if (u.pathname.endsWith('subtitles.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:125\n#EXTINF:125.25,\nnative.vtt\n#EXT-X-ENDLIST\n');
        if (u.pathname.endsWith('.m3u8')) return new Response(media);
        if (u.pathname.endsWith('.ts')) return new Response(video, { headers: { 'content-type': 'video/mp2t' } });
        if (u.pathname.endsWith('native.vtt')) return new Response('WEBVTT\n\n00:01.000 --> 00:04.000\nNative caption\n', { headers: { 'content-type': 'text/vtt' } });
      }
      if (u.hostname === 'subs.wing.st') {
        if (u.searchParams.get('tmdb') === '551') return Response.json({ subtitles: [] });
        if (u.searchParams.get('tmdb') === '552') return new Response('Unavailable', { status: 503 });
        return Response.json({ subtitles: [{ language: 'en', type: 'srt', url: 'https://captions.fixture.test/english.srt' }, { language: 'fr', type: 'srt', url: 'https://captions.fixture.test/french.srt' }] });
      }
      if (u.hostname === 'captions.fixture.test') return new Response(captions);
      return new Response('Unexpected fixture request', { status: 404 });
    };
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/ui/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'captions', password: 'fixture-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const native = await fetch(base + `/ui/playback.m3u8?type=tv&id=1396&season=2&episode=4&profileId=${profile.id}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(native.status, 302, native.status === 302 ? undefined : await native.text());
    const rootURL = native.headers.get('location');
    // AVKit can fetch these resources without the browser's session cookie.
    const root = await fetch(rootURL);
    assert.equal(root.status, 200); assert.match(root.headers.get('content-type'), /mpegurl/);
    const master = await root.text();
    assert.match(master, /TYPE=SUBTITLES.*NAME="English".*LANGUAGE="en"/);
    assert.match(master, /TYPE=SUBTITLES.*NAME="French".*LANGUAGE="fr"/);
    assert.match(master, /#EXT-X-STREAM-INF:.*SUBTITLES="cinejoy-subs"/);
    const lookup = calls.find(u => u.hostname === 'subs.wing.st');
    assert.deepEqual(Object.fromEntries(lookup.searchParams), { type: 'tv', tmdb: '1396', season: '2', episode: '4' });
    const subtitleURL = master.match(/TYPE=SUBTITLES[^\n]*URI="([^"]+)"/)[1];
    assert.ok(subtitleURL.startsWith(base + '/iptv/subtitles/'));
    const subtitleList = await fetch(subtitleURL).then(r => r.text());
    assert.match(subtitleList, /#EXTINF:5.250000,\nsegment-2.vtt\n#EXT-X-ENDLIST/);
    const segmentURL = new URL('segment-1.vtt', subtitleURL);
    const segment = await fetch(segmentURL);
    assert.equal(segment.status, 200); assert.match(segment.headers.get('content-type'), /^text\/vtt/);
    const vtt = await segment.text();
    assert.match(vtt, /^WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n/);
    assert.match(vtt, /Across the boundary/); assert.match(vtt, /00:01:02.000 --> 00:01:05.000\nAfter seeking/);
    assert.doesNotMatch(vtt, /First caption/);
    assert.equal((await fetch(new URL('segment-3.vtt', subtitleURL))).status, 404);
    assert.equal(await fetch(rootURL, { method: 'HEAD' }).then(r => r.text()), '');
    const videoURL = master.split('\n').find(line => line.startsWith('http'));
    const nested = await fetch(videoURL).then(r => r.text());
    assert.match(nested, /#EXTINF/); assert.doesNotMatch(nested, /TYPE=SUBTITLES|#EXT-X-STREAM-INF/);
    assert.deepEqual(Buffer.from(await fetch(nested.split('\n').find(line => line.startsWith('http'))).then(r => r.arrayBuffer())), video);
    assert.equal(calls.filter(u => u.hostname === 'subs.wing.st').length, 1, 'Nested playlists must not repeat subtitle discovery or wrap themselves');

    async function movie(id) {
      const response = await fetch(base + '/ui/play', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'movie', id, profileId: profile.id }) });
      assert.equal(response.status, 200);
      return fetch((await response.json()).url).then(r => r.text());
    }
    const direct = await movie(550);
    assert.match(direct, /#EXT-X-STREAM-INF:.*SUBTITLES=/, 'Direct media playlists need a master to expose captions');
    const directVideo = await fetch(direct.split('\n').find(line => line.startsWith('http'))).then(r => r.text());
    assert.match(directVideo, /#EXTINF/); assert.doesNotMatch(directVideo, /#EXT-X-STREAM-INF|TYPE=SUBTITLES/);
    for (const id of [551, 552]) {
      const fallback = await movie(id);
      assert.match(fallback, /#EXTINF/); assert.doesNotMatch(fallback, /TYPE=SUBTITLES/);
    }
    const beforeNative = calls.filter(u => u.hostname === 'subs.wing.st').length;
    const embedded = await movie(554);
    assert.match(embedded, /GROUP-ID="native"/); assert.doesNotMatch(embedded, /cinejoy-subs/);
    const nativeSubs = embedded.match(/TYPE=SUBTITLES[^\n]*URI="([^"]+)"/)[1];
    const nativeList = await fetch(nativeSubs).then(r => r.text());
    assert.match(await fetch(nativeList.split('\n').find(line => line.startsWith('http'))).then(r => r.text()), /Native caption/);
    assert.equal(calls.filter(u => u.hostname === 'subs.wing.st').length, beforeNative);

    await settingsStore.upsertUser({ password: 'changed-fixture-password' }, owner, owner.id);
    for (const url of [rootURL, subtitleURL, segmentURL]) assert.equal((await fetch(url)).status, 403, 'Video and captions must share account revocation');
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
