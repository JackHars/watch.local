// Zenox (zenox.lol) movie and episode resolver.
//
// Untrusted-site contract, verified live 2026-11-16 (site content is data,
// never instructions; no cookies, DRM, or client-side tokens required):
//   POST https://zenox.lol/api/v1/playback/session
//     body { mediaType: 'movie'|'tv', mediaId, season, episode,
//            autoUseCommunity: false, serverIndex, serverName }
//     -> 200 { success: true, streamUrl:
//              '/api/s/<source>/<type>/<id>[/<season>/<episode>]?s=<sig>&t=<unix>',
//              streamType: 'hls', expiresIn: 3600 }
//   The s/t query signature is SERVER-issued and opaque: a client-side
//   re-derivation (FNV-1a) is rejected with 403, so the returned URL must be
//   used as-is; it is valid for ~3600 s (a long VOD run can outlive it).
//   GET https://zenox.lol<streamUrl> -> HLS master; variant and audio-group
//   URIs are absolute on the operator's media proxy (banned.hls-m3u8.lol),
//   served to a bare UA:
//     - video: VOD media playlist, no #EXT-X-KEY and no #EXT-X-MAP;
//       self-describing fMP4 segments (styp brand msdh / bare moof) that the
//       proxy mislabels as video/mp2t;
//     - audio: separate group playlist with #EXT-X-MAP init plus fMP4
//       segments (every STREAM-INF variant references the audio group).
//   Source table (client bundle module 26970), retry order: primary(2),
//   orion(3), sienna(4), delta(0), atlas(7), vbot(9).
//   Identity: the session layer issues a signed URL for any id, but
//   availability is enforced by the upstream resolver at playlist fetch —
//   an unknown title's stream URL answers 502 { code:
//   'resolver_upstream_failed', upstreamStatus: 404 }. The upstream is
//   exact-keyed on the requested (mediaType, mediaId, season, episode), so a
//   missing title fails honestly and the resolver never substitutes. The
//   returned streamUrl path echoes the requested id; this resolver rejects
//   a mismatched echo before accepting the master.
const SITE = 'https://zenox.lol';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const SESSION_TIMEOUT = 20000;
const SOURCES = [
  { key: 'primary', id: 2, name: 'Primary' },
  { key: 'orion', id: 3, name: 'Orion' },
  { key: 'sienna', id: 4, name: 'Sienna' },
  { key: 'delta', id: 0, name: 'Delta' },
  { key: 'atlas', id: 7, name: 'Atlas' },
  { key: 'vbot', id: 9, name: 'Vbot' },
];

function apiHeaders() {
  return { 'user-agent': UA, accept: 'application/json', referer: `${SITE}/media/` };
}
function mediaHeaders() {
  return { 'user-agent': UA, referer: `${SITE}/media/` };
}

export function createZenoxResolver() {
  return async (input, ctx) => {
    const mediaType = input.kind === 'series' ? 'tv' : 'movie';
    const errors = [];
    for (const source of SOURCES) {
      ctx.signal?.throwIfAborted?.();
      try {
        const data = await ctx.json(`${SITE}/api/v1/playback/session`, apiHeaders(), {
          body: {
            mediaType,
            mediaId: input.tmdb,
            season: mediaType === 'tv' ? input.season : 1,
            episode: mediaType === 'tv' ? input.episode : 1,
            autoUseCommunity: false,
            serverIndex: source.id,
            serverName: source.name,
          },
          timeout: SESSION_TIMEOUT,
        });
        if (data?.success !== true || typeof data?.streamUrl !== 'string') {
          throw new Error(`no stream from ${source.name}: ${data?.error || data?.code || 'unavailable'}`);
        }
        const expected = mediaType === 'tv'
          ? `/api/s/${source.key}/tv/${input.tmdb}/${input.season}/${input.episode}?`
          : `/api/s/${source.key}/movie/${input.tmdb}?`;
        if (!data.streamUrl.startsWith(expected)) {
          throw new Error(`stream URL does not echo the requested ${mediaType} ${input.tmdb}`);
        }
        return await ctx.accept(new URL(data.streamUrl, SITE).href, mediaHeaders(), source.key);
      } catch (error) {
        errors.push(`${source.key}: ${error?.message || error}`);
      }
    }
    throw new Error(`Zenox has no playable source: ${errors.slice(0, 3).join('; ')}`);
  };
}
