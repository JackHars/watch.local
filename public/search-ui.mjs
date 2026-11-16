// Keep the field mounted, show fast local matches, and ignore older responses.
export function createLiveSearch({ request, render, delay = 180, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, controller, generation = 0, current = [], stopped = false;
  const cache = new Map();
  const remember = (key, items) => {
    if (!items.length) return;
    cache.delete(key); cache.set(key, items);
    if (cache.size > 30) cache.delete(cache.keys().next().value);
  };
  function update(value, immediate = false) {
    cancel(timer); controller?.abort();
    const id = ++generation, query = value.trim().slice(0, 200), key = query.toLowerCase();
    if (stopped) return;
    if (!query) { current = []; render({ query, items: [], loading: false }); return; }
    if (cache.has(key)) { current = cache.get(key); render({ query, items: current, loading: false }); return; }
    controller = new AbortController();
    const signal = controller.signal;
    let final = false, preview = [], fullFailed = false;
    const active = () => !stopped && id === generation;
    const show = (items, loading, error = '') => { current = items; render({ query, items, loading, error }); };
    show(current, true);
    request('search/suggest?q=' + encodeURIComponent(query), { signal, timeoutMs: 3000 }).then(data => {
      if (!active() || (final && current.length)) return;
      preview = data.items || [];
      if (final) remember(key, preview);
      show(preview, !final && query.length > 1 && !fullFailed, fullFailed ? 'Showing available matches. Broader search is temporarily unavailable.' : '');
    }).catch(() => { if (active() && !final && query.length === 1) show([], false, 'Search is unavailable. Try again.'); });
    if (query.length === 1) return;
    const run = async () => {
      try {
        const data = await request('browse?q=' + encodeURIComponent(query), { signal, timeoutMs: 20000 });
        if (!active()) return;
        final = true;
        // Keep valid local matches if an upstream search returns an empty list.
        const items = data.items?.length ? data.items : preview;
        remember(key, items); show(items, false);
      } catch (error) {
        if (!active() || signal.aborted) return;
        fullFailed = true;
        show(preview, false, preview.length ? 'Showing available matches. Broader search is temporarily unavailable.' : 'Search is temporarily unavailable. Try again.');
      }
    };
    if (immediate) run(); else timer = schedule(run, delay);
  }
  return {
    update,
    pause() { cancel(timer); controller?.abort(); ++generation; },
    stop() { stopped = true; cancel(timer); controller?.abort(); ++generation; cache.clear(); },
  };
}
