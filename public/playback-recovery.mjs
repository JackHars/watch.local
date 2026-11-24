// One recovery chain per Play action. Never loop back to a source the player
// rejected, and ignore duplicate native/HLS error events during a switch.
export function createPlaybackRecovery({ current, inspect, resolve, replace, beforeSwitch = () => {}, trying = () => {}, failed = () => {}, signal }) {
  let selected = current, busy = false, exhausted = false;
  const excluded = new Set();
  return {
    get busy() { return busy; },
    get current() { return selected; },
    async recover(message) {
      if (busy || exhausted || signal?.aborted) return;
      busy = true; trying();
      try {
        if (!selected) {
          selected = await inspect();
          if (signal?.aborted) return;
          // If the native probe disconnected before it got the redirect, give
          // the player the prepared source once before moving down the list.
          if (selected?.unopenedUrl) {
            beforeSwitch();
            await replace({ ...selected, url: selected.unopenedUrl });
            return;
          }
        }
        if (signal?.aborted) return;
        if (!selected?.provider || excluded.has(selected.provider)) throw Error(message);
        for (const provider of selected.attemptedProviders || []) excluded.add(provider);
        excluded.add(selected.provider);
        beforeSwitch();
        const next = await resolve([...excluded]);
        if (signal?.aborted) return;
        if (!next?.provider || excluded.has(next.provider)) throw Error('No other enabled provider has a playable source for this title right now.');
        selected = next;
        await replace(next);
      } catch (error) {
        if (!signal?.aborted) { exhausted = true; failed(error.message || message); }
      } finally { busy = false; }
    },
  };
}
