import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveZlive } from '../api/zlive-resolver.mjs';
import { createZliveSource, createZliveProvider, ZLIVE_ID_BASE } from '../api/zlive.mjs';
import { channel } from './zlive-fixtures.mjs';

test('ZLive signer sends required headers on ticket and resolve calls without leaking globals', async () => {
  const calls = [];
  const url = await resolveZlive('fixture-key', { fetchResource: async (url, options) => {
    calls.push(url.pathname); assert.equal(options.headers['user-agent'], 'Mozilla/5.0'); assert.equal(options.headers.origin, 'https://zlive.st'); assert.equal(options.headers.referer, 'https://zlive.st/');
    if (url.pathname === '/session/ticket') return Response.json({ w: 'fixture-public-ticket' });
    assert.equal(options.method, 'POST'); assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['a','b','c','d','e']);
    return Response.json({ location: 'https://video.test/live.m3u8' });
  } });
  assert.equal(url, 'https://video.test/live.m3u8'); assert.deepEqual(calls, ['/session/ticket', '/resolve']); assert.equal(globalThis.__decoded, undefined);
  await assert.rejects(resolveZlive('https://untrusted.test/'), /Invalid/);
});

test('ZLive reads catalog and guide metadata, sanitizes fields and checks playlist responses', async () => {
  const source = createZliveSource({ resolve: async key => 'https://video.test/' + key, fetchResource: async (url, options) => {
    const u = new URL(url); assert.equal(options.headers.origin, 'https://zlive.st');
    if (u.pathname === '/channels.json') return Response.json([{ id: 'fixture', name: 'Fixture', sport: 'Kids', accent: 'red;bad', sources: [{ key: 'fixture' }, { key: 'https://bad.test' }] }, { id: 'invalid', name: 'Bad', sources: [] }]);
    if (u.pathname === '/epg.json') return Response.json({ channels: [{ id: 'fixture', now: { title: 'Current show', start: '2026-11-12T05:00:00Z', stop: '2026-11-12T06:00:00Z' }, next: { title: 'Bad date', start: 'invalid' } }] });
    return new Response(u.pathname === '/fixture' ? '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' : '<html>Down</html>');
  } });
  const rows = await source.list(); assert.equal(rows.length, 1); assert.deepEqual(rows[0].sources, ['fixture']); assert.equal(rows[0].accent, '#648bd9');
  assert.equal((await source.guide()).fixture.length, 1); assert.equal((await source.resolve('fixture')).url, 'https://video.test/fixture');
  await assert.rejects(source.resolve('down'), /playlist/);
});

test('ZLive preserves channel IDs, falls back between sources, renews streams and retains offline listings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-zlive-')); let clock = Date.parse('2026-11-12T05:30:00Z'), fail = false, generation = 1, resolves = 0;
  const source = {
    async list() { if (fail) throw Error('Offline'); return [channel]; },
    async guide() { return { [channel.key]: [{ title: 'Current & next', description: 'A show', start: clock / 1000 - 60, stop: clock / 1000 + 3600 }] }; },
    async resolve(key) { resolves++; if (key === 'fixture-primary') throw Error('Unavailable'); return { url: `https://video.test/${generation}/live.m3u8`, headers: {} }; },
  };
  try {
    const provider = createZliveProvider({ directory, source, now: () => clock }); await provider.initialize();
    const rows = await provider.rows(String); const id = rows[0].stream_id; assert.ok(id > ZLIVE_ID_BASE); assert.equal(rows[0].stream_type, 'live');
    assert.equal((await provider.browserRows())[0].program, 'Current & next'); assert.match(await provider.xmltv(), /Current &amp; next/);
    const [a, b] = await Promise.all([provider.resolve(id), provider.resolve(id)]); assert.equal(a, b); assert.equal(resolves, 2);
    clock += 61000; generation++;
    const media = await provider.media(a.url, a.playback); assert.equal(media.url, 'https://video.test/2/live.m3u8'); assert.equal(media.headers.origin, 'https://zlive.st');
    await assert.rejects(provider.resolve(123), { status: 404 });
    const restored = createZliveProvider({ directory, source, now: () => clock }); await restored.initialize();
    assert.equal((await restored.rows(String))[0].stream_id, id);
    fail = true; await restored.refresh({ force: true }); assert.equal((await restored.rows(String))[0].stream_id, id); assert.match(restored.status().error, /Offline/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
