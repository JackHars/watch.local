// Track the media timeline, not downloaded HLS segments (which run ahead).
export function trackPlayback(video, { item, progress, onError = () => {} }) {
  if (!['movie', 'tv'].includes(item.type)) return null;
  const playbackId = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  let sequence = 0, started = false, stopped = false, lastAttempt = -Infinity, lastSnapshot = '', warned = false;
  let loadingProgress = typeof progress?.then === 'function', progressFailed = false;
  let resumeAt = !loadingProgress && progress && !progress.completed ? progress.position : 0;
  const requests = new Set(), listeners = [];
  const listen = (target, name, callback) => {
    target.addEventListener(name, callback);
    listeners.push(() => target.removeEventListener(name, callback));
  };
  function resume() {
    if (!resumeAt || !Number.isFinite(video.duration) || video.duration <= 0 || video.readyState < 1) return;
    const target = Math.min(resumeAt, Math.max(0, video.duration - 1));
    try {
      video.currentTime = target;
      if (Math.abs(video.currentTime - target) < 1) resumeAt = 0;
    } catch { /* Native HLS may not expose its seekable timeline yet. */ }
  }
  function save(force = false) {
    if (stopped || loadingProgress || progressFailed || !started || resumeAt || (!force && video.seeking) || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const position = Math.round(video.currentTime * 1000) / 1000, duration = Math.round(video.duration * 1000) / 1000;
    if (!Number.isFinite(position) || position < 0) return;
    const snapshot = `${position}:${duration}:${video.ended}`;
    if (snapshot === lastSnapshot || (!force && performance.now() - lastAttempt < 10000)) return;
    lastSnapshot = snapshot; lastAttempt = performance.now();
    const request = fetch('/ui/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ ...item, position, duration, ended: video.ended, playbackId, sequence: ++sequence }),
      signal: AbortSignal.timeout(8000),
    }).then(async response => {
      if (!response.ok) throw Error('Progress could not be saved.');
      warned = false;
    }).catch(() => {
      if (lastSnapshot === snapshot) lastSnapshot = '';
      if (!warned) { warned = true; onError('Could not save your place. Check the server connection.'); }
    }).finally(() => requests.delete(request));
    requests.add(request);
  }
  for (const event of ['loadedmetadata', 'durationchange', 'canplay']) listen(video, event, resume);
  listen(video, 'playing', () => { resume(); started = true; save(); });
  listen(video, 'timeupdate', () => save());
  for (const event of ['pause', 'seeked', 'ended']) listen(video, event, () => save(true));
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });
  listen(window, 'pagehide', () => save(true));
  if (loadingProgress) Promise.resolve(progress).then(saved => {
    if (stopped || !loadingProgress) return;
    loadingProgress = false;
    resumeAt = saved && !saved.completed ? saved.position : 0;
    resume();
    save();
  }, () => {
    if (stopped || !loadingProgress) return;
    loadingProgress = false; progressFailed = true;
    onError('Your saved place could not be loaded. Try again to resume.');
  });
  return {
    restart() { loadingProgress = false; progressFailed = false; resumeAt = 0; video.currentTime = 0; started = true; save(true); },
    stop() {
      save(true); stopped = true;
      listeners.forEach(remove => remove());
      return Promise.allSettled([...requests]);
    },
  };
}
