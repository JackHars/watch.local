import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSportsSource } from '../api/sports.mjs';

test('browser, native mobile and IPTV sports relay watch pages, player authorization, keys and fallback segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-sports-playback-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const original = globalThis.fetch;
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  const { settingsStore } = await import('../api/settings.mjs');
  const { watchProgressStore } = await import('../api/watch-progress.mjs');
  const now = Math.floor(Date.now() / 1000), channel = 'channel123456789', key = Buffer.alloc(16, 42), iv = Buffer.alloc(16);
  const video = Buffer.alloc(188 * 4, 0x47), cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(video), cipher.final()]);
  const encoded = text => Buffer.from(Buffer.from(text).map(b => b ^ 79)).toString('base64');
  const metadata = e => `<script>var sd = ${JSON.stringify({ starts_at:now-60, ends_at:now+3600, e })};</script>`;
  const slugs = ['nba/2026-11-12/encrypted-match', 'nba/2026-11-12/fallback-match'];
  let server, authorizations = 0;
  try {
    globalThis.fetch = async (url, options) => {
      const u = new URL(url), headers = new Headers(options?.headers);
      if (u.hostname === '127.0.0.1') return original(url, options);
      if (u.hostname === 'events.test') {
        if (u.pathname === '/nba') return new Response(slugs.map(slug => `<a href="/live/${slug}">Match</a>`).join(''));
        if (u.pathname.startsWith('/live/')) return new Response(metadata('') + `<table class="links-table"><tr><td><a class="watch-btn" href="https://watch.test/${u.pathname.split('/').at(-1)}">Watch</a></td></tr></table>`);
        return new Response('No events');
      }
      if (u.hostname === 'watch.test') return new Response(metadata(encoded(u.pathname === '/encrypted-match' ? `https://player.test/play/${channel}` : 'https://free.test/embed/basketball/team-a-vs-team-b1080p')));
      if (u.hostname === 'player.test') {
        if (u.pathname.startsWith('/play/')) return new Response(`<div id="scp" data-key="${channel}" data-hls="/hls.js"></div>`);
        if (u.pathname === '/api/v1/playback/authorize') {
          authorizations++; assert.equal(options.method, 'POST'); assert.equal(headers.get('origin'), 'https://player.test');
          assert.deepEqual(JSON.parse(options.body), { key:channel, native:false, embed_origin:'https://watch.test' });
          return Response.json({ ok:true, session:'fixture-private-session', key_auth:'fixture-private-key-auth', expires:now+3600, renew_in:300, sources:[{ id:'cdn', url:'https://cdn.test/token/channel/index.m3u8' }] });
        }
        if (u.pathname === `/sc-key/${channel}/run123.key`) {
          assert.equal(headers.get('x-sc-auth'), 'fixture-private-key-auth'); return new Response(key);
        }
      }
      if (u.hostname === 'cdn.test') {
        assert.equal(headers.get('x-sc-auth'), null, 'Key authorization must stay on the player host');
        assert.equal(headers.get('referer'), `https://player.test/play/${channel}`);
        if (u.pathname.endsWith('index.m3u8')) return new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="/sc-key/${channel}/run123.key",IV=0x${iv.toString('hex')}\n#EXTINF:4,\nsegment.ts\n`);
        if (u.pathname.endsWith('segment.ts')) return new Response(encrypted, { headers:{'content-type':'video/mp2t'} });
        assert.fail('Media keys must be fetched from the player, not its CDN');
      }
      if (u.hostname === 'free.test') {
        if (u.pathname.startsWith('/embed/')) return new Response(`<script>
          const QUALITY = '1080p'; const SOURCE_SUFFIX = ''; const VARIANT = 'team-a-vs-team-b' + QUALITY + SOURCE_SUFFIX;
          const _0x = ${JSON.stringify({'1080p':{_t:'fixture-token',_e:now+3600,_n:'fixture-nonce'}})};
          const data = await window.sfFetch('/get-stream-key/team-a-vs-team-b').then(r => r.json());
        </script>`);
        if (u.pathname.startsWith('/get-stream-key/')) return Response.json({ is_external:false, server_name:'externalcdn' });
        if (u.pathname.endsWith('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\nhttps://image.test/frame.webp#sf=' + encodeURIComponent('https://own-cdn.test/live/segment.js') + '\n');
      }
      if (u.hostname === 'own-cdn.test') {
        assert.equal(headers.get('origin'), 'https://free.test');
        if (headers.get('range')) { const end=Math.min(Number(headers.get('range').split('-')[1]),video.length-1);return new Response(video.subarray(0,end+1), { status:206, headers:{'content-type':'video/mp2t','content-range':`bytes 0-${end}/752`} }); }
        return new Response(options?.method === 'HEAD' ? null : video, { headers:{'content-type':'video/mp2t'} });
      }
      assert.fail('Unexpected sports fixture request: ' + u.hostname);
    };
    await initializeIPTV({ timstreamsSource: { list: async () => [] }, zliveSource: { async list() { return []; } }, sportsDirectory:directory, sportsSource:createSportsSource({ hosts:['events.test'], fetchResource:(...args) => fetch(...args) }) });
    const login = settingsStore.get(), owner = settingsStore.user(login.ownerId);
    const profile = await watchProgressStore.createProfile(owner.id, { name:'Live sports', color:'#527de0' });
    server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const items = await fetch(base+'/ui/live').then(r=>r.json());
    assert.equal(items.items.length,2);
    for (const event of items.items) {
      const post = await fetch(base+'/ui/play', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'live',id:event.stream_id,profileId:profile.id}) });
      assert.equal(post.status,200); const play = await post.json();
      const native = await fetch(base+`/ui/playback.m3u8?type=live&id=${event.stream_id}&profileId=${profile.id}`, {redirect:'manual'});
      assert.equal(native.status,302);
      const iptv = `${base}/live/${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}/${event.stream_id}.m3u8`;
      for (const entry of [play.url,native.headers.get('location'),iptv]) {
        const r = await fetch(entry); assert.equal(r.status,200); const manifest = await r.text();
        assert.match(r.headers.get('content-type'), /mpegurl/);
        assert.doesNotMatch(manifest, /fixture-private-session|fixture-private-key-auth/);
        const segmentURL = manifest.split('\n').find(line=>line.startsWith('http'));
        await new Promise(resolve=>setTimeout(resolve,5));
        const refreshed = await fetch(entry).then(r=>r.text());
        assert.equal(refreshed.split('\n').find(line=>line.startsWith('http')),segmentURL,'Playlist refreshes must preserve segment identity for HLS players');
        const segment = await fetch(segmentURL); assert.equal(segment.status,200);
        let bytes = Buffer.from(await segment.arrayBuffer());
        const keyURL = manifest.match(/#EXT-X-KEY:.*URI="([^"]+)"/)?.[1];
        if (keyURL) {
          const response = await fetch(keyURL); assert.equal(response.status,200);
          const servedKey = Buffer.from(await response.arrayBuffer()); assert.deepEqual(servedKey,key);
          const decipher = createDecipheriv('aes-128-cbc',servedKey,iv); bytes = Buffer.concat([decipher.update(bytes),decipher.final()]);
        } else {
          assert.equal((await fetch(segmentURL,{headers:{Range:'bytes=0-31'}})).status,206);
          assert.equal((await fetch(segmentURL,{method:'HEAD'})).status,200);
        }
        assert.deepEqual(bytes,video);
      }
    }
    assert.equal(authorizations,1,'Requests for the same public player share its renewable session');
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if(server) await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
