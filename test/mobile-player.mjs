import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobilePlaybackDevice, mobilePlaybackError, mobilePlayer, nativeMobileHls } from '../public/mobile-player.mjs';

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

test('iOS browsers use native HLS for the first tap, including iPad desktop mode', () => {
  const hls = { canPlayType: type => type === 'application/vnd.apple.mpegurl' ? 'probably' : '' };
  assert.equal(nativeMobileHls(hls, { userAgent: 'iPhone; CriOS', vendor: 'Google Inc.' }), true);
  assert.equal(nativeMobileHls(hls, { platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(nativeMobileHls(hls, { userAgent: 'Android Mobile' }), false);
  assert.equal(nativeMobileHls({ canPlayType: () => '' }, { userAgent: 'iPhone' }), false);
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

test('Safari presentation mode opens the native player and a late play denial leaves it visible', async () => {
  const f = fixture(), states = [];
  f.video.webkitEnterFullscreen = () => { throw new DOMException('Not ready', 'InvalidStateError'); };
  f.video.webkitSupportsPresentationMode = mode => mode === 'fullscreen';
  f.video.webkitSetPresentationMode = mode => {
    f.video.webkitPresentationMode = mode;
    f.event(f.video, 'webkitpresentationmodechanged');
  };
  f.video.play = () => Promise.reject(new DOMException('Playback permission required', 'NotAllowedError'));
  const player = mobilePlayer(f.video, { document: f.doc, onEnter: () => states.push('fullscreen'), onShowVideo: () => states.push('viewport') });
  player.start('/live.m3u8'); await Promise.resolve();
  assert.deepEqual(states, ['fullscreen']);
  player.stop(); assert.equal(f.video.webkitPresentationMode, 'inline');
});

test('a browser play denial exposes the native controls and PiP keeps the session open', async () => {
  const f = fixture(); let shown = 0, exits = 0;
  f.video.play = () => Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
  const player = mobilePlayer(f.video, { document: f.doc, onShowVideo: () => { shown++; }, onExit: () => { exits++; } });
  player.start('/movie.m3u8'); await Promise.resolve(); assert.equal(shown, 1); assert.notEqual(f.video.muted, true);
  assert.equal(f.video.controls, true);
  f.event(f.video, 'webkitbeginfullscreen');
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

test('slow presentation keeps the original video playing until WebKit reports fullscreen', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(), states=[];
  const player=mobilePlayer(f.video,{document:f.doc,onShowVideo:()=>states.push('video'),onEnter:()=>states.push('fullscreen'),onExit:()=>states.push('closed')});
  player.start('/live.m3u8');
  t.mock.timers.tick(10000);assert.deepEqual(states, []);
  f.event(f.video,'playing');t.mock.timers.tick(2500);
  assert.deepEqual(states, ['video']);
  f.video.webkitPresentationMode='fullscreen';f.event(f.video,'webkitpresentationmodechanged');
  f.event(f.video,'webkitbeginfullscreen');
  assert.deepEqual(states, ['video','fullscreen']);
  assert.deepEqual(f.calls.filter(([name])=>name==='play'), [['play','/live.m3u8']]);
  f.video.webkitPresentationMode='inline';f.event(f.video,'webkitpresentationmodechanged');
  f.event(f.video,'webkitendfullscreen');assert.deepEqual(states, ['video','fullscreen','closed']);
  player.stop();
});

test('a rejected standard fullscreen request leaves playing video visible', async () => {
  const f=fixture();let shown=0;
  delete f.video.webkitEnterFullscreen;
  f.video.requestFullscreen=()=>Promise.reject(new DOMException('No transient activation','NotAllowedError'));
  const player=mobilePlayer(f.video,{document:f.doc,onShowVideo:()=>shown++});
  player.start('/live.m3u8');f.event(f.video,'playing');await Promise.resolve();
  assert.equal(shown,1);assert.equal(f.calls.filter(([name])=>name==='play').length,1);
  player.stop();
});

test('a rejected play attempt cannot resurface old controls after replacement or cancellation', async () => {
  const f=fixture();const rejections=[];let shown=0;
  f.video.play=()=>new Promise((resolve,reject)=>rejections.push(reject));
  const player=mobilePlayer(f.video,{document:f.doc,onShowVideo:()=>shown++});
  player.start('/first.m3u8');player.start('/fallback.m3u8');
  rejections[0](new DOMException('Old request','NotAllowedError'));await Promise.resolve();assert.equal(shown,0);
  player.stop();rejections[1](new DOMException('Cancelled','NotAllowedError'));await Promise.resolve();assert.equal(shown,0);
});
