function appleMobile(device) {
  return /iPhone|iPad|iPod/i.test(device.userAgent || '') || (device.platform === 'MacIntel' && device.maxTouchPoints > 1);
}

export function mobilePlaybackDevice(device = navigator) {
  return Boolean(device.userAgentData?.mobile || /Android/i.test(device.userAgent || '') || appleMobile(device));
}

export function nativeMobileHls(video, device = navigator) {
  return appleMobile(device) && Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
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
export function mobilePlayer(video, { onEnter = () => {}, onExit = () => {}, onShowVideo = () => {}, document: doc = document } = {}) {
  let stopped = false, entered = false, replacing = false, attempt = 0;
  const listeners = [];
  const listen = (target, event, callback) => {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener(event, callback));
  };
  const documentFullscreen = () => doc.fullscreenElement || doc.webkitFullscreenElement;
  const inFullscreen = () => documentFullscreen() === video || video.webkitDisplayingFullscreen || video.webkitPresentationMode === 'fullscreen';
  const inPictureInPicture = () => video.webkitPresentationMode === 'picture-in-picture' || doc.pictureInPictureElement === video;
  const exit = () => {
    if (stopped || !entered || inPictureInPicture()) return;
    entered = false;
    if (video.error || replacing) return;
    onExit();
  };
  const enter = () => {
    if (stopped || entered) return;
    entered = true; onEnter();
  };
  const presentationChanged = () => { if (inFullscreen()) enter(); else exit(); };
  listen(video, 'webkitbeginfullscreen', enter);
  listen(video, 'webkitendfullscreen', exit);
  listen(video, 'webkitpresentationmodechanged', presentationChanged);
  listen(doc, 'fullscreenchange', presentationChanged);
  listen(doc, 'webkitfullscreenchange', presentationChanged);
  video.playsInline = false;
  video.removeAttribute('playsinline');
  video.removeAttribute('webkit-playsinline');
  video.controls = true;
  function fullscreen() {
    if (stopped || entered || inPictureInPicture()) return;
    if (inFullscreen()) { enter(); return; }
    try {
      if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    } catch { /* iOS may wait for metadata; removing playsinline handles iPhone. */ }
    try {
      if (video.webkitSupportsPresentationMode?.('fullscreen') && video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode('fullscreen'); return;
      }
    } catch { /* Presentation may still be starting. */ }
    try {
      const request = video.requestFullscreen || video.webkitRequestFullscreen;
      request?.call(video)?.catch(() => {});
    } catch { /* The video can still play in the viewport. */ }
  }
  function showVideo() {
    if (stopped || video.error || inPictureInPicture()) return;
    if (inFullscreen()) enter();
    else if (!entered) onShowVideo();
  }
  listen(video, 'loadedmetadata', fullscreen);
  listen(video, 'playing', () => {
    replacing = false;
    fullscreen();
    // Playback and the native fullscreen transition complete independently.
    // Show the same playing video until the browser takes over.
    showVideo();
  });
  return {
    start(source) {
      if (stopped) return;
      const current = ++attempt;
      if (source) { replacing = Boolean(video.src); video.src = source; }
      // Both operations run in the original user gesture, even if loading is slow.
      const playRejected = error => {
        if (current === attempt && error?.name === 'NotAllowedError') showVideo();
      };
      try {
        video.play()?.catch(playRejected);
      } catch (error) { playRejected(error); }
      fullscreen();
    },
    stop() {
      stopped = true;
      listeners.forEach(remove => remove());
      try {
        const leave = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (documentFullscreen() === video && leave) leave.call(doc)?.catch(() => {});
        else if (inFullscreen() && video.webkitExitFullscreen) video.webkitExitFullscreen();
        else if (video.webkitPresentationMode === 'fullscreen') video.webkitSetPresentationMode?.('inline');
      } catch { /* The browser may already have dismissed its player. */ }
    },
  };
}
