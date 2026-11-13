import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderResolver } from '../api/providers.mjs';
import { reelixPlayerURL } from '../api/reelix.mjs';
import { readReelixProtocol, decryptReelixResponse, reelixHandshake, reelixChallenge } from '../api/reelix-protocol.mjs';
import { reelixFixture, reelixFetch } from './fixtures/reelix.mjs';

test('Reelix reads public client parameters as data and authenticates encrypted replies', () => {
  const fixture = reelixFixture(), protocol = readReelixProtocol(fixture.script);
  assert.deepEqual(protocol.responseKey, fixture.responseKey);
  assert.equal(protocol.transforms.length, 5); assert.equal(protocol.rc4.length, 5);
  assert.deepEqual(decryptReelixResponse(fixture.encrypt({ tmdbId: 278, url: 'https://media.test/master.m3u8' }), protocol), { tmdbId: 278, url: 'https://media.test/master.m3u8' });
  const damaged = Buffer.from(fixture.encrypt({ tmdbId: 278 }), 'base64'); damaged[30] ^= 1;
  assert.throws(() => decryptReelixResponse(damaged.toString('base64'), protocol), /invalid playback response/);
  for (const script of ['', '<html>challenge</html>', fixture.script.replace('streams0001', 'invalid'), 'a'.repeat(4 * 1024 * 1024)]) assert.throws(() => readReelixProtocol(script));
  assert.throws(() => decryptReelixResponse('bad', protocol));
  assert.throws(() => reelixHandshake('../path', protocol));
  assert.throws(() => reelixChallenge('a'.repeat(8193), protocol));
});

test('Reelix preserves explicit IDs, episode numbers and season-zero specials', () => {
  assert.equal(reelixPlayerURL({ tmdb: 278, kind: 'movie' }), 'https://vidcore.io/movie/278');
  assert.equal(reelixPlayerURL({ tmdb: 1396, kind: 'series', season: 0, episode: 2 }), 'https://vidcore.io/tv/1396/0/2');
  for (const tmdb of ['278/other', 0, -1, 'Interstellar']) assert.throws(() => reelixPlayerURL({ tmdb, kind: 'movie' }));
  assert.throws(() => reelixPlayerURL({ tmdb: 1396, kind: 'series', season: -1, episode: 1 }));
});

for (const kind of ['movie', 'series']) test(`Reelix ${kind} resolves native HLS and tries its second feed when the first is not video`, async () => {
  const fixture = reelixFetch({ brokenFirst: true });
  const resolve = createProviderResolver(fixture);
  const result = await resolve({ tmdb: 278, kind, season: 0, episode: 2, provider: 'reelix' });
  assert.equal(result.provider, 'reelix'); assert.equal(result.variants[0].width, 1280);
  assert.equal(result.headers.origin, 'https://vidcore.io');
  assert.equal(fixture.calls.filter(u => u.pathname.includes('/streams0001/')).length, 2);
  assert.equal(fixture.calls[0].pathname, kind === 'movie' ? '/movie/278' : '/tv/278/0/2');
  assert.ok(fixture.calls.some(u => u.pathname === '/segment.ts'));
  assert.ok(!fixture.calls.some(u => u.hostname === 'reelix.ac' || u.pathname.includes('search')));
  const before = fixture.calls.length;
  assert.equal((await resolve({ tmdb: 278, kind, season: 0, episode: 2, provider: 'reelix' })).cached, true);
  assert.equal(fixture.calls.length, before);
  await resolve({ tmdb: 550, kind, season: 0, episode: 2, provider: 'reelix' });
  assert.equal(fixture.calls.filter(u => u.pathname.endsWith('.js')).length, 1, 'reuse public parameters, never reuse another movie session');
});

test('Reelix participates in configured fallback without duplicated catalog entries', async () => {
  const fixture = reelixFetch({ noReferrer: true });
  const policy = { order: ['cinejoy', 'reelix'], enabled: ['cinejoy', 'reelix'], providerTimeout: 5, totalTimeout: 10, cacheSeconds: 0 };
  const resolve = createProviderResolver({ ...fixture, cinejoy: async () => { throw new Error('Offline'); }, getPolicy: () => policy });
  const result = await resolve({ tmdb: 278, kind: 'movie' });
  assert.deepEqual(result.provider_order, ['cinejoy', 'reelix']);
  assert.equal(result.headers.referer, undefined); assert.equal(result.headers.origin, undefined);
  policy.enabled = ['cinejoy'];
  await assert.rejects(resolve({ tmdb: 278, kind: 'movie', provider: 'reelix' }), /disabled/);
  policy.enabled = ['cinejoy', 'reelix'];
  const before = fixture.calls.length;
  await assert.rejects(resolve({ tmdb: 278, kind: 'movie', exclude: ['reelix'] }));
  assert.equal(fixture.calls.length, before);
});

test('Reelix rejects mismatched media and unplayable feeds, and respects cancellation', async () => {
  for (const options of [{ wrongID: true }, { allBroken: true }]) {
    const fixture = reelixFetch(options), resolve = createProviderResolver(fixture);
    await assert.rejects(resolve({ tmdb: 278, kind: 'movie', provider: 'reelix' }), e => e.provider_errors.reelix === 'Reelix has no playable source for this title');
  }
  const fixture = reelixFetch(), resolve = createProviderResolver(fixture);
  await assert.rejects(resolve({ tmdb: 278, kind: 'movie', provider: 'reelix', signal: AbortSignal.abort() }));
  assert.equal(fixture.calls.length, 0);
});

test('Reelix serves real IPTV routes and the signed local HLS relay', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-reelix-http-'));
  const originalFetch = globalThis.fetch;
  process.env.WATCHLOCAL_DATA_DIR = directory;
  let server;
  try {
    const fixture = reelixFetch({ brokenFirst: true });
    globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1' ? originalFetch(url, options) : fixture.fetchResource(url, options);
    const { initializeIPTV } = await import('../api/iptv.mjs');
    const { createServer } = await import('../server.mjs');
    const { settingsStore } = await import('../api/settings.mjs');
    await initializeIPTV({ sportsDirectory: directory });
    await settingsStore.configure({ playback: { enabled: ['reelix'] } });
    server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port, account = settingsStore.get();
    const response = await originalFetch(`${base}/movie/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/278.m3u8`);
    assert.equal(response.status, 200); const master = await response.text();
    assert.match(master, /1280x720/);
    const leafURL = master.split('\n').find(l => l.startsWith('http'));
    const leaf = await originalFetch(leafURL).then(r => r.text());
    const segmentURL = leaf.split('\n').find(l => l.startsWith('http'));
    const segment = await originalFetch(segmentURL);
    assert.equal(segment.status, 200); assert.equal((await segment.arrayBuffer()).byteLength, 188 * 4);
    assert.doesNotMatch(master, /vidcore\.io|fixture-source/);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
