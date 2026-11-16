import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSearch } from '../public/search-ui.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [], views = [], timers = new Map(); let next = 0;
  const search = createLiveSearch({
    request: (path, options) => new Promise((resolve, reject) => requests.push({ path, ...options, resolve, reject })),
    render: view => views.push(view), schedule: callback => { timers.set(++next, callback); return next; }, cancel: id => timers.delete(id),
  });
  return { search, requests, views, run() { for (const callback of timers.values()) callback(); timers.clear(); } };
}
test('typing shows local matches before the full search and cancels stale results', async () => {
  const f = fixture();
  f.search.update('vi'); f.run();
  f.requests[0].resolve({ items: [{ id: 1 }] }); await tick();
  assert.deepEqual(f.views.at(-1).items, [{ id: 1 }]); assert.equal(f.views.at(-1).loading, true);
  f.search.update('vision');
  assert.deepEqual(f.views.at(-1).items, [{ id: 1 }], 'keep visible results during typing');
  assert.equal(f.requests[1].signal.aborted, true);
  f.run(); f.requests[3].resolve({ items: [{ id: 3 }] }); await tick();
  f.requests[2].resolve({ items: [{ id: 2 }] }); f.requests[1].resolve({ items: [{ id: 99 }] }); await tick();
  assert.deepEqual(f.views.at(-1).items, [{ id: 3 }], 'neither a late preview nor old full query may replace the final results');
  f.search.update(''); assert.deepEqual(f.views.at(-1).items, []);
  f.search.update('vision'); assert.equal(f.requests.length, 4); assert.deepEqual(f.views.at(-1).items, [{ id: 3 }]);
  f.search.stop();
});
test('one letter uses local matches only and a stopped search cannot update the page', async () => {
  const f = fixture(); f.search.update('v'); f.run();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ items: [{ id: 1 }] }); await tick();
  assert.equal(f.views.at(-1).loading, false);
  f.search.update('vis'); f.search.pause(); f.run();
  assert.equal(f.requests.length, 2);
  f.search.update('vision'); f.run(); f.search.stop();
  const count = f.views.length;
  f.requests.at(-1).resolve({ items: [{ id: 4 }] }); await tick();
  assert.equal(f.views.length, count);
});
test('outages and empty upstream results retain useful local matches, even if the preview arrives last', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); f.search.update('vision', true);
    if (fail) f.requests[1].reject(Error('offline')); else f.requests[1].resolve({ items: [] });
    await tick(); f.requests[0].resolve({ items: [{ id: 1 }] }); await tick();
    assert.deepEqual(f.views.at(-1).items, [{ id: 1 }]); assert.equal(f.views.at(-1).loading, false);
    f.search.stop();
  }
});
