import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { settingsStore, dataDirectory, problem } from './settings.mjs';
import { requestTMDB } from './tmdb.mjs';
import { fetchTrendingPanel, fetchPublicIMDb } from './tmdb-public.mjs';
import { collectTopRated } from './top-rated.mjs';

// Public catalog endpoints used by the Vidrift/7Movies web player.
// No embedded API key or direct TMDB request is needed for these sources.
export const catalogSources = ['https://7movies.ac', 'https://7movies.ws'];
const HOUR = 3600000, MAX_ENTRIES = 300, MAX_BYTES = 12 * 1024 * 1024;
const TRENDING_KEY = 'tmdb-public-trending:v1';
// The provider's published genre taxonomy (shared IDs keep existing IPTV lists valid).
const genres = {
  movie: [[28,'Action'],[12,'Adventure'],[16,'Animation'],[35,'Comedy'],[80,'Crime'],[99,'Documentary'],[18,'Drama'],[10751,'Family'],[14,'Fantasy'],[36,'History'],[27,'Horror'],[10402,'Music'],[9648,'Mystery'],[10749,'Romance'],[878,'Science Fiction'],[10770,'TV Movie'],[53,'Thriller'],[10752,'War'],[37,'Western']],
  tv: [[10759,'Action & Adventure'],[16,'Animation'],[35,'Comedy'],[80,'Crime'],[99,'Documentary'],[18,'Drama'],[10751,'Family'],[10762,'Kids'],[9648,'Mystery'],[10763,'News'],[10764,'Reality'],[10765,'Sci-Fi & Fantasy'],[10766,'Soap'],[10767,'Talk'],[10768,'War & Politics'],[37,'Western']],
};
const validID = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const artwork = value => {
  if (typeof value !== 'string') return null;
  if (/^\/[\w./-]+$/.test(value)) return value;
  try { const u = new URL(value); return u.hostname === 'image.tmdb.org' ? u.pathname.replace(/^\/t\/p\/[^/]+/, '') : null; } catch { return null; }
};
function normalizeItem(item, type = item.mediaType || item.media_type) {
  const date = item.release_date || item.first_air_date || item.releaseDate || (item.year ? `${item.year}-01-01` : '');
  return {
    ...item, media_type: type,
    ...(type === 'tv' ? { name: item.name || item.title, first_air_date: date } : { title: item.title || item.name, release_date: date }),
    poster_path: artwork(item.poster_path || item.poster), backdrop_path: artwork(item.backdrop_path || item.backdrop),
    overview: item.overview || item.description || '', vote_average: item.vote_average ?? item.rating ?? 0,
  };
}
function routeKind(path) {
  if (/^\/search\/(multi|movie|tv)$/.test(path)) return 'search';
  if (/^\/trending\/(all|movie|tv)\/day$/.test(path)) return 'trending';
  if (/^\/curated\/(movie|tv)\/top_rated$/.test(path)) return 'curated';
  if (/^\/(movie|tv)\/(popular|top_rated|now_playing|on_the_air)$/.test(path)) return 'list';
  if (/^\/discover\/(movie|tv)$/.test(path)) return 'discover';
  if (/^\/genre\/(movie|tv)\/list$/.test(path)) return 'genres';
  if (/^\/tv\/[1-9]\d*\/season\/\d+$/.test(path)) return 'season';
  if (/^\/(movie|tv)\/[1-9]\d*\/external_ids$/.test(path)) return 'ids';
  if (/^\/(movie|tv)\/[1-9]\d*\/images$/.test(path)) return 'images';
  if (/^\/(movie|tv)\/[1-9]\d*$/.test(path)) return 'detail';
  throw problem(400, 'Unsupported catalog request.');
}
function validate(data, path, kind) {
  const parts = path.split('/');
  const ok = data && typeof data === 'object' && !data.error && data.success !== false && (
    ['search','list','trending','discover'].includes(kind) ? Number.isInteger(data.total_pages) && data.total_pages >= 0 && Array.isArray(data.results) && data.results.every(i => validID(i.id) && (i.title || i.name)) :
    kind === 'season' ? Array.isArray(data.episodes) && data.episodes.every(e => validID(e.id) && validID(e.episode_number) && e.season_number === Number(parts[4])) :
    kind === 'detail' ? Number(data.id) === Number(parts[2]) && (data.title || data.name) && (parts[1] !== 'tv' || Array.isArray(data.seasons)) :
    kind === 'ids' ? (!data.id || Number(data.id) === Number(parts[2])) && /^tt\d+$/.test(data.imdb_id || '') :
    kind === 'genres' ? Array.isArray(data.genres) :
    Array.isArray(data.posters) && Array.isArray(data.backdrops)
  );
  if (!ok) throw problem(502, kind === 'ids' ? 'This source has no IMDb ID for the title.' : 'The catalog source returned incomplete information.');
  return data;
}

