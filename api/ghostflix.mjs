// Ghostflix (https://ghostflix.st) — TMDB-addressed VOD through its embedded
// VidBolt player (https://vidbolt.st), which resolves by bare TMDB id.
//
// Chain (live-verified 2026-11-15; all keyless plain HTTPS, no bot challenge,
// no encryption, no WASM):
//   1. GET https://vidbolt.st/api/resolve?type=movie|tv&id=<tmdbId>[&season=&episode=]&hevc=0
//      -> { stream: { server, sources: [{ url, kind, quality, master }],
//           subtitles, resolvedAt } } or { stream: null } when the title,
//      season, or episode does not exist. No auth headers and no referer gate
//      (verified with none/ghostflix/unrelated referers). Each source's inline
//      `master` field is a STALE preview whose tokens 401 immediately; only
//      sources[i].url is re-fetched live.
//   2. GET sources[i].url (proxy.vidbolt.xyz /m/<token>?f=.m3u8) -> a master
//      playlist (movies) or a flat VOD media playlist (TV) of /s/<token>
//      segments; the CDN mislabels segment Content-Type (text/html or
//      image/jpeg), so validation is byte-based: 0x47 at every 188-byte
//      offset (MPEG-TS).
//
// Tokens are short-lived (re-signed per resolve/manifest fetch); every
// playback re-resolves fresh and nothing is cached or stored. Identity is
// request-addressed by the bare TMDB id — the API response carries no title
// field of its own, and unavailable content answers stream:null and fails
// honestly. Series map to type=tv; the API's separate type=anime flavor is
// not exposed because watch.local's input model has no anime kind. hevc=0 is
// the verified H.264 chain.

const API = 'https://vidbolt.st';

export function createGhostflixResolver() {
  return async function ghostflix(input, ctx) {
    const tmdb = Number(input.tmdb);
    if (!Number.isInteger(tmdb) || tmdb <= 0) throw new Error('Ghostflix requires an integer TMDB id');
    const type = input.kind === 'series' ? 'tv' : 'movie';
    const q = new URLSearchParams({ type, id: String(tmdb), hevc: '0' });
    if (type === 'tv') {
      const season = Number(input.season);
      const episode = Number(input.episode);
      if (!Number.isInteger(season) || season < 0) throw new Error('Ghostflix requires a valid season');
      if (!Number.isInteger(episode) || episode < 1) throw new Error('Ghostflix requires a valid episode');
      q.set('season', String(season));
      q.set('episode', String(episode));
    }
    const data = await ctx.json(`${API}/api/resolve?${q}`);
    const sources = data?.stream?.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('Ghostflix has no playable source for this title');
    }
    let last;
    for (const source of sources.slice(0, 3)) {
      if (typeof source?.url !== 'string') continue;
      try {
        return await ctx.accept(source.url, {}, 'ghostflix');
      } catch (err) {
        last = err;
      }
    }
    throw last || new Error('Ghostflix has no playable source for this title');
  };
}
