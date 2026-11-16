const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function healthCheckMarkup(providers, enabled) {
  return `<div class="health-intro"><div><p class="health-eyebrow">Provider diagnostics</p><h3>Breaking Bad <span>· Season 1, Episode 1</span></h3><p>Each source is checked independently. A decoded frame stays visible without keeping every video player running. Some sources use unsupported codecs or serve a short error clip instead of the episode.</p></div><div class="health-intro-actions"><button class="btn ghost small" id="health-run" type="button">Test all again</button></div></div><p class="health-summary" id="health-summary" role="status" aria-live="polite">Preparing checks…</p><div class="health-grid">${providers.map(({ id, name }) => `<article class="health-tile" data-health-provider="${escape(id)}" data-state="${enabled.includes(id) ? 'waiting' : 'disabled'}"><div class="health-screen"><video muted playsinline preload="none" aria-label="${escape(name)} preview"></video><canvas class="health-snapshot" width="640" height="360" aria-hidden="true" hidden></canvas><span class="health-placeholder" aria-hidden="true">${escape(name.slice(0, 1))}</span></div><div class="health-tile-body"><div class="health-tile-heading"><strong>${escape(name)}</strong><span class="health-state">${enabled.includes(id) ? 'Waiting' : 'Disabled'}</span></div><p class="health-detail">${enabled.includes(id) ? 'Waiting to check this source.' : 'Turn on this provider to test it.'}</p><div class="health-tile-actions"><button type="button" class="health-preview" hidden>Play preview</button><button type="button" class="health-retry" ${enabled.includes(id) ? '' : 'hidden'}>Retry</button></div></div></article>`).join('')}</div>`;
}

export const suspiciousHealthDuration = seconds => Number.isFinite(seconds) && seconds > 0 && seconds < 600;

export function healthPlayerMode(video, Hls, vendor = '') {
  const supported = Boolean(Hls?.isSupported?.());
  if (supported && !/Apple Computer/i.test(vendor)) return 'hlsjs';
  if (video.canPlayType('application/vnd.apple.mpegurl')) return 'native';
  return supported ? 'hlsjs' : 'unsupported';
}

export function healthFailureState(sourceFound, error) {
  if (!sourceFound) return 'failed';
  return error?.healthCode === 'unsupported' ? 'unsupported' : 'preview-failed';
}

