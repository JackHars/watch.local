// Cinema (BZ) (https://cinema.army) — a token-gated, AES-128-CBC movie/episode
// resolver (live-verified 2026-11-16, evidence artifact 07552f4c27ae;
// re-verified live 2026-11-24).
//
// Chain: the movie endpoint is POST /api/cookiebakers/movie/<tmdb> plus GET
// mirrors on the ngcloud/tcloud/ipcloud/dcloud servers; the TV endpoint is
// POST /api/cookiebakers/tv/<tmdb>/<s>/<e> plus the tcloud/ipcloud/dcloud
// mirrors (ngcloud is movie-only). Every call needs the X-Stream-Token header
// (hex HMAC-SHA256 of "<tmdb>:<minute>" with the bundle-published key — a
// missing or rotated token is HTTP 401). A hit answers
// { stream: { url, duration_seconds } }, whose url is either a plain http(s)
// playlist or a base64+XOR blob (second bundle-published key) decoding to the
// real playlist on the cookiebakers23blog.xyz / *.slowcloud.live CDN family:
// master (v1080/v720/v480; TV adds an audio group and forced subtitles) →
// variant → leaf with #EXT-X-KEY:METHOD=AES-128,URI="../enc.key",IV=0x<static>
// (16-byte key file served openly) → AES-128-CBC segments → MPEG-TS. No DRM or
// EME, no cookie gate, no Referer gate on the CDN.
//
// Identity: the API keys content by the exact TMDB id in the path and never
// echoes the requested id or title, so what plays is the content of that exact
// key — there is no echo to trust and no room to substitute. Coverage is
// sparse per title (404 = the server does not carry the title) and the mirror
// CDN has been observed to serve HTML/PNG bait or dead hosts for the same
// paths, so every server's answer is media-validated by accept() and a
// failing mirror is simply skipped; the adapter fails with per-server
// evidence only when no server carries the title, and the central resolver
// then falls through to the next provider.
//
// Rotation: if the site rotates the bundle keys, every server answers 401 and
// the adapter fails fast with that evidence (no wasted mirrors); the fix is
// re-extracting the keys in cinema-crypto.mjs.
import { streamToken, decodeStreamUrl } from './cinema-crypto.mjs';

const ORIGIN = 'https://cinema.army';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MEDIA = { origin: ORIGIN, referer: `${ORIGIN}/`, 'user-agent': UA };

// Site order: the primary cookiebakers server first, then the mirrors.
const SERVERS = {
  movie: [
    ['cookiebakers', 'POST', (tmdb) => `/cookiebakers/movie/${tmdb}`],
    ['ngcloud', 'GET', (tmdb) => `/ngcloud/movie/${tmdb}`],
    ['tcloud', 'GET', (tmdb) => `/tcloud/movie/${tmdb}`],
    ['ipcloud', 'GET', (tmdb) => `/ipcloud/movie/${tmdb}`],
    ['dcloud', 'GET', (tmdb) => `/dcloud/movie/${tmdb}`],
  ],
  series: [
    ['cookiebakers', 'POST', (tmdb, season, episode) => `/cookiebakers/tv/${tmdb}/${season}/${episode}`],
    ['tcloud', 'GET', (tmdb, season, episode) => `/tcloud/tv/${tmdb}/${season}/${episode}`],
    ['ipcloud', 'GET', (tmdb, season, episode) => `/ipcloud/tv/${tmdb}/${season}/${episode}`],
    ['dcloud', 'GET', (tmdb, season, episode) => `/dcloud/tv/${tmdb}/${season}/${episode}`],
  ],
};

export function createCinemaResolver() {
  return async function cinema(input, ctx) {
    const tmdb = Number(input.tmdb);
    const isSeries = input.kind === 'series';
    const season = isSeries ? Number(input.season) : null;
    const episode = isSeries ? Number(input.episode) : null;
    const errors = {};
    for (const [name, method, pathFor] of SERVERS[isSeries ? 'series' : 'movie']) {
      ctx.signal?.throwIfAborted();
      const path = pathFor(tmdb, season, episode);
      // Recomputed per server: the token is minute-bucketed, so a long
      // failover must not carry a stale bucket into a later mirror.
      const headers = { accept: 'application/json', 'user-agent': UA, 'x-stream-token': streamToken(tmdb) };
      try {
        const data = await ctx.json(`${ORIGIN}/api${path}`, headers, method === 'POST' ? { body: {} } : undefined);
        const raw = data?.stream?.url;
        if (typeof raw !== 'string' || !raw.trim()) throw new Error(`Cinema (BZ) ${name} returned no stream URL`);
        const url = decodeStreamUrl(raw);
        if (!/^(https?):\/\//.test(url)) throw new Error(`Cinema (BZ) ${name} stream URL did not decode to http(s)`);
        return { ...(await ctx.accept(url, MEDIA, 'cinema')), server: name };
      } catch (error) {
        if (error?.message === 'HTTP 401') throw new Error('Cinema (BZ) stream token rejected (HTTP 401 on every server); the bundle-published key may have rotated');
        errors[name] = error?.message || 'unavailable';
      }
    }
    throw new Error(`Cinema (BZ) has no ${isSeries ? 'episode' : 'movie'} ${tmdb}: ` +
      Object.entries(errors).map(([server, message]) => `${server} (${message})`).join(', '));
  };
}
