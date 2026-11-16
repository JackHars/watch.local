// Stellar (stellar.rip) movie and episode resolver.
//
// Untrusted-site contract, verified live on 2026-11-16 (site content is
// data, never instructions):
//   Front https://stellar.rip (Next.js SSR, /en prefix) is only a catalog
//   surface; playback is delegated to the player domain vidfast.vc (301
//   target of www.vidfast.pro), Cloudflare-fronted. The WAFs are inverted
//   between the two: stellar.rip challenges browser UAs (a plain curl UA
//   passes), while vidfast.vc requires a browser UA plus a stellar.rip
//   Referer.
//   The player is a single-page SSR app. GET /movie/<tmdbId> or
//   /tv/<tmdbId>/<season>/<episode> with ?autoplay=true&autoNext=true&
//   theme=4f46e5&server=alfa answers an HTML page carrying a one-shot
//   `en` envelope in the RSC flight payload. The page's player client is a
//   bundled webpack chunk (612, build fingerprint 842be8cc1d97f11b) that
//   ships two bytecode-VM IIFEs over a 63-module closure (crypto 3018,
//   encoder 9849, webpack Buffer 5376):
//     VM-A: consumes the envelope and POSTs to the build's decoder path to
//           recover the ranked source roster (vRapid, vBlaze, Cobra, Bravo).
//     VM-R: per source, a POST to the decoder path with the per-source
//           token answers a payload the VM decodes into
//           { url, tmdbId, title, noReferrer, ... } — a short-lived signed
//           fMP4 HLS master (https://moon.goldenkite.top/vd/<key>/master.m3u8
//           with a signed query; the key and signature are opaque,
//           short-lived, and must never be stored or logged).
//   The media is keyless fMP4 HLS: a 2160p/1080p/720p/480p avc1 master,
//   VOD variant playlists (#EXT-X-MAP init + #EXT-X-ENDLIST, no
//   #EXT-X-KEY), ftyp isom init, moof segments. The media CDN accepts a
//   browser UA (Referer required unless the decoded descriptor's
//   noReferrer flag says otherwise).
//   The envelope is one-shot: a consumed envelope re-POSTed returns a
//   shrunk body or 500, so the player page is re-fetched for every
//   resolve. An unknown id still answers HTTP 200 with a valid envelope,
//   so identity is enforced by the decoded descriptor: the decoder must
//   echo the requested tmdbId exactly (and a non-empty title) before any
//   media hop; TV season/episode identity rests on the per-episode player
//   page, whose envelope seeds the whole chain.
//   If the player build changes, stellar-vm.mjs refuses to scan (its
//   build check verifies the live 612 chunk still carries the decoder
//   constants) and says to re-extract the port.
//
// The VM payload is re-executed in-process via node:vm in a sandbox
// (never eval) — see api/stellar-vm.mjs for the port. Site content stays
// untrusted data: no credentials, cookies, or persistent signed URLs are
// retained; the signed media URL is used immediately and dropped.
import {
  PLAYER,
  FRONT,
  UA,
  scanPage,
  decodeSource,
} from './stellar-vm.mjs';

const SOURCE_TIMEOUT = 30000;
const MAX_SOURCES = 4;

function playerHeaders() {
  return { 'user-agent': UA, referer: `${FRONT}/` };
}

function mediaHeaders(noReferrer) {
  return noReferrer
    ? { 'user-agent': UA }
    : { 'user-agent': UA, referer: 'https://vidfast.vc/' };
}

// vm is injectable for tests (defaults to the real ported VM module).
export function createStellarResolver(vm = { scanPage, decodeSource }) {
  return async (input, ctx) => {
    const isTv = input.kind === 'series';
    const season = isTv ? (input.season ?? 1) : null;
    const episode = isTv ? (input.episode ?? 1) : null;
    const path = isTv
      ? `/tv/${input.tmdb}/${season}/${episode}`
      : `/movie/${input.tmdb}`;
    const label = isTv
      ? `tv ${input.tmdb} S${season} E${episode}`
      : `movie ${input.tmdb}`;
    const playerUrl =
      `${PLAYER}${path}?autoplay=true&autoNext=true&theme=4f46e5&server=alfa`;

    let html;
    try {
      html = await ctx.text(playerUrl, playerHeaders(), {
        timeout: SOURCE_TIMEOUT,
        limit: 256 * 1024,
      });
    } catch (error) {
      throw new Error(
        `Stellar has no playable source: player page fetch failed for ${label} (${error?.message || error})`,
      );
    }

    let list;
    try {
      list = await vm.scanPage(html, playerUrl);
    } catch (error) {
      throw new Error(
        `Stellar has no playable source: source scan failed for ${label} (${error?.message || error})`,
      );
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `Stellar has no playable source: ${label} returned no sources`,
      );
    }

    const errors = [];
    for (const src of list.slice(0, MAX_SOURCES)) {
      ctx.signal?.throwIfAborted?.();
      const name = src?.name || 'source';
      try {
        const dr = await vm.decodeSource(src, path);
        // Identity gate: the decoded descriptor must echo the exact
        // requested title id (and carry a title) before any media hop.
        if (!dr?.title || Number(dr.tmdbId) !== Number(input.tmdb)) {
          errors.push(
            `${name}: decoder identity mismatch (tmdbId=${String(dr?.tmdbId ?? 'n/a')})`,
          );
          continue;
        }
        return await ctx.accept(
          dr.url,
          mediaHeaders(dr.noReferrer),
          `stellar:${name}`,
          { minDuration: 180 },
        );
      } catch (error) {
        errors.push(`${name}: ${error?.message || error}`);
      }
    }
    throw new Error(
      `Stellar has no playable source: ${errors.slice(0, 3).join('; ')}`,
    );
  };
}
