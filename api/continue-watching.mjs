import { watchIdentity } from './watch-progress.mjs';

// Suggestions are derived from saved history, never written as fake watches.
export function createContinueWatching({ store, catalog, now = Date.now, timeoutMs = 5000 }) {
  const cache = new Map();
  async function nextEpisode(userId, profileId, entry) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const future = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && date > today;
    async function inSeason(season, after = 0) {
      const data = await catalog(`/tv/${entry.id}/season/${season}`);
      const episodes = (data.episodes || []).filter(e => Number.isSafeInteger(e.episode_number) && e.episode_number > after).sort((a, b) => a.episode_number - b.episode_number);
      for (const episode of episodes) {
        // Don't jump past an unaired episode to a later one.
        if (future(episode.air_date)) return { pending: true };
        const identity = watchIdentity({ type: 'tv', id: entry.id, season, episode: episode.episode_number });
        const saved = await store.get(userId, profileId, identity);
        if (saved?.completed) continue;
        if (saved?.position >= 1) return { item: { ...saved, updatedAt: entry.updatedAt } };
        return { item: {
          ...entry, ...identity, position: 0,
          duration: Number.isFinite(episode.runtime) && episode.runtime > 0 ? episode.runtime * 60 : 0,
          completed: false, nextEpisode: true, episodeTitle: episode.name || '',
          backdrop_path: episode.still_path || entry.backdrop_path,
        } };
      }
      return null;
    }
    const current = await inSeason(entry.season, entry.episode);
    if (current) return current.item || null;
    const show = await catalog(`/tv/${entry.id}`);
    const seasons = (show.seasons || []).filter(s => Number.isSafeInteger(s.season_number) && s.season_number > entry.season && s.season_number > 0 && s.episode_count !== 0).sort((a, b) => a.season_number - b.season_number);
    for (const season of seasons) {
      if (future(season.air_date)) return null;
      const result = await inSeason(season.season_number);
      if (result) return result.item || null;
    }
    return null;
  }
  function suggestion(userId, profileId, entry) {
    const key = JSON.stringify([userId, profileId, entry.key, entry.updatedAt]);
    const previous = cache.get(key);
    if (previous && previous.expires > now()) return previous.promise;
    const value = { expires: now() + 5 * 60_000 };
    value.promise = nextEpisode(userId, profileId, entry).catch(() => {
      // A temporary metadata outage must not permanently remove a series.
      if (cache.get(key) === value) cache.delete(key);
      return null;
    });
    cache.set(key, value);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    return value.promise;
  }
  return async (userId, profileId) => {
    const entries = await store.list(userId, profileId, { includeCompletedSeries: true });
    const items = entries.map(entry => entry.completed ? null : entry);
    const pending = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.completed).slice(0, 50);
    if (!pending.length) return items.slice(0, 50);
    let cursor = 0, stopped = false, timer;
    // Bound both catalog concurrency and Home's wait. Unfinished titles remain
    // available even if a provider stalls while looking up the next episode.
    const worker = async () => {
      while (!stopped && cursor < pending.length) {
        const { entry, index } = pending[cursor++];
        items[index] = await suggestion(userId, profileId, entry);
      }
    };
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker)),
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { stopped = true; clearTimeout(timer); }
    return items.filter(Boolean).slice(0, 50);
  };
}
