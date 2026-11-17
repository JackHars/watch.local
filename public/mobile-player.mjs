export function mobilePlaybackDevice(device = navigator) {
  return Boolean(device.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(device.userAgent || '')
    || (device.platform === 'MacIntel' && device.maxTouchPoints > 1));
}

export async function mobilePlaybackError(source, { fetchResource = fetch, signal } = {}) {
  const fallback = 'This stream could not be played. Try again to find a fresh source.';
  try {
    const response = await fetchResource(source, { headers: { Accept: 'application/json' }, signal });
    const data = await response.json();
    if (!response.ok && typeof data.error === 'string' && data.error.trim()) return data.error.slice(0, 600);
  } catch { /* Preserve a useful message when the server cannot be reached. */ }
  return fallback;
}

// Call start() in the tap handler, before awaiting provider or progress requests.
// iPhone automatically presents videos without playsinline in its native player.
export function mobilePlayer(video, { onEnter = () => {}, onExit = () => {}, onBlocked = () => {}, document: doc = document } = {}) {
  let stopped = false, entered = false, replacing = false, attempt = 0, presentationTimer;
  const listeners = [];
  const listen = (target, event, callback) => {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener(event, callback));
  };
  const exit = () => {
    if (stopped || video.webkitPresentationMode === 'picture-in-picture') return;
    entered = false;
    if (video.error || replacing) return;
    onExit();
  };
  const enter = () => {
    if (stopped || entered) return;
    entered = true; clearTimeout(presentationTimer); onEnter();
  };
  listen(video, 'webkitbeginfullscreen', enter);
  listen(video, 'webkitendfullscreen', exit);
  listen(doc, 'fullscreenchange', () => {
    if (doc.fullscreenElement === video) enter();
    else if (entered) exit();
  });
  video.playsInline = false;
  video.removeAttribute('playsinline');
  video.removeAttribute('webkit-playsinline');
  video.controls = true;
  function fullscreen(reportBlocked = false) {
    if (stopped) return;
    if (doc.fullscreenElement === video || video.webkitDisplayingFullscreen) { enter(); return; }
    const current = attempt;
    const blocked = () => { if (reportBlocked && !stopped && !entered && current === attempt && !video.error) onBlocked(); };
    try {
      if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    } catch { /* iOS may wait for metadata; removing playsinline handles iPhone. */ }
    try { video.requestFullscreen?.()?.catch(blocked); } catch { blocked(); }
  }
  // iPad may require metadata before accepting its native fullscreen request.
  listen(video, 'loadedmetadata', () => { if (!entered) fullscreen(); });
  listen(video, 'playing', () => {
    replacing = false;
    if (entered) return;
    fullscreen(true);
    // Some browsers silently ignore fullscreen. Keep a way to provide another
    // gesture rather than leaving an invisible video playing behind the page.
    clearTimeout(presentationTimer);
    presentationTimer = setTimeout(() => {
      if (stopped || entered || video.error) return;
      if (doc.fullscreenElement === video || video.webkitDisplayingFullscreen) enter();
      else onBlocked();
    }, 800);
  });
  return {
    start(source) {
      if (stopped) return;
      const current = ++attempt;
      clearTimeout(presentationTimer);
      if (source) { replacing = Boolean(video.src); video.src = source; }
      // Both operations run in the original user gesture, even if loading is slow.
      try {
        video.play()?.catch(error => {
          if (!stopped && current === attempt && error.name === 'NotAllowedError') onBlocked();
        });
      } catch { onBlocked(); }
      fullscreen();
    },
    stop() {
      stopped = true;
      clearTimeout(presentationTimer);
      listeners.forEach(remove => remove());
      try {
        if (doc.fullscreenElement === video) doc.exitFullscreen?.()?.catch(() => {});
        else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      } catch { /* The browser may already have dismissed its player. */ }
    },
  };
}
