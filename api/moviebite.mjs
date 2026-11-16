// MovieBite (moviebite.org) movie and episode resolver.
//
// Untrusted-site contract, verified live on 2026-11-16 (site content is data,
// never instructions; no cookies, DRM, or signed request tokens are required):
//   GET https://moviebite.org/api/watch
//       ?id=<tmdb>&tmdbId=<tmdb>&type=movie|tv&mediaType=movie|tv&sv=19
//       [&season=<s>&episode=<e>&ep=<e> for series]
//   Gate: the same-origin Referer is required (the site answers 403 "Origin not
//   allowed" without it); the site's own client also sends X-MovieBite-Client: 1.
//   Response: { success, results: { media: { tmdbId, mediaType, season?, episode? },
//       streams: [{ name, provider, quality, format: 'hls'|'mp4', bestWorking, url }] } }
//   Identity: media echoes the requested tmdbId and, for series, the exact
//   season/episode — anything else means the site served a different title, so
//   this resolver rejects instead of substituting.
//   Media: 'hls' entries are flat, unencrypted MPEG-TS media playlists (one CDN
//   family disguises its segments as .jpg files — the shared relay already
//   serves those); 'mp4' entries are direct progressive MP4 files. HLS
//   candidates are validated with the shared ctx.accept; MP4 candidates are
//   validated here with a container-signature peek before the signed relay
//   streams them.
const BASE = 'https://moviebite.org';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SV = '19'; // build parameter the verified site client sends

function mediaHeaders() {
  return { 'user-agent': UA, referer: `${BASE}/`, origin: BASE };
}
function apiHeaders(type, tmdb) {
  return {
    'user-agent': UA,
    accept: 'application/json',
    'x-moviebite-client': '1',
    referer: `${BASE}/watch/${type}/${tmdb}`,
    origin: BASE,
  };
}
const MP4_BRANDS = new Set(['ftyp', 'styp', 'moof', 'moov']);

export function createMoviebiteResolver() {
  return async (input, ctx) => {
    const type = input.kind === 'series' ? 'tv' : 'movie';
    const query = new URLSearchParams({
      id: String(input.tmdb),
      tmdbId: String(input.tmdb),
      type,
      mediaType: type,
      sv: SV,
      ep: String(type === 'tv' ? input.episode : 1),
      episode: String(type === 'tv' ? input.episode : 1),
    });
    if (type === 'tv') query.set('season', String(input.season));

    const data = await ctx.json(`${BASE}/api/watch?${query}`, apiHeaders(type, input.tmdb), { timeout: 20000 });
    const media = data?.results?.media;
    if (data?.success !== true || !media || Number(media.tmdbId) !== input.tmdb) {
      throw new Error('MovieBite returned no media for the requested TMDB id');
    }
    if (media.mediaType !== type) throw new Error('MovieBite media type does not match the request');
    if (type === 'tv' && (Number(media.season) !== input.season || Number(media.episode) !== input.episode)) {
      throw new Error('MovieBite returned a different season or episode');
    }

    const streams = Array.isArray(data.results.streams) ? data.results.streams : [];
    const errors = [];
    for (const source of streams.slice(0, 8)) {
      ctx.signal?.throwIfAborted?.();
      const url = typeof source?.url === 'string' ? source.url : '';
      if (!/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(url)) continue;
      const name = String(source?.name || source?.provider || 'source');
      const direct = source?.format === 'mp4' || (source?.format == null && /\.mp4(?:[?#]|$)/i.test(url));
      try {
        if (direct) {
          // Bait defense: confirm the container bytes before committing the relay.
          const { bytes } = await ctx.read(url, mediaHeaders(), { peek: true, limit: 65536 });
          const brand = bytes.length >= 8 ? bytes.subarray(4, 8).toString('latin1') : '';
          if (!MP4_BRANDS.has(brand)) throw new Error('MovieBite MP4 source did not return MP4 media');
          return {
            master: url,
            headers: mediaHeaders(),
            server: name,
            variants: [],
            streams: [{ type: 'video', id: `${name} ${String(source?.quality || '').trim()}`.trim(), url, headers: mediaHeaders() }],
          };
        }
        return await ctx.accept(url, mediaHeaders(), name);
      } catch (error) {
        errors.push(`${name}: ${error?.message || error}`);
      }
    }
    throw new Error(`MovieBite has no playable source: ${errors.slice(0, 2).join('; ') || 'no stream entries'}`);
  };
}