// Capture one frame and release the decoder. Even paused MSE players hold
// buffers; keeping 20+ attached can crash Chrome during a full health check.
export function mountHealthCheck(root, { providers, enabled, api, Hls }) {
  const cards = new Map([...root.querySelectorAll('[data-health-provider]')].map(card => [card.dataset.healthProvider, card]));
  const active = new Map(), engines = new Map(), sourceURLs = new Map();
  let generation = 0, stopped = false, previewId = null;
  const summary = root.querySelector('#health-summary');
  const updateSummary = () => {
    const counts = { checking: 0, waiting: 0, playable: 0, failed: 0, 'preview-failed': 0, unsupported: 0, 'short-stream': 0, disabled: 0 };
    for (const card of cards.values()) counts[card.dataset.state]++;
    summary.textContent = `${counts.playable} video loaded · ${counts['short-stream']} short clips · ${counts['preview-failed']} preview failed · ${counts.unsupported} unsupported here · ${counts.failed} no source · ${counts.checking + counts.waiting} remaining${counts.disabled ? ` · ${counts.disabled} disabled` : ''}`;
  };
  const setState = (card, state, detail) => {
    if (stopped || !card.isConnected) return;
    card.dataset.state = state;
    card.querySelector('.health-state').textContent = { waiting: 'Waiting', checking: 'Checking', playable: 'Video loaded', failed: 'No source', 'preview-failed': 'Preview failed', unsupported: 'Unsupported here', 'short-stream': 'Short clip', disabled: 'Disabled' }[state];
    card.querySelector('.health-detail').textContent = detail;
    card.querySelector('.health-preview').hidden = state !== 'playable' && state !== 'short-stream';
    card.querySelector('.health-retry').hidden = state === 'disabled' || state === 'checking' || state === 'waiting';
    updateSummary();
  };
  const releaseMedia = id => {
    const card = cards.get(id), video = card?.querySelector('video');
    engines.get(id)?.destroy(); engines.delete(id);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (card) { delete card.dataset.previewing; card.querySelector('.health-preview').textContent = 'Play preview'; }
    if (previewId === id) previewId = null;
  };
  const dispose = () => {
    generation++;
    for (const controller of active.values()) controller.abort();
    active.clear(); sourceURLs.clear();
    for (const [id, card] of cards) {
      releaseMedia(id);
      card.querySelector('canvas').hidden = true;
    }
  };
  const movePreview = (id, playing) => {
    const card = cards.get(id), video = card?.querySelector('video');
    if (!video || !['playable', 'short-stream'].includes(card.dataset.state)) return;
    if (!playing) return releaseMedia(id);
    if (previewId) releaseMedia(previewId);
    const url = sourceURLs.get(id), button = card.querySelector('.health-preview');
    if (!url) return;
    previewId = id; card.dataset.previewing = 'true'; button.textContent = 'Loading preview…';
    const fail = message => {
      if (previewId !== id) return;
      releaseMedia(id);
      setState(card, 'preview-failed', message);
    };
    const start = () => video.play().then(() => { if (previewId === id) button.textContent = 'Pause preview'; })
      .catch(error => fail(error.name === 'NotAllowedError' ? 'The browser blocked playback.' : 'Preview could not start. Retry this source.'));
    const mode = healthPlayerMode(video, Hls, navigator.vendor);
    if (mode === 'native') { video.src = url; start(); }
    else if (mode === 'hlsjs') {
      const engine = new Hls({ maxBufferLength: 5, backBufferLength: 0 });
      engines.set(id, engine);
      engine.on(Hls.Events.MANIFEST_PARSED, start);
      engine.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) fail(data.details || 'Preview stopped.'); });
      engine.loadSource(url); engine.attachMedia(video);
    } else fail('This browser cannot play HLS previews.');
  };
  const check = async (id, run) => {
    const card = cards.get(id);
    if (!card || stopped || run !== generation) return;
    const video = card.querySelector('video');
    let sourceFound = false;
    setState(card, 'checking', 'Finding and testing video…');
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const result = await api('health-check/play', { method: 'POST', body: { provider: id }, signal: controller.signal });
      if (stopped || run !== generation) return;
      if (result.provider !== id) throw Error('A different provider answered the check.');
      sourceFound = true;
      setState(card, 'checking', 'Loading the first frame…');
      await new Promise((resolve, reject) => {
        let timer, settled = false, hlsError = '';
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', mediaError);
          controller.signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const ready = () => finish();
        const mediaError = () => setTimeout(() => finish(Error(hlsError || 'The video could not be decoded.')), 100);
        const aborted = () => finish(Error('Check cancelled.'));
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('error', mediaError, { once: true });
        controller.signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(Error('The video did not load within 50 seconds.')), 50000);
        const mode = healthPlayerMode(video, Hls, navigator.vendor);
        if (mode === 'native') {
          video.src = result.url;
          video.play().catch(error => finish(Error(error.name === 'NotAllowedError' ? 'The browser blocked muted preview playback.' : 'The video could not start.')));
        } else if (mode === 'hlsjs') {
          const engine = new Hls({ maxBufferLength: 2, maxMaxBufferLength: 5, backBufferLength: 0, manifestLoadingTimeOut: 30000 });
          engines.set(id, engine);
          engine.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(error => {
            if (error.name === 'NotAllowedError') finish(Error('The browser blocked muted preview playback.'));
            // A segment or codec failure often rejects play() before Hls.js
            // reports the useful error. Let that event explain the failure.
          }));
          engine.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            hlsError = `${data.details || 'Stream playback failed.'}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`;
            const error = Error(hlsError === 'manifestIncompatibleCodecsError' ? 'This stream uses a codec this browser cannot play.' : hlsError);
            if (hlsError === 'manifestIncompatibleCodecsError') error.healthCode = 'unsupported';
            finish(error);
          });
          engine.loadSource(result.url);
          engine.attachMedia(video);
        } else finish(Error('This browser cannot play HLS previews.'));
      });
      if (stopped || run !== generation) return;
      const seconds = video.duration;
      const canvas = card.querySelector('canvas');
      try { canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height); canvas.hidden = false; }
      catch { canvas.hidden = true; }
      sourceURLs.set(id, result.url);
      releaseMedia(id);
      if (suspiciousHealthDuration(seconds)) setState(card, 'short-stream', `Only ${Math.round(seconds / 60)} minute${seconds >= 90 ? 's' : ''} of video; expected a full episode. This may be an error clip.`);
      else setState(card, 'playable', 'First video frame loaded. Check it for provider error screens.');
    } catch (error) {
      if (stopped || run !== generation) return;
      releaseMedia(id);
      setState(card, healthFailureState(sourceFound, error), error.message || 'No playable video.');
    } finally {
      if (active.get(id) === controller) active.delete(id);
    }
  };
  const runAll = () => {
    dispose();
    const run = generation, queue = providers.filter(provider => enabled.includes(provider.id)).map(provider => provider.id);
    for (const id of queue) setState(cards.get(id), 'waiting', 'Waiting to check this source.');
    updateSummary();
    let next = 0;
    for (let worker = 0; worker < Math.min(2, queue.length); worker++) {
      (async () => { while (!stopped && run === generation && next < queue.length) await check(queue[next++], run); })();
    }
  };
  root.querySelector('#health-run').onclick = runAll;
  root.addEventListener('click', event => {
    const card = event.target.closest('[data-health-provider]');
    if (!card) return;
    const id = card.dataset.healthProvider;
    if (event.target.closest('.health-retry')) {
      releaseMedia(id); sourceURLs.delete(id); card.querySelector('canvas').hidden = true;
      check(id, generation);
    }
    if (event.target.closest('.health-preview')) {
      movePreview(id, card.dataset.previewing !== 'true');
    }
  });
  runAll();
  return () => { stopped = true; dispose(); };
}
