import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fetchJSON } from '../public/request.mjs';

const never = () => new Promise(() => {});
test('startup requests time out both stalled connections and stalled JSON bodies, then allow a fresh retry', async () => {
  for (const stage of ['headers', 'body']) {
    let signal;
    const stuck = async (_, options) => { signal = options.signal; return stage === 'headers' ? never() : { json: never }; };
    await assert.rejects(fetchJSON('/ui/session', { timeoutMs: 10 }, stuck), /server took too long/);
    assert.equal(signal.aborted, true);
    const healthy = await fetchJSON('/ui/session', { timeoutMs: 10 }, async () => Response.json({ user: { id: 'fixture-owner' } }));
    assert.equal(healthy.data.user.id, 'fixture-owner');
  }
});
test('startup preserves authentication failures, reports invalid responses and honours caller cancellation', async () => {
  const denied = await fetchJSON('/ui/profiles', { timeoutMs: 50 }, async () => Response.json({ error: 'Sign in required.' }, { status: 401 }));
  assert.equal(denied.response.status, 401); assert.equal(denied.data.error, 'Sign in required.');
  await assert.rejects(fetchJSON('/ui/session', { timeoutMs: 50 }, async () => new Response('<html>Bad gateway</html>')), /unreadable response/);
  const controller = new AbortController();
  const pending = fetchJSON('/ui/profiles', { timeoutMs: 1000, signal: controller.signal }, never);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const ordinary = await fetchJSON('/ui/play', { method: 'POST', body: '{}' }, async (_, options) => {
    assert.equal(options.signal, undefined, 'Do not impose a startup timeout on stream resolution');
    assert.equal(options.method, 'POST'); return Response.json({ ready: true });
  });
  assert.equal(ordinary.data.ready, true);
});

const guard = await readFile(new URL('../public/boot.js', import.meta.url), 'utf8');
function boot() {
  const events = new Map(), timers = new Map(), nodes = { p: {}, button: {} };
  const screen = { isConnected: true, innerHTML: 'Opening your library…', querySelector: selector => nodes[selector] };
  let reloads = 0;
  const target = { addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type) };
  runInNewContext(guard, {
    window: target, document: { ...target, getElementById: () => screen }, location: { reload: () => reloads++ },
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id),
  });
  return { screen, nodes, events, timers, reloads: () => reloads };
}
test('a missing app module gets a usable retry screen even when the application never starts', () => {
  const b = boot(); b.events.get('error')({ target: { tagName: 'SCRIPT', src: 'http://watch.local/app.js' } });
  assert.match(b.screen.innerHTML, /Unable to open your library/);
  assert.match(b.nodes.p.textContent, /restart watch.local/);
  b.nodes.button.onclick(); assert.equal(b.reloads(), 1);
  assert.equal(b.timers.size, 0);
});
test('startup guard handles script evaluation errors and a stalled download, without interfering with loaded screens or optional HLS', () => {
  const crash = boot(); crash.events.get('error')({ filename: 'http://watch.local/live-model.mjs' });
  assert.match(crash.nodes.p.textContent, /could not start/);
  const stalled = boot(); stalled.timers.get(1)(); assert.match(stalled.nodes.p.textContent, /taking too long/);
  const ready = boot(); ready.events.get('watchlocal-ready')(); assert.equal(ready.timers.size, 0); assert.equal(ready.events.size, 0);
  const replaced = boot(); replaced.screen.isConnected = false; replaced.timers.get(1)(); assert.equal(replaced.screen.innerHTML, 'Opening your library…');
  const hls = boot(); hls.events.get('error')({ target: { tagName: 'SCRIPT', src: 'http://watch.local/vendor/hls.js' } });
  assert.equal(hls.nodes.button.onclick, undefined); assert.equal(hls.timers.size, 1);
});
