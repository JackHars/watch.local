// GreyBox: Duck DNS front (greyboxtv.duckdns.org) over the Vidora player build
// (vidoraplayer.duckdns.org). Sources arrive from an NDJSON scan endpoint and
// every media byte travels through a short-lived token proxy (`/api/media?u=***`),
// so the adapter re-resolves on each request and never caches signed URLs.
//
// Verified contract (recon 2026-11-16, 1368337 + 1400 s1e1-s1e3):
//   - SSR watch pages are id-keyed: unknown ids and out-of-range season/episode
//     return 404 "Page not found" (honest, no substitution).
//   - /api/sources returns NDJSON (application/x-ndjson): source/done events,
//     closed shortly after done; settles in 8-26s. TV answers are keyed by the
//     explicit season/episode query; missing s/e would return a default episode.
//   - Keyless fMP4 (Orion/Nova/Carbon/Moon/Ravok) or AES-128 MPEG-TS (Vega;
//     no MAP, key via the same proxy, IV = MEDIA-SEQUENCE big-endian).
//   - The pool is unstable: relays can return 200 with an error body, and
//     per-source byte gates plus bounded failover are required.
const FRONT = 'https://greyboxtv.duckdns.org';
const PLAYER_HOST = 'vidoraplayer.duckdns.org';
const PLAYER = `https://${PLAYER_HOST}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'user-agent': UA };
// The scan is the provider's one slow step (it probes its upstream roster in
// parallel); allow it most of the 30s provider budget, leaving time for the
// bounded media chain.
const SCAN_TIMEOUT = 28000;
// Bounded per-source failover across the ranked roster.
const MAX_SOURCES = 5;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// Parse the NDJSON scan body: keep only same-origin /api/media sources with a
// resolvable URL, dedupe by URL, and rank keyless high-quality streams first
// (Vega's AES-128 TS variant stays the last resort).
export function scanSources(text) {
  const seen = new Set();
  const out = [];
  const consider = s => {
    if (!s || typeof s.url !== 'string' || !s.url.startsWith('/api/media?')) return;
    let abs;
    try { abs = new URL(s.url, PLAYER); } catch { return; }
    if (abs.hostname !== PLAYER_HOST || seen.has(abs.href)) return;
    seen.add(abs.href);
    out.push({ ...s, url: abs.href });
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue; // "null"/"123" lines parse but carry no event
    if (e.event === 'source') consider(e.source);
    else if (e.event === 'done' && Array.isArray(e.sources)) for (const s of e.sources) consider(s);
  }
  return out.sort((a, b) => rankSource(a) - rankSource(b));
}

function rankSource(s) {
  const keyed = /vega/i.test(s.providerGroup || '') ? 1000 : 0;
  const quality = /1080/i.test(s.quality || '') ? 0 : /720/i.test(s.quality || '') ? 1 : 2;
  const dubbed = /·/.test(s.label || '') ? 1 : 0;
  return keyed + quality * 10 + dubbed;
}

export function createGreyboxResolver() {
  return greybox;
}

async function greybox(input, ctx) {
  const isTv = input.kind === 'series';
  const { tmdb } = input;
  const { season, episode } = isTv ? input : { season: null, episode: null };
  const ident = isTv ? `tv ${tmdb} S${season} E${episode}` : `movie ${tmdb}`;
  const signal = ctx.signal;

  // Identity gate: the SSR watch page is id-keyed (404 for unknown ids and
  // out-of-range episodes) and echoes the exact title and path.
  const page = isTv
    ? `${FRONT}/tv/watch/${tmdb}/${season}/${episode}`
    : `${FRONT}/movie/watch/${tmdb}`;
  let html;
  try {
    html = await ctx.text(page, H, { timeout: 15000, limit: 256 * 1024 });
  } catch (error) {
    throw new Error(`GreyBox has no ${ident} (watch page ${error.message})`);
  }
  const title = decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] || '').trim();
  const titleOk = isTv
    ? new RegExp(`^Watch .+ · S${season} E${episode} · GreyBox$`).test(title)
    : /^Watch .+ · GreyBox$/.test(title);
  const echo = isTv ? `/tv/${tmdb}/${season}/${episode}` : `/movie/watch/${tmdb}`;
  if (!titleOk || !html.includes(echo)) {
    throw new Error(`GreyBox watch page does not echo ${ident}`);
  }

  // NDJSON source scan. TV always carries explicit season/episode: a missing
  // pair would make the backend substitute a default episode.
  const qs = new URLSearchParams({ type: isTv ? 'tv' : 'movie', id: String(tmdb) });
  if (isTv) {
    qs.set('season', String(season));
    qs.set('episode', String(episode));
  }
  const ndjson = await ctx.text(`${PLAYER}/api/sources?${qs}`, H, { timeout: SCAN_TIMEOUT, limit: 256 * 1024 });
  const sources = scanSources(ndjson);
  if (!sources.length) throw new Error(`GreyBox returned no sources for ${ident}`);

  // Bounded per-source failover; every candidate passes the shared
  // accept() byte gate (playlist shape, fMP4 init/segment brands, AES-128
  // key + big-endian IV, or MPEG-TS sync pattern).
  const errors = [];
  for (const source of sources.slice(0, MAX_SOURCES)) {
    signal.throwIfAborted();
    try {
      return await ctx.accept(source.url, H, `greybox:${source.providerGroup || 'stream'}`, { minDuration: 180 });
    } catch (error) {
      errors.push(`${source.label || source.providerGroup || 'source'}: ${error.message}`);
    }
  }
  throw new Error(`GreyBox has no playable source for ${ident}: ${errors.join(' | ')}`);
}
