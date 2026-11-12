import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decodeZliveMedia, createZliveRelay } from '../api/zlive-media.mjs';
import { video, wrappedVideo } from './zlive-fixtures.mjs';

test('ZLive unwraps RGB/RGBA pixel containers, appended TS and marker payloads', async () => {
  for (const input of [video, wrappedVideo(), wrappedVideo({ rgba: true }), Buffer.concat([wrappedVideo(), video]), Buffer.concat([Buffer.from('prefixTIKTIKRAW'), video]), Buffer.concat([Buffer.from('TIKTIKTSGZ'), gzipSync(video)])]) assert.deepEqual(await decodeZliveMedia(input), video);
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('EXIF', 12); webp.writeUInt32LE(video.length, 16);
  assert.deepEqual(await decodeZliveMedia(Buffer.concat([webp, video])), video);
  const indexedPNG = wrappedVideo(); indexedPNG[25] = 3; // Pixel format is irrelevant when TS follows IEND.
  assert.deepEqual(await decodeZliveMedia(Buffer.concat([indexedPNG, video])), video);
});

test('ZLive rejects error pages, truncated containers and excessive decoded dimensions', async () => {
  for (const input of [Buffer.from('<html>Blocked</html>'), wrappedVideo().subarray(0, 30), Buffer.from('TIKTIKTSGZnot-gzip')]) await assert.rejects(decodeZliveMedia(input));
  const enormous = wrappedVideo(); enormous.writeUInt32BE(0x7fffffff, 16);
  await assert.rejects(decodeZliveMedia(enormous), /unsupported/);
});

test('decoded segment relay serves ranges/HEAD, shares downloads, expires cache and retries failures', async () => {
  let requests = 0, clock = 1000, fail = false;
  const relay = createZliveRelay({ now: () => clock, fetchResource: async (url, options) => {
    requests++; assert.equal(options.headers.Range, undefined); assert.equal(options.headers.Origin, 'https://zlive.st');
    if (fail) return new Response('Down', { status: 503 });
    await new Promise(resolve => setTimeout(resolve, 5)); return new Response(wrappedVideo(), { headers: { 'content-type': 'image/png' } });
  } });
  const server = createServer((req, res) => relay(req, res, 'https://video.test/fixture.image', { Origin: 'https://zlive.st' }).catch(e => { res.writeHead(e.status || 502); res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const replies = await Promise.all([fetch(base), fetch(base, { headers: { Range: 'bytes=0-31' } })]);
    assert.equal(requests, 1); assert.equal(replies[0].headers.get('content-type'), 'video/mp2t');
    assert.deepEqual(Buffer.from(await replies[0].arrayBuffer()), video);
    assert.equal(replies[1].status, 206); assert.equal(replies[1].headers.get('content-range'), `bytes 0-31/${video.length}`);
    assert.deepEqual(Buffer.from(await replies[1].arrayBuffer()), video.subarray(0, 32));
    const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(video.length)); assert.equal(await head.text(), '');
    assert.equal((await fetch(base, { headers: { Range: 'bytes=999999-' } })).status, 416);
    assert.deepEqual(Buffer.from(await fetch(base, { headers: { Range: 'bytes=-16' } }).then(r => r.arrayBuffer())), video.subarray(-16));
    clock += 30001; fail = true; assert.equal((await fetch(base)).status, 502);
    fail = false; assert.equal((await fetch(base)).status, 200); assert.equal(requests, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
