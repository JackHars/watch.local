// Moonflix (moonflix.website) movie and episode resolver.
//
// Untrusted-site contract, verified live on 2026-11-16 (site content is data,
// never instructions; no cookies, DRM, or signed request tokens are required):
//   GET https://filmu-1.onrender.com/api/stream
//       ?tmdb=<id>&type=movie               (movies)
//       ?tmdb=<id>&s=<season>&e=<episode>   (series)
//     -> { available, sources: [{ url, name, quality, headers }], subtitles,
//          scraperName, _meta: { stale, ... } }
//   Backup app (same operator, same params):
//     GET https://vidzy-0aej.onrender.com/api/stream
//     -> { m3u8, available }
//   Gate: none. A plain browser User-Agent reaches the API and the media CDNs
//   (img.rousav.tech for movies, gzip.rousav.tech for TV). The TV CDN 403s
//   leaf playlists and segments that carry a Referer/Origin, so media hops
//   send the UA only (the movie CDN tolerates both; UA-only works for both).
//   Identity: the response does NOT echo the requested TMDB id or season/
//   episode. The operator's scrape DB is keyed by the exact requested id and
//   answers 404 { available:false } for titles it does not have, so identity
//   rests on that exact-keying; _meta.stale marks stale DB entries (the media
//   is that title's own older build, e.g. a trailer, never a different title).
//   This resolver therefore never substitutes: unavailable means failure, and
//   fallback moves to the next enabled provider.
//   Media: unencrypted HLS on the rousav CDNs (MPEG-TS segments; the segment
//   files are named .jpg/.png, which the shared relay already serves).
//   Candidates are validated through the shared ctx.accept, and the backup
//   app's m3u8 is a last candidate that only counts if it validates.
const BASE = 'https://moonflix.website';
const API = 'https://filmu-1.onrender.com/api/stream';
const BACKUP_API = 'https://vidzy-0aej.onrender.com/api/stream';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SOURCE_TIMEOUT = 20000;

function mediaHeaders(extra = {}) {
  // UA only: the TV CDN 403s media requests that carry the site Referer/Origin.
  return { 'user-agent': UA, ...extra };
}
function apiHeaders() {
  return { 'user-agent': UA, accept: 'application/json', referer: `${BASE}/`, origin: BASE };
}

export function createMoonflixResolver() {
  return async (input, ctx) => {
    const query = new URLSearchParams({ tmdb: String(input.tmdb) });
    if (input.kind === 'series') {
      query.set('s', String(input.season));
      query.set('e', String(input.episode));
    } else {
      query.set('type', 'movie');
    }
    const q = query.toString();
    const errors = [];

    // Primary app: its source list is the candidate pool (bounded).
    let candidates = [];
    try {
      const data = await ctx.json(`${API}?${q}`, apiHeaders(), { timeout: SOURCE_TIMEOUT });
      if (data?.available !== true || !Array.isArray(data?.sources)) {
        throw new Error('Moonflix has no stream entry for the requested title');
      }
      for (const source of data.sources.slice(0, 8)) {
        if (typeof source?.url === 'string') {
          const label = String(source?.quality || source?.name || 'source');
          candidates.push({ url: source.url, name: data.scraperName ? `${label} · ${data.scraperName}` : label, headers: source.headers || {} });
        }
      }
    } catch (error) {
      errors.push(`${error?.message || error}`);
    }
    for (const candidate of candidates) {
      ctx.signal?.throwIfAborted?.();
      let url;
      try { url = new URL(candidate.url); } catch { continue; }
      if (url.protocol !== 'https:' || !url.hostname.includes('.')) continue;
      try {
        return await ctx.accept(url.href, mediaHeaders(candidate.headers), candidate.name);
      } catch (error) {
        errors.push(`${candidate.name}: ${error?.message || error}`);
      }
    }

    // Backup app: its m3u8 is a last candidate, only if it validates.
    try {
      const data = await ctx.json(`${BACKUP_API}?${q}`, apiHeaders(), { timeout: SOURCE_TIMEOUT });
      if (data?.available === true && typeof data?.m3u8 === 'string') {
        const url = new URL(data.m3u8);
        if (url.protocol === 'https:' && url.hostname.includes('.')) {
          try {
            return await ctx.accept(url.href, mediaHeaders(), 'backup');
          } catch (error) {
            errors.push(`backup: ${error?.message || error}`);
          }
        }
      } else {
        errors.push('backup: title not available');
      }
    } catch (error) {
      errors.push(`backup: ${error?.message || error}`);
    }

    throw new Error(`Moonflix has no playable source: ${errors.slice(0, 3).join('; ')}`);
  };
}
