import { getCatalogData } from './platform.mjs';
import { requestTMDB, tmdbConfigured } from './tmdb.mjs';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const seasonNumber = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const safeTvMazeUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.tvmaze.com' ? url.href : null; }
  catch { return null; }
};

export function summarizeUpcoming({ tmdb, maze, seasons = [], episodes = [], today = new Date().toISOString().slice(0, 10), tmdbId } = {}) {
  const allSeasons = new Map();
  for (const item of tmdb?.seasons || []) {
    const number = seasonNumber(item.season_number);
    if (number) allSeasons.set(number, { number, date: validDate(item.air_date) ? item.air_date : null, count: item.episode_count || 0, source: 'TMDB' });
  }
  for (const item of seasons) {
    const number = seasonNumber(item.number);
    if (!number) continue;
    const previous = allSeasons.get(number);
    const mazeDate = validDate(item.premiereDate) ? item.premiereDate : null;
    allSeasons.set(number, { number, date: mazeDate || previous?.date || null, count: item.episodeOrder ?? previous?.count ?? 0, source: mazeDate || !previous?.date ? 'TVMaze' : previous.source });
  }
  const tmdbNext = tmdb?.next_episode_to_air;
  const scheduledEpisodes = [...episodes.map(item => ({ ...item, source: 'TVMaze' })), ...(tmdbNext ? [{ season: tmdbNext.season_number, number: tmdbNext.episode_number, name: tmdbNext.name, airdate: tmdbNext.air_date, source: 'TMDB' }] : [])];
  const airedEpisodes = scheduledEpisodes.filter(item => seasonNumber(item.season) && validDate(item.airdate) && item.airdate <= today);
  const airedSeasons = [...allSeasons.values()].filter(item => item.date && item.date <= today && item.count > 0).map(item => item.number);
  const latestAired = Math.max(0, ...airedSeasons, ...airedEpisodes.map(item => item.season));
  const upcomingSeasons = [...allSeasons.values()].filter(item => item.number > latestAired && (!item.date || item.date > today)).sort((a, b) => a.number - b.number);
  const season = upcomingSeasons[0] || null;
  const nextEpisode = scheduledEpisodes.filter(item => seasonNumber(item.season) && validDate(item.airdate) && item.airdate > today)
    .sort((a, b) => a.airdate.localeCompare(b.airdate) || a.season - b.season || (a.number || 0) - (b.number || 0))[0];
  if (!season && !nextEpisode) return { season: null, nextEpisode: null };
  const source = season?.source || nextEpisode?.source || 'TMDB';
  return {
    season: season && { number: season.number, premiereDate: season.date || (nextEpisode?.season === season.number ? nextEpisode.airdate : null) },
    nextEpisode: nextEpisode ? { season: nextEpisode.season, number: nextEpisode.number || null, name: nextEpisode.name || null, airDate: nextEpisode.airdate } : null,
    source,
    sourceUrl: source === 'TVMaze' ? safeTvMazeUrl(maze?.url) : `https://www.themoviedb.org/tv/${tmdbId}`,
  };
}

export function createUpcomingService({ catalog = getCatalogData, tmdbRequest = requestTMDB, configured = tmdbConfigured, fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function mazeJSON(path) {
    const response = await fetcher(`https://api.tvmaze.com${path}`, { headers: { accept: 'application/json', 'user-agent': 'watch.local' }, signal: AbortSignal.timeout(6500), redirect: 'follow' });
    if (!response.ok) throw Error(`TVMaze HTTP ${response.status}`);
    return response.json();
  }
  async function load(id) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const [tmdbResult, idsResult] = await Promise.allSettled([
        configured() ? tmdbRequest(`/tv/${id}`, { append_to_response: 'external_ids' }, { signal: controller.signal }) : Promise.resolve(null),
        catalog(`/tv/${id}/external_ids`, {}, controller.signal),
      ]);
      const tmdb = tmdbResult.status === 'fulfilled' ? tmdbResult.value : null;
      const ids = idsResult.status === 'fulfilled' ? idsResult.value : null;
      const imdb = tmdb?.external_ids?.imdb_id || ids?.imdb_id;
      let maze = null, seasons = [], episodes = [];
      if (/^tt\d+$/.test(imdb || '')) {
        try {
          maze = await mazeJSON(`/lookup/shows?imdb=${imdb}`);
          if (Number.isSafeInteger(maze?.id) && maze.id > 0) {
            const results = await Promise.allSettled([mazeJSON(`/shows/${maze.id}/seasons`), mazeJSON(`/shows/${maze.id}/episodes`)]);
            seasons = results[0].status === 'fulfilled' && Array.isArray(results[0].value) ? results[0].value : [];
            episodes = results[1].status === 'fulfilled' && Array.isArray(results[1].value) ? results[1].value : [];
          }
        } catch { /* The TMDB season list can still supply a forecast. */ }
      }
      if (!tmdb && !maze) return { season: null, nextEpisode: null };
      return summarizeUpcoming({ tmdb, maze, seasons, episodes, tmdbId: id, today: new Date(now()).toISOString().slice(0, 10) });
    } finally { clearTimeout(timeout); }
  }
  return async function upcoming(id) {
    const key = String(id), saved = cache.get(key), time = now();
    if (saved && saved.expires > time) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const work = load(key).then(value => {
      cache.set(key, { value, expires: now() + (value.season || value.nextEpisode ? 6 : 1) * 3600000 });
      while (cache.size > 200) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

export const upcomingForShow = createUpcomingService();
