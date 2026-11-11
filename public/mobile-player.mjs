export function mobilePlaybackDevice(device = navigator) {
  return Boolean(device.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(device.userAgent || '')
    || (device.platform === 'MacIntel' && device.maxTouchPoints > 1));
}

// Call start() in the tap handler, before awaiting provider or progress requests.
// iPhone automatically presents videos without playsinline in its native player.
export function mobilePlayer(video, { onExit = () => {}, onBlocked = () => {}, document: doc = document } = {}) {
  let stopped = false, entered = false;
  const listeners = [];
  const listen = (target, event, callback) => {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener(event, callback));
  };
  const exit = () => {
    if (stopped || video.webkitPresentationMode === 'picture-in-picture') return;
    entered = false;
    onExit();
  };
  listen(video, 'webkitbeginfullscreen', () => { entered = true; });
  listen(video, 'webkitendfullscreen', exit);
  listen(doc, 'fullscreenchange', () => {
    if (doc.fullscreenElement === video) entered = true;
    else if (entered) exit();
  });
  video.playsInline = false;
  video.removeAttribute('playsinline');
  video.removeAttribute('webkit-playsinline');
  video.controls = true;
  function fullscreen() {
    if (stopped || doc.fullscreenElement === video || video.webkitDisplayingFullscreen) return;
    try {
      if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    } catch { /* iOS may wait for metadata; removing playsinline handles iPhone. */ }
    try { video.requestFullscreen?.()?.catch(() => {}); } catch { /* Native controls remain available. */ }
  }
  // iPad may require metadata before accepting its native fullscreen request.
  listen(video, 'playing', () => { if (!entered) fullscreen(); });
  return {
    start(source) {
      if (stopped) return;
      if (source) video.src = source;
      // Both operations run in the original user gesture, even if loading is slow.
      try {
        video.play()?.catch(error => {
          if (!stopped && error.name === 'NotAllowedError') onBlocked();
        });
      } catch { onBlocked(); }
      fullscreen();
    },
    stop() {
      stopped = true;
      listeners.forEach(remove => remove());
      try {
        if (doc.fullscreenElement === video) doc.exitFullscreen?.()?.catch(() => {});
        else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      } catch { /* The browser may already have dismissed its player. */ }
    },
  };
}
