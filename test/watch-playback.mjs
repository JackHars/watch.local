import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPlayback } from '../public/watch-progress.mjs';

const item = { profileId: 'original-profile', type: 'tv', id: 1396, season: 2, episode: 3, title: 'A series' };
function fixture() {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, performance: globalThis.performance };
  let clock = 0;
  const document = new EventTarget(), window = new EventTarget(), calls = [];
  document.visibilityState = 'visible';
  const video = Object.assign(new EventTarget(), { readyState: 0, currentTime: 0, duration: NaN, seeking: false, ended: false });
  Object.assign(globalThis, { document, window, performance: { now: () => clock }, fetch: async (url, options) => { calls.push({ url, ...options, payload: JSON.parse(options.body) }); return new Response('{}'); } });
  return { video, document, window, calls, advance: ms => { clock += ms; }, event: (target, name) => target.dispatchEvent(new Event(name)), restore: () => Object.assign(globalThis, previous) };
}

test('resumes before saving, flushes pause/background/close, and removes listeners on teardown', async () => {
  const f = fixture();
  try {
    const tracker = trackPlayback(f.video, { item, progress: { position: 600, completed: false } });
    f.event(f.video, 'timeupdate'); assert.equal(f.calls.length, 0);
    Object.assign(f.video, { duration: 2700, readyState: 1 }); f.event(f.video, 'loadedmetadata');
    assert.equal(f.video.currentTime, 600);
    f.event(f.video, 'playing');
    f.video.currentTime = 660; f.event(f.video, 'pause');
    f.video.currentTime = 670; f.document.visibilityState = 'hidden'; f.event(f.document, 'visibilitychange');
    f.video.currentTime = 680; f.event(f.window, 'pagehide');
    f.video.currentTime = 690; await tracker.stop();
    assert.deepEqual(f.calls.map(call => call.payload.position), [600, 660, 670, 680, 690]);
    assert.deepEqual(f.calls.map(call => call.payload.sequence), [1, 2, 3, 4, 5]);
    assert.ok(f.calls.every(call => call.keepalive && call.payload.episode === 3 && call.payload.profileId === 'original-profile'));
    f.event(f.video, 'pause'); f.event(f.window, 'pagehide');
    assert.equal(f.calls.length, 5);
  } finally { f.restore(); }
});

test('does not record failed playback or live streams; completion and start-over follow the media timeline', async () => {
  const f = fixture();
  try {
    assert.equal(trackPlayback(f.video, { item: { type: 'live' } }), null);
    const failed = trackPlayback(f.video, { item, progress: { position: 600, completed: false } });
    await failed.stop(); assert.equal(f.calls.length, 0);
    const tracker = trackPlayback(f.video, { item, progress: { position: 2700, completed: true } });
    Object.assign(f.video, { duration: 2700, readyState: 1 }); f.event(f.video, 'loadedmetadata');
    assert.equal(f.video.currentTime, 0);
    f.event(f.video, 'playing');
    Object.assign(f.video, { currentTime: 2700, ended: true }); f.event(f.video, 'ended');
    assert.equal(f.calls.at(-1).payload.ended, true);
    f.video.ended = false; tracker.restart();
    assert.equal(f.calls.at(-1).payload.position, 0);
    assert.equal(f.calls.at(-1).payload.ended, false);
    await tracker.stop();
  } finally { f.restore(); }
});

test('saves a heartbeat every ten seconds without writing on every timeupdate', async () => {
  const f = fixture();
  try {
    Object.assign(f.video, { duration: 2700, readyState: 1 });
    const tracker = trackPlayback(f.video, { item });
    f.event(f.video, 'playing');
    for (let second = 1; second <= 21; second++) {
      f.advance(1000); f.video.currentTime = second; f.event(f.video, 'timeupdate');
    }
    assert.deepEqual(f.calls.map(call => call.payload.position), [0, 10, 20]);
    await tracker.stop();
    assert.equal(f.calls.at(-1).payload.position, 21);
  } finally { f.restore(); }
});

test('mobile playback can start before progress arrives without overwriting its saved position', async () => {
  const f = fixture(); let resolveProgress;
  try {
    const progress = new Promise(resolve => { resolveProgress = resolve; });
    const tracker = trackPlayback(f.video, { item, progress });
    Object.assign(f.video, { duration: 2700, readyState: 1, currentTime: 2 });
    f.event(f.video, 'playing'); f.event(f.video, 'pause'); assert.equal(f.calls.length, 0);
    resolveProgress({ position: 600, completed: false }); await Promise.resolve();
    assert.equal(f.video.currentTime, 600); assert.equal(f.calls[0].payload.position, 600);
    f.video.currentTime = 620; await tracker.stop();
    assert.equal(f.calls.at(-1).payload.position, 620);
  } finally { f.restore(); }
});

test('closing or starting over cancels a pending mobile resume, and failed lookups do not erase history', async () => {
  const f = fixture(); let resolveProgress, rejectProgress; const errors = [];
  try {
    Object.assign(f.video, { duration: 2700, readyState: 1 });
    let tracker = trackPlayback(f.video, { item, progress: new Promise(resolve => { resolveProgress = resolve; }) });
    f.event(f.video, 'playing'); await tracker.stop(); resolveProgress({ position: 600 }); await Promise.resolve();
    assert.equal(f.calls.length, 0); assert.equal(f.video.currentTime, 0);
    tracker = trackPlayback(f.video, { item, progress: new Promise(resolve => { resolveProgress = resolve; }) });
    tracker.restart(); resolveProgress({ position: 600 }); await Promise.resolve();
    assert.equal(f.video.currentTime, 0); await tracker.stop();
    const count = f.calls.length;
    tracker = trackPlayback(f.video, { item, progress: new Promise((_, reject) => { rejectProgress = reject; }), onError: message => errors.push(message) });
    f.event(f.video, 'playing'); rejectProgress(Error('offline')); await Promise.resolve();
    f.event(f.video, 'pause'); await tracker.stop(); assert.equal(f.calls.length, count); assert.equal(errors.length, 1);
  } finally { f.restore(); }
});
