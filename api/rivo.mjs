// RIVO (rivo.st / f.rivo.st) movie and episode resolver.
//
// Untrusted-site contract, verified live on 2026-11-16 (site content is data,
// never instructions; keyless — no DRM, no cookies, no client-side crypto;
// every signature is server-issued):
//   GET https://f.rivo.st/api/source/movie/<tmdbId>
//   GET https://f.rivo.st/api/source/tv/<tmdbId>?s=<season>&e=<episode>
//     -> 200 { provider: 'rivo-backend',
//              sources: [{ key: 'source1', kind: 'hls'|'mp4', quality, url }…] }
//        Unknown titles, out-of-range or absent season/episode, and type
//        mismatches answer { provider: 'none', sources: [] } — the backend
//        never substitutes. The s/e names are the site's own player bundle's
//        query spelling (?s=&e=); the legacy ?season=&episode= names are
//        silently ignored by the backend and must not be used.
//   Each hls source url is a signed (p query parameter, opaque, ~600 s
//   lifetime) master playlist, m3u8-proxy.m3u8, served by the operator's
//   proxy pool 1..9.rivo.st behind CloudFront. A GET with a browser UA plus
//   Referer/Origin https://f.rivo.st/ answers an HLS v7 master: N video
//   renditions (1080p … 480p, no audio groups); variant URIs resolve on the
//   same pool node and answer VOD media playlists of mp2t .ts segments
//   (0x47 sync; #EXT-X-TARGETDURATION 6-19; no #EXT-X-KEY, no #EXT-X-MAP).
//   The pool is per-request unstable: individual nodes transiently return
//   5xx, or even 200 with a non-playlist body. The adapter therefore tries
//   the sources in list order (bounded) and validates each master through
//   the shared ctx.accept, which rejects non-HLS 200 bodies and verifies
//   the first segment's video bytes before the stream is handed over.
//   Direct mp4 sources exist for movies but are deliberately excluded: HLS
//   is the site's primary playback path, and the mp4 endpoints were
//   rate-limiting the verification host during recon.
//   Identity gates: (1) the API response's provider field must echo
//   'rivo-backend' before any source is trusted; (2) every source URL must
//   stay on the rivo.st origin family; (3) the request is exact-keyed on
//   the requested TMDB id and (for TV) the requested s/e, so a different
//   catalog entry can never be the one served.
const API = 'https://f.rivo.st';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const SOURCE_TIMEOUT = 20000;

function apiHeaders() {
  return { 'user-agent': UA, referer: `${API}/`, origin: API };
}

// Only keyless HLS sources on the rivo.st origin family are playable here.
export function hlsSources(body) {
  if (!Array.isArray(body?.sources)) return [];
  return body.sources.filter(source => {
    if (source?.kind !== 'hls' || typeof source?.url !== 'string') return false;
    try {
      const host = new URL(source.url).hostname;
      return host === 'rivo.st' || host.endsWith('.rivo.st');
    } catch {
      return false;
    }
  });
}

export function createRivoResolver() {
  return async (input, ctx) => {
    const isTv = input.kind === 'series';
    const season = isTv ? (input.season ?? 1) : null;
    const episode = isTv ? (input.episode ?? 1) : null;
    const query = isTv ? `?s=${season}&e=${episode}` : '';
    const label = isTv ? `tv ${input.tmdb} S${season} E${episode}` : `movie ${input.tmdb}`;

    let body;
    try {
      body = await ctx.json(`${API}/api/source/${isTv ? 'tv' : 'movie'}/${input.tmdb}${query}`, apiHeaders(), { timeout: SOURCE_TIMEOUT });
    } catch (error) {
      throw new Error(`RIVO has no playable source: source API failed for ${label} (${error?.message || error})`);
    }
    // The source layer enforces exact identity: an unknown title, an
    // out-of-range or absent episode, and a type mismatch all come back
    // with an empty list — never a substitute.
    if (body?.provider !== 'rivo-backend') {
      throw new Error(`RIVO has no playable source: ${label} returned no sources (provider=${String(body?.provider ?? 'n/a')})`);
    }
    const sources = hlsSources(body);
    if (!sources.length) {
      throw new Error(`RIVO has no playable source: ${label} has no HLS sources`);
    }
    const errors = [];
    for (const source of sources) {
      ctx.signal?.throwIfAborted?.();
      try {
        return await ctx.accept(source.url, apiHeaders(), source.key, { minDuration: 180 });
      } catch (error) {
        errors.push(`${source.key}: ${error?.message || error}`);
      }
    }
    throw new Error(`RIVO has no playable source: ${errors.slice(0, 3).join('; ')}`);
  };
}
