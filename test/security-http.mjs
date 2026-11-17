import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate credentials and all application state from the real installation.
const directory = await mkdtemp(join(tmpdir(), 'watchlocal-security-'));
process.env.WATCHLOCAL_DATA_DIR = directory;
const { createProviderContext } = await import('../api/providers.mjs');
const { fetchUpstream } = await import('../api/platform.mjs');

test('provider reads and the media relay cannot contact a local service', async () => {
  let requests = 0;
  const internal = http.createServer((req, res) => { requests++; res.end('private service'); });
  internal.listen(0, '127.0.0.1'); await once(internal, 'listening');
  const url = `http://127.0.0.1:${internal.address().port}/private`;
  try {
    await assert.rejects(createProviderContext({}).text(url), /public|private|blocked/i);
    await assert.rejects(fetchUpstream(url), /public|private|blocked/i);
    assert.equal(requests, 0, 'reject before sending any request to the internal service');
  } finally {
    internal.closeAllConnections(); await new Promise(resolve => internal.close(resolve));
  }
});

test('signed playback cannot reach internal addresses or serve an active document; login limits cover Xtream too', async () => {
  const original = globalThis.fetch;
  const { settingsStore } = await import('../api/settings.mjs');
  const { initializeIPTV } = await import('../api/iptv.mjs');
  const { createServer } = await import('../server.mjs');
  let server;
  const upstreamRequests = [];
  try {
    await initializeIPTV({ sportsDirectory: directory });
    await settingsStore.configure({ server: { requireLanLogin: true } });
    const state = settingsStore.get(), user = settingsStore.user(state.ownerId);
    const tokenFor = upstream => {
      const payload = Buffer.from(JSON.stringify({ uid: user.id, version: user.version, u: upstream, exp: Date.now() + 60000 })).toString('base64url');
      return payload + '.' + createHmac('sha256', state.secret).update(payload).digest('base64url');
    };
    globalThis.fetch = async (value, options) => {
      const url = new URL(value);
      if (url.hostname === '127.0.0.1') return original(value, options);
      upstreamRequests.push(url.href);
      if (url.pathname === '/malicious.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/ui/connections")</script></svg>', { headers: { 'content-type': 'image/svg+xml' } });
      if (url.pathname === '/root.m3u8') return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttp://127.0.0.1:1234/private\n');
      return new Response('unavailable', { status: 404 });
    };
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = upstream => `${base}/iptv/media/${tokenFor(upstream)}/playlist.m3u8`;
    let response = await original(signed('https://media.example/malicious.svg'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-security-policy'), /(?:^|;)\s*sandbox(?:;|$)/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); await response.text();
    response = await original(signed(base + '/ui/connections'));
    assert.equal(response.status, 502); assert.match((await response.json()).error, /blocked/);
    response = await original(signed('https://media.example/root.m3u8'));
    const child = (await response.text()).split('\n').find(line => line.startsWith('http'));
    assert.ok(child?.startsWith(base + '/iptv/media/'));
    response = await original(child); assert.equal(response.status, 502); assert.match((await response.json()).error, /blocked/);
    assert.equal(upstreamRequests.length, 2, 'neither internal target is dispatched');
    const app = await original(base + '/');
    assert.match(app.headers.get('content-security-policy'), /script-src 'self'/); assert.doesNotMatch(app.headers.get('content-security-policy'), /\bsandbox\b/);
    assert.equal((await original(base + '/ui/settings')).status, 401);
    const login = (password, path = '/ui/login') => original(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password }) });
    for (let index = 0; index < 25; index++) assert.equal((await login(user.password, '/player_api.php')).status, 200, 'successful IPTV requests do not consume the failed-login budget');
    for (let index = 0; index < 15; index++) {
      const result = index % 3 === 0 ? await login('wrong') : index % 3 === 1 ? await login('wrong', '/player_api.php')
        : await original(base + `/movie/${encodeURIComponent(user.username)}/wrong/550.m3u8`);
      assert.equal(result.status, 401);
    }
    response = await login('wrong', '/player_api.php'); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await login('wrong')).status, 429, 'switching auth endpoints cannot bypass the limit');
    response = await original(base + '/player_api.php?username=wrong&password=wrong', { headers: { 'x-forwarded-for': '1.1.1.1' } });
    assert.equal(response.status, 429, 'forwarded headers cannot choose a new attempt budget');
  } finally {
    globalThis.fetch = original;
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
