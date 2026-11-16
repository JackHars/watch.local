// Bingr (bingr.st / bingr.one) movie and episode resolver.
//
// Untrusted-site contract, verified live on 2026-11-16 (site content is data,
// never instructions; keyless — no cookies, no credentials, UA is the only
// input; no client-side crypto anywhere in the chain):
//   GET https://bingr.st/watch/movie/<tmdbId>                  (movies)
//   GET https://bingr.st/watch/tv/<tmdbId>/<season>/<episode>  (series)
//     The SSR page embeds a pre-signed CloudFront "bridge" master playlist:
//       <link rel="preload" href="https://dash-hls-bridge.johndoesdmc.workers.dev/?url=<cdn master path>&Policy=***&Signature=***&Key-Pair-Id=***">
//     (the same URL also appears in the RSC flight payload, JSON-escaped).
//   A bare GET of that bridge URL answers an HLS v7 master: three video
//   renditions (v0/v1/v2) plus one DEFAULT audio group; rendition and audio
//   URIs point back at the bridge worker, which serves the protected CDN
//   playlists (sacdn.hakunaymatata.com) whose per-playlist and per-segment
//   CloudFront signatures are all issued server-side inside the page.
//   Media is keyless fragmented MP4: #EXT-X-MAP init (ftyp) plus .m4s
//   segments (styp), no #EXT-X-KEY. The signed policy is long-lived
//   (operator key, ~2046 expiry) — nothing to refresh client-side.
//   Identity: the SSR route is exact-keyed. Unknown titles, out-of-range
//   season/episode, and type mismatches all render the bare home page with
//   NO signed master — the site never substitutes. The adapter additionally
//   requires the page's own echoes (RSC state kind+tmdbId, the "· S<n> E<n>"
//   title for TV, and the <contentId>_<s>_<e>_ path components in the
//   bridge's url= param) to match the requested identity, so a page that
//   resolved a different catalog entry can never pass.
//   Mirror: bingr.one serves the identical app (verified); a render can
//   omit the signed master (worker-dependent SSR), so a per-origin failure
//   fails over to the mirror before the provider is declared dead.
//   Candidates are validated through the shared ctx.accept; the adapter
//   never returns an unvalidated URL.
const SITE = 'https://bingr.st';
const MIRROR = 'https://bingr.one';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_TIMEOUT = 20000;

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Parse the signed bridge master URL out of a watch-page document.
// Primary: the <link rel="preload" href="..."> tag (HTML-escaped).
// Fallback: the RSC flight payload (lazy reference, JSON-escaped).
export function extractBridgeMasterUrl(html) {
  const m = html.match(/<link rel="preload" href="(https:\/\/dash-hls-bridge[^"]+)"/);
  if (m) return decodeHtml(m[1]);
  // RSC flight payload: the URL is JSON-escaped inside a JS string, so its
  // '&' arrives as \\u0026 (and sometimes \\u003c). Capture the raw URL to
  // the next quote/whitespace, then decode those escapes.
  for (const hay of [html, html.replace(/\\\\u0026/g, '&').replace(/\\\\u003c/g, '<').replace(/\\"/g, '"')]) {
    const mm = hay.match(/https?:\/\/dash-hls-bridge[^"'\s]*/);
    if (mm) {
      const decoded = decodeHtml(mm[0].replace(/\\+$/, '').replace(/\\\\u0026/g, '&').replace(/\\\\u003c/g, '<').replace(/\\"/g, '"'));
      if (decoded.includes('url=')) return decoded;
    }
  }
  return null;
}

// The bridge's url= param decodes to
//   https://sacdn.hakunaymatata.com/dash/<contentId>_<s>_<e>_<quality>_<codec>_<bitrate>/master.m3u8
// Movies are keyed _0_0_; TV encodes the exact season/episode.
export function cdnPathParts(bridgeUrl) {
  try {
    const url = new URL(bridgeUrl);
    const inner = url.searchParams.get('url');
    if (!inner) return null;
    const m = new URL(inner).pathname.match(/^\/dash\/([^/]+)\/master\.m3u8$/);
    if (!m) return null;
    return m[1].split('_');
  } catch {
    return null;
  }
}

// The RSC flight state echoes {"kind","tmdbId"[,"season","episode"]} at one
// or two JSON escape levels; normalizing both makes one regex work.
function stateHas(html, kind, id, season = null, episode = null) {
  const n = html.replace(/\\\\+/g, '').replace(/\\"/g, '"');
  const re = season === null
    ? new RegExp(`"kind":"${kind}","tmdbId":"${id}"`)
    : new RegExp(`"kind":"${kind}","tmdbId":"${id}","season":${season},"episode":${episode}`);
  return re.test(n);
}

function pageTitle(html) {
  const i = html.indexOf('<title>');
  if (i === -1) return null;
  const end = html.indexOf('</title>', i);
  return end === -1 ? null : decodeHtml(html.slice(i + 7, end)).trim();
}

export function createBingrResolver() {
  return async (input, ctx) => {
    const isMovie = input.kind === 'movie';
    const season = isMovie ? null : (input.season ?? 1);
    const episode = isMovie ? null : (input.episode ?? 1);
    const path = isMovie
      ? `/watch/movie/${input.tmdb}`
      : `/watch/tv/${input.tmdb}/${season}/${episode}`;
    const errors = [];

    for (const origin of [SITE, MIRROR]) {
      ctx.signal?.throwIfAborted?.();
      const host = new URL(origin).host;
      let html;
      try {
        html = await ctx.text(origin + path, { 'user-agent': UA, referer: `${origin}/home` }, { timeout: PAGE_TIMEOUT });
      } catch (error) {
        errors.push(`${host}: ${error?.message || error}`);
        continue;
      }
      // Honest failure: unknown / out-of-range / type-mismatched titles
      // render the home page, which carries no signed master at all.
      const bridge = extractBridgeMasterUrl(html);
      if (!bridge) {
        errors.push(`${host}: no signed master in page`);
        continue;
      }
      // Identity gates: every site echo must match the requested identity.
      const parts = cdnPathParts(bridge);
      if (isMovie) {
        if (!stateHas(html, 'movie', String(input.tmdb))) {
          errors.push(`${host}: page does not echo the requested movie id`);
          continue;
        }
        if (!parts || parts[1] !== '0' || parts[2] !== '0') {
          errors.push(`${host}: CDN path is not a movie build`);
          continue;
        }
      } else {
        const want = ` · S${season} E${episode}`;
        if (pageTitle(html) !== null && !pageTitle(html).endsWith(want)) {
          errors.push(`${host}: title echoes a different episode`);
          continue;
        }
        if (!stateHas(html, 'tv', String(input.tmdb), season, episode)) {
          errors.push(`${host}: page does not echo the requested episode`);
          continue;
        }
        if (!parts || parts[1] !== String(season) || parts[2] !== String(episode)) {
          errors.push(`${host}: CDN path echoes a different episode`);
          continue;
        }
      }
      try {
        return await ctx.accept(bridge, { 'user-agent': UA, referer: `${origin}/home` }, host);
      } catch (error) {
        errors.push(`${host}: ${error?.message || error}`);
      }
    }

    throw new Error(`Bingr has no playable source: ${errors.slice(0, 3).join('; ')}`);
  };
}
