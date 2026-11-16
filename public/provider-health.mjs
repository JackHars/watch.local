const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function healthCheckMarkup(providers, enabled) {
  return `<div class="health-intro"><div><p class="health-eyebrow">Provider diagnostics</p><h3>Breaking Bad <span>· Season 1, Episode 1</span></h3><p>Each enabled source is checked independently. A preview appears when the first video frame loads.</p></div><div class="health-intro-actions"><button class="btn ghost small" id="health-play-all" type="button" disabled>Play all previews</button><button class="btn ghost small" id="health-run" type="button">Test all again</button></div></div><p class="health-summary" id="health-summary" role="status" aria-live="polite">Preparing checks…</p><div class="health-grid">${providers.map(({ id, name }) => `<article class="health-tile" data-health-provider="${escape(id)}" data-state="${enabled.includes(id) ? 'waiting' : 'disabled'}"><div class="health-screen"><video muted playsinline preload="none" aria-label="${escape(name)} preview"></video><span class="health-placeholder" aria-hidden="true">${escape(name.slice(0, 1))}</span></div><div class="health-tile-body"><div class="health-tile-heading"><strong>${escape(name)}</strong><span class="health-state">${enabled.includes(id) ? 'Waiting' : 'Disabled'}</span></div><p class="health-detail">${enabled.includes(id) ? 'Waiting to check this source.' : 'Turn on this provider to test it.'}</p><div class="health-tile-actions"><button type="button" class="health-preview" hidden>Play preview</button><button type="button" class="health-retry" ${enabled.includes(id) ? '' : 'hidden'}>Retry</button></div></div></article>`).join('')}</div>`;
}

// Stop after the first decoded frame. Keeping 20+ streams playing would turn
// the health check itself into a false failure on small servers and phones.
export function mountHealthCheck(root, { providers, enabled, api, Hls }) {
  const cards = new Map([...root.querySelectorAll('[data-health-provider]')].map(card => [card.dataset.healthProvider, card]));
  const active = new Map(), engines = new Map();
  let generation = 0, stopped = false, playAll = false;
  const summary = root.querySelector('#health-summary');
  const allButton = root.querySelector('#health-play-all');
  const updateSummary = () => {
    const counts = { checking: 0, waiting: 0, playable: 0, failed: 0, disabled: 0 };
    for (const card of cards.values()) counts[card.dataset.state]++;
    summary.textContent = `${counts.playable} playable · ${counts.failed} failed · ${counts.checking + counts.waiting} remaining${counts.disabled ? ` · ${counts.disabled} disabled` : ''}`;
    allButton.disabled = counts.playable === 0;
    allButton.textContent = playAll ? 'Pause all previews' : 'Play all previews';
  };
  const setState = (card, state, detail) => {
    if (stopped || !card.isConnected) return;
    card.dataset.state = state;
    card.querySelector('.health-state').textContent = { waiting: 'Waiting', checking: 'Checking', playable: 'Playable', failed: 'Failed', disabled: 'Disabled' }[state];
    card.querySelector('.health-detail').textContent = detail;
    card.querySelector('.health-preview').hidden = state !== 'playable';
    card.querySelector('.health-retry').hidden = state === 'disabled' || state === 'checking';
    updateSummary();
  };
  const dispose = () => {
    generation++;
    for (const controller of active.values()) controller.abort();
    active.clear();
    for (const engine of engines.values()) engine.destroy();
    engines.clear();
    for (const card of cards.values()) {
      const video = card.querySelector('video');
      video.pause(); video.removeAttribute('src'); video.load();
      card.querySelector('.health-preview').textContent = 'Play preview';
    }
  };
  const movePreview = (id, playing) => {
    const card = cards.get(id), video = card?.querySelector('video');
    if (!video || card.dataset.state !== 'playable') return;
    const button = card.querySelector('.health-preview');
    if (playing) {
      engines.get(id)?.startLoad();
      video.play().then(() => { button.textContent = 'Pause preview'; }).catch(() => {
        button.textContent = 'Play preview';
        setState(card, 'playable', 'Frame loaded. Tap to start this preview.');
      });
    } else { video.pause(); engines.get(id)?.stopLoad(); button.textContent = 'Play preview'; }
  };
  const check = async (id, run) => {
    const card = cards.get(id);
    if (!card || stopped || run !== generation) return;
    const video = card.querySelector('video');
    setState(card, 'checking', 'Finding and testing video…');
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const result = await api('health-check/play', { method: 'POST', body: { provider: id }, signal: controller.signal });
      if (stopped || run !== generation) return;
      if (result.provider !== id) throw Error('A different provider answered the check.');
      setState(card, 'checking', 'Loading the first frame…');
      await new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', mediaError);
          controller.signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const ready = () => finish();
        const mediaError = () => finish(Error('The video could not be decoded.'));
        const aborted = () => finish(Error('Check cancelled.'));
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('error', mediaError, { once: true });
        controller.signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(Error('The video did not load within 35 seconds.')), 35000);
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = result.url;
          video.play().catch(error => finish(Error(error.name === 'NotAllowedError' ? 'The browser blocked muted preview playback.' : 'The video could not start.')));
        } else if (Hls?.isSupported()) {
          const engine = new Hls({ maxBufferLength: 5, backBufferLength: 0, manifestLoadingTimeOut: 30000 });
          engines.set(id, engine);
          engine.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => finish(Error('The video could not start.'))));
          engine.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) finish(Error(data.details || 'Stream playback failed.')); });
          engine.loadSource(result.url);
          engine.attachMedia(video);
        } else finish(Error('This browser cannot play HLS previews.'));
      });
      if (stopped || run !== generation) return;
      video.pause(); engines.get(id)?.stopLoad();
      setState(card, 'playable', 'First video frame loaded.');
      if (playAll) movePreview(id, true);
    } catch (error) {
      if (stopped || run !== generation) return;
      engines.get(id)?.destroy(); engines.delete(id);
      video.pause(); video.removeAttribute('src'); video.load();
      setState(card, 'failed', error.message || 'No playable video.');
    } finally {
      if (active.get(id) === controller) active.delete(id);
    }
  };
  const runAll = () => {
    playAll = false;
    dispose();
    const run = generation, queue = providers.filter(provider => enabled.includes(provider.id)).map(provider => provider.id);
    for (const id of queue) setState(cards.get(id), 'waiting', 'Waiting to check this source.');
    updateSummary();
    let next = 0;
    for (let worker = 0; worker < Math.min(3, queue.length); worker++) {
      (async () => { while (!stopped && run === generation && next < queue.length) await check(queue[next++], run); })();
    }
  };
  root.querySelector('#health-run').onclick = runAll;
  allButton.onclick = () => {
    playAll = !playAll;
    for (const [id, card] of cards) if (card.dataset.state === 'playable') movePreview(id, playAll);
    updateSummary();
  };
  root.addEventListener('click', event => {
    const card = event.target.closest('[data-health-provider]');
    if (!card) return;
    const id = card.dataset.healthProvider;
    if (event.target.closest('.health-retry')) {
      engines.get(id)?.destroy(); engines.delete(id);
      const video = card.querySelector('video'); video.pause(); video.removeAttribute('src'); video.load();
      check(id, generation);
    }
    if (event.target.closest('.health-preview')) {
      movePreview(id, card.querySelector('video').paused);
    }
  });
  runAll();
  return () => { stopped = true; dispose(); };
}