export function createMetadataService({ directory, fetcher = (...args) => fetch(...args), getConfig = () => settingsStore.config().metadata, fallback = requestTMDB, sources = catalogSources, now = Date.now, timeoutMs = 8000 } = {}) {
  const cache = new Map(), pending = new Map(), cooldown = new Map();
  let initialization, saveTimer, writes = Promise.resolve();
  function trim() {
    let bytes = 0;
    for (const [key, entry] of [...cache].reverse()) {
      bytes += JSON.stringify(entry).length;
      if (now() - entry.at > 7 * 24 * HOUR || bytes > MAX_BYTES) cache.delete(key);
    }
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }
  function initialize() {
    return initialization ||= (async () => {
      if (!directory) return;
      try {
        const data = JSON.parse(await readFile(join(directory, 'metadata-cache.json'), 'utf8'));
        if (data.version === 1 && Array.isArray(data.entries)) for (const [key, entry] of data.entries) {
          if (typeof key === 'string' && Number.isFinite(entry?.at) && entry?.data) cache.set(key, entry);
        }
        trim();
      } catch (error) { if (error.code !== 'ENOENT') console.warn('Metadata cache could not be read; it will be rebuilt.'); }
    })();
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!directory) return Promise.resolve();
    const body = JSON.stringify({ version: 1, entries: [...cache] });
    const next = writes.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'metadata-cache.json.tmp'), body, { mode: 0o600 });
      await rename(join(directory, 'metadata-cache.json.tmp'), join(directory, 'metadata-cache.json'));
    });
    writes = next.catch(() => console.warn('Metadata cache could not be saved.'));
    return writes;
  }
  function remember(key, data) {
    cache.delete(key); cache.set(key, { at: now(), data }); trim();
    if (directory && !saveTimer) saveTimer = setTimeout(flush, 500).unref();
    return data;
  }
  async function json(origin, endpoint, signal) {
    let response;
    try {
      response = await fetcher(origin + endpoint, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: origin + '/', origin },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const retryMs = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now();
        await response.body?.cancel();
        throw Object.assign(problem(502, `Catalog source HTTP ${response.status}.`), { upstreamStatus: response.status, retryAfterMs: Math.min(60000, Math.max(1000, retryMs || 10000)) });
      }
      return await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(problem(502, error.upstreamStatus ? `Catalog source HTTP ${error.upstreamStatus}.` : 'Could not read the upstream catalog.'), { upstreamStatus: error.upstreamStatus || 503, retryAfterMs: error.retryAfterMs || 10000 });
    }
  }
  async function upstream(origin, path, extra, kind, signal) {
    const parts = path.split('/'), page = Math.min(500, Math.max(1, Math.floor(Number(extra.page) || 1)));
    if (kind === 'search') {
      const data = await json(origin, '/api/search?' + new URLSearchParams({ v: '5', q: String(extra.query || '') }), signal);
      if (!Array.isArray(data.results)) throw problem(502, 'The upstream search response is incomplete.');
      // This endpoint returns one complete result set; it does not paginate.
      const results = data.results.filter(i => ['movie','tv'].includes(i.mediaType || i.media_type)).filter(i => parts[2] === 'multi' || (i.mediaType || i.media_type) === parts[2]).map(i => normalizeItem(i));
      return { page, results: page === 1 ? results : [], total_pages: 1, total_results: results.length };
    }
    if (kind === 'discover') {
      const type = parts[2], date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      const year = String(extra[date + '.gte'] || '').slice(0,4);
      // Use the site's year filter. Its generic proxy ignores date-range parameters.
      const query = new URLSearchParams({ type, page: String(page), ...(year ? { year } : {}) });
      const data = await json(origin, '/api/discover?' + query, signal);
      if (!Array.isArray(data.items) || !Number.isFinite(data.totalPages)) throw problem(502, 'The upstream discovery response is incomplete.');
      return { page, results: data.items.map(i => normalizeItem(i, type)), total_pages: Math.min(500, data.totalPages), total_results: data.totalResults };
    }
    if (kind === 'season') {
      const data = await json(origin, `/api/tv/${parts[2]}/season/${parts[4]}`, signal);
      if (!Array.isArray(data.episodes)) throw problem(502, 'The upstream season response is incomplete.');
      return { ...data, season_number: Number(parts[4]), episodes: data.episodes.map(e => ({ ...e, season_number: Number(parts[4]), show_id: Number(parts[2]) })) };
    }
    if (kind === 'ids') {
      const data = await json(origin, '/api/tmdb?' + new URLSearchParams({ path: `/${parts[1]}/${parts[2]}` }), signal);
      validate(data, `/${parts[1]}/${parts[2]}`, 'detail');
      return { id: Number(parts[2]), imdb_id: data.imdb_id || data.external_ids?.imdb_id || null };
    }
    // Lists, details (including credits), and artwork have TMDB-shaped responses.
    return json(origin, '/api/tmdb?' + new URLSearchParams({ path, ...(kind === 'list' ? { page: String(page) } : {}) }), signal);
  }
  async function publicTrending(path, extra, signal) {
    const saved = cache.get(TRENDING_KEY), fresh = saved && now() - saved.at < HOUR / 4;
    const run = async () => {
      try {
        if (cooldown.get(TRENDING_KEY) > now()) throw problem(502, 'The trending list is temporarily unavailable.');
        const cards = await fetchTrendingPanel({fetcher, signal, timeoutMs});
        const results = new Array(cards.length), previous = new Map((saved?.data.results || []).map(i=>[`${i.media_type}:${i.id}`,i]));
        let next = 0;
        // Fetch artwork/details four at a time, keeping the published ranking.
        await Promise.all(Array.from({length:Math.min(4,cards.length)}, async () => {
          while (next < cards.length) {
            signal?.throwIfAborted();
            const index = next++, card = cards[index];
            try {
              const detail = await request(`/${card.media_type}/${card.id}`, {}, signal);
              results[index] = {...card, ...detail, media_type:card.media_type};
            } catch {
              signal?.throwIfAborted();
              results[index] = previous.get(`${card.media_type}:${card.id}`) || card;
            }
          }
        }));
        signal?.throwIfAborted();
        return remember(TRENDING_KEY, {results});
      } catch {
        signal?.throwIfAborted();
        if (!(cooldown.get(TRENDING_KEY) > now())) cooldown.set(TRENDING_KEY, now() + 60000);
        if (saved && now() - saved.at < 7 * 24 * HOUR) return saved.data;
        throw problem(502, 'The trending list is temporarily unavailable. Try again shortly.');
      }
    };
    let data;
    if (fresh) data = saved.data;
    else if (signal) data = await run();
    else {
      if (!pending.has(TRENDING_KEY)) pending.set(TRENDING_KEY, run().finally(()=>pending.delete(TRENDING_KEY)));
      data = await pending.get(TRENDING_KEY);
    }
    const type = path.split('/')[2], page = Math.max(1, Math.floor(Number(extra.page) || 1));
    const results = data.results.filter(i=>type === 'all' || i.media_type === type);
    // The public homepage has one finite list, not the API's paginated rankings.
    return structuredClone({results:page === 1 ? results : [],page,total_pages:1,total_results:results.length});
  }
  async function curatedTopRated(path, extra, signal) {
    const type = path.split('/')[2], key = `curated-top-rated:v1:${type}`, saved = cache.get(key);
    const ttl = saved?.data.complete === false ? 60000 : HOUR;
    const run = async () => {
      try {
        if (cooldown.get(key) > now()) throw problem(502, 'Top-rated picks are temporarily unavailable.');
        const data = await collectTopRated(type,request,{today:new Date(now()).toISOString().slice(0,10),signal});
        if (!data.results.length) throw problem(502, 'No qualifying top-rated titles are currently available.');
        // Keep a complete ranking stable when an individual candidate page fails.
        if (!data.complete && saved && saved.data.complete !== false && now() - saved.at < 7 * 24 * HOUR) {
          cooldown.set(key,now()+60000);return saved.data;
        }
        return remember(key,data);
      } catch {
        signal?.throwIfAborted();
        if (!(cooldown.get(key) > now())) cooldown.set(key,now()+60000);
        if (saved && now() - saved.at < 7 * 24 * HOUR) return saved.data;
        throw problem(502, 'Top-rated picks are temporarily unavailable. Try again shortly.');
      }
    };
    let data;
    if (saved && now() - saved.at < ttl) data = saved.data;
    else if (signal) data = await run();
    else {
      if (!pending.has(key)) pending.set(key,run().finally(()=>pending.delete(key)));
      data = await pending.get(key);
    }
    const page = Math.max(1,Math.floor(Number(extra.page)||1)), size = 20;
    return structuredClone({results:data.results.slice((page-1)*size,page*size),page,total_pages:Math.ceil(data.results.length/size),total_results:data.results.length});
  }
  async function request(path, extra = {}, signal) {
    const kind = routeKind(path);
    await initialize(); signal?.throwIfAborted();
    if (kind === 'trending') return publicTrending(path, extra, signal);
    if (kind === 'curated') return curatedTopRated(path, extra, signal);
    if (kind === 'genres') return { genres: genres[path.split('/')[2]].map(([id, name]) => ({ id, name })) };
    const config = getConfig() || {};
    const key = JSON.stringify([path, Object.entries(extra).filter(([key]) => key !== 'api_key').sort()]);
    const cached = cache.get(key), ttl = ['detail','season','ids','images'].includes(kind) ? 6 * HOUR : HOUR / 4;
    if (cached && now() - cached.at < ttl) return structuredClone(cached.data);
    const credential = config.tmdbFallback && config.tmdbCredential;
    const fallbackKey = credential ? 'tmdb:' + createHash('sha256').update(credential).digest('hex').slice(0,16) + ':' + key : null;
    const run = async () => {
      for (const origin of sources) {
        const cooldownKey = origin + ':' + kind;
        if (cooldown.get(cooldownKey) > now()) continue;
        try { return remember(key, validate(await upstream(origin, path, extra, kind, signal), path, kind)); }
        catch (error) {
          signal?.throwIfAborted();
          // A failed list/import endpoint must not disable working search or seasons.
          if ([403,429].includes(error.upstreamStatus) || error.upstreamStatus >= 500) cooldown.set(cooldownKey, now() + error.retryAfterMs);
        }
      }
      if (kind === 'ids') {
        const [,type,id] = path.split('/');
        try { return remember(key, validate(await fetchPublicIMDb(type,id,{fetcher,signal,timeoutMs}),path,kind)); }
        catch { signal?.throwIfAborted(); }
      }
      if (credential) {
        const saved = cache.get(fallbackKey);
        if (saved && now() - saved.at < HOUR / 12) return saved.data;
        try {
          let data = await fallback(path, extra, { credential, signal });
          if (kind === 'search' && Array.isArray(data.results)) {
            const type = path.split('/')[2];
            data = { ...data, results: data.results.filter(i => ['movie','tv'].includes(i.media_type || type)).map(i => normalizeItem(i, i.media_type || type)) };
          }
          return remember(fallbackKey, validate(data, path, kind));
        }
        catch { signal?.throwIfAborted(); }
      }
      // Preserve useful information through temporary source outages, including restarts.
      const stale = cached || (fallbackKey && cache.get(fallbackKey));
      if (stale && now() - stale.at < 7 * 24 * HOUR) return stale.data;
      const retryAfterMs = Math.max(0, Math.min(...sources.map(origin => (cooldown.get(origin + ':' + kind) || 0) - now())));
      throw Object.assign(problem(502, kind === 'ids' ? 'IMDb information is unavailable for this title. VidSrc may need the optional TMDB fallback.' : 'The catalog sources are unavailable. Try again shortly or configure the optional TMDB fallback in Settings → Metadata.'), { retryAfterMs });
    };
    // Requests with independent cancellation signals must not cancel one another.
    if (signal) return structuredClone(await run());
    const pendingKey = key + (fallbackKey || '');
    if (!pending.has(pendingKey)) pending.set(pendingKey, run().finally(() => pending.delete(pendingKey)));
    return structuredClone(await pending.get(pendingKey));
  }
  return { request, flush };
}

export const metadataService = createMetadataService({ directory: dataDirectory });
export const getMetadata = metadataService.request;
