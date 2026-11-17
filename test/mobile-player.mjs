import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobilePlaybackDevice, mobilePlaybackError, mobilePlayer } from '../public/mobile-player.mjs';

function fixture() {
  const calls = [], doc = new EventTarget(), video = new EventTarget();
  Object.assign(video, { playsInline: true, controls: false, removeAttribute: name => calls.push(['remove', name]),
    play: () => { calls.push(['play', video.src]); return Promise.resolve(); },
    webkitEnterFullscreen: () => { calls.push(['native-fullscreen']); },
  });
  return { video, doc, calls, event: (target, name) => target.dispatchEvent(new Event(name)) };
}

test('native playback reports the server reason and handles offline or unsupported media errors', async () => {
  const url = '/ui/playback.m3u8?requestId=fixture', controller = new AbortController();
  const message = await mobilePlaybackError(url, { signal: controller.signal, fetchResource: async (source, options) => {
    assert.equal(source, url); assert.equal(options.headers.Accept, 'application/json'); assert.equal(options.signal, controller.signal);
    return Response.json({ error: 'This sports event has ended.' }, { status: 410 });
  } });
  assert.equal(message, 'This sports event has ended.');
  for (const fetchResource of [async () => { throw Error('Offline'); }, async () => new Response('Not JSON', { status: 502 }), async () => Response.json({ ready: true })]) {
    assert.match(await mobilePlaybackError(url, { fetchResource }), /Try again/);
  }
});

test('mobile devices use fullscreen while desktop and touch laptops keep the desktop player', () => {
  for (const userAgent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPad', 'Android Mobile']) assert.equal(mobilePlaybackDevice({ userAgent }), true);
  assert.equal(mobilePlaybackDevice({ platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(mobilePlaybackDevice({ userAgentData: { mobile: true } }), true);
  assert.equal(mobilePlaybackDevice({ platform: 'Win32', userAgent: 'Windows NT', maxTouchPoints: 10 }), false);
  assert.equal(mobilePlaybackDevice({ platform: 'MacIntel', maxTouchPoints: 0 }), false);
});

test('source, play and native fullscreen are started synchronously in the original tap', () => {
  const f = fixture(); let exits = 0;
  const player = mobilePlayer(f.video, { document: f.doc, onExit: () => { exits++; } });
  player.start('/ui/playback.m3u8?type=tv&id=10');
  assert.equal(f.video.playsInline, false); assert.equal(f.video.controls, true);
  assert.deepEqual(f.calls, [['remove','playsinline'],['remove','webkit-playsinline'],['play','/ui/playback.m3u8?type=tv&id=10'],['native-fullscreen']]);
  f.event(f.video, 'webkitbeginfullscreen'); f.event(f.video, 'playing');
  assert.equal(f.calls.filter(([name]) => name === 'native-fullscreen').length, 1);
  f.event(f.video, 'webkitendfullscreen'); assert.equal(exits, 1);
  player.stop(); f.event(f.video, 'webkitendfullscreen'); player.start(); assert.equal(exits, 1);
});

test('standard fullscreen is requested during the tap when native entry needs metadata', () => {
  const f = fixture(); let exits = 0;
  f.video.webkitEnterFullscreen = () => { throw new DOMException('No metadata yet', 'InvalidStateError'); };
  f.video.requestFullscreen = () => { f.calls.push(['fullscreen']); f.doc.fullscreenElement = f.video; f.event(f.doc, 'fullscreenchange'); return Promise.resolve(); };
  f.doc.exitFullscreen = () => { f.doc.fullscreenElement = null; f.event(f.doc, 'fullscreenchange'); return Promise.resolve(); };
  const player = mobilePlayer(f.video, { document: f.doc, onExit: () => { exits++; } });
  player.start('/movie.m3u8'); assert.equal(f.doc.fullscreenElement, f.video);
  player.stop(); assert.equal(f.doc.fullscreenElement, null); assert.equal(exits, 0);
});

test('blocked playback provides a retry without muting audio, and PiP does not close playback', async () => {
  const f = fixture(); let blocked = 0, exits = 0;
  f.video.play = () => Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
  const player = mobilePlayer(f.video, { document: f.doc, onBlocked: () => { blocked++; }, onExit: () => { exits++; } });
  player.start('/movie.m3u8'); await Promise.resolve(); assert.equal(blocked, 1); assert.notEqual(f.video.muted, true);
  f.video.webkitPresentationMode = 'picture-in-picture';
  f.event(f.video, 'webkitendfullscreen'); assert.equal(exits, 0);
  player.stop();
});

test('native player keeps the playback session during errors and automatic source replacement', () => {
  const f=fixture();let exits=0;
  const player=mobilePlayer(f.video,{document:f.doc,onExit:()=>exits++});
  player.start('/first.m3u8');f.event(f.video,'webkitbeginfullscreen');
  f.video.error={code:3};f.event(f.video,'webkitendfullscreen');assert.equal(exits,0);
  player.start('/second.m3u8');f.video.error=null;
  f.event(f.video,'webkitendfullscreen');assert.equal(exits,0);
  f.event(f.video,'playing');f.event(f.video,'webkitbeginfullscreen');f.event(f.video,'webkitendfullscreen');assert.equal(exits,1);
  player.stop();
});

test('fullscreen entry notifies the page once and metadata retries a pending native presentation', () => {
  const f=fixture();let entries=0,ready=false;
  f.video.webkitEnterFullscreen=()=>{f.calls.push(['native-fullscreen']);if(!ready)throw new DOMException('Metadata pending','InvalidStateError');f.event(f.video,'webkitbeginfullscreen');};
  const player=mobilePlayer(f.video,{document:f.doc,onEnter:()=>entries++});
  player.start('/episode.m3u8');assert.equal(entries,0);
  ready=true;f.event(f.video,'loadedmetadata');assert.equal(entries,1);
  f.event(f.video,'playing');f.event(f.video,'webkitbeginfullscreen');assert.equal(entries,1);
  player.stop();f.event(f.video,'webkitbeginfullscreen');assert.equal(entries,1);
});

test('silent fullscreen refusal requests a new gesture, while stopping cancels the prompt', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();let blocked=0;
  const player=mobilePlayer(f.video,{document:f.doc,onBlocked:()=>blocked++});
  player.start('/movie.m3u8');f.event(f.video,'playing');
  t.mock.timers.tick(799);assert.equal(blocked,0);
  t.mock.timers.tick(1);assert.equal(blocked,1);
  player.start();f.event(f.video,'playing');player.stop();
  t.mock.timers.tick(1000);assert.equal(blocked,1);
});

test('a rejected play attempt cannot show a stale gesture prompt after a newer attempt or cancellation', async () => {
  const f=fixture();const rejections=[];let blocked=0;
  f.video.play=()=>new Promise((resolve,reject)=>rejections.push(reject));
  const player=mobilePlayer(f.video,{document:f.doc,onBlocked:()=>blocked++});
  player.start('/first.m3u8');player.start('/fallback.m3u8');
  rejections[0](new DOMException('Old request','NotAllowedError'));await Promise.resolve();assert.equal(blocked,0);
  player.stop();rejections[1](new DOMException('Cancelled','NotAllowedError'));await Promise.resolve();assert.equal(blocked,0);
});
