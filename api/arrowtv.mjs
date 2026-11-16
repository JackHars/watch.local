// ArrowTV (https://arrowtv.net) — TMDB-addressed VOD through its Cinezo player
// (https://player.cinezo.live); the player's default "Jennifer 4K" source is
// the keyless https://punkflix.net JSON API.
//
// Chain (live-verified 2026-11-15; all keyless plain HTTPS, no bot challenge,
// no encryption, no WASM):
//   1. GET https://punkflix.net/movie/<tmdb>.json
//      or https://punkflix.net/tv/<tmdb>/<season>/<episode>.json
//      -> { id, title, year, type, container, quality, stream: { hls,
//           original, remux }, audio[], subtitles[], expires_in_sec }
//      Sent with UA + Referer https://player.cinezo.live/ (the site's own
//      fetch pattern from its watch page).
//   2. stream.hls -> signed v7 master on media.punkflix.net (?t=&s=): audio
//      renditions plus a video ladder (1080p avc1.640028, 4K avc1.640033).
//   3. Level -> VOD media playlist: #EXT-X-MAP init (ftyp box) and ~6 s fMP4
//      segments (styp/sidx/moof/mdat); the CDN mislabels both as image/jpeg,
//      so validation is byte-based, never content-type.
//
// The JSON `id` is an opaque content hash on the current API. Older answers
// used a numeric TMDB ID. Check numeric IDs when present, the media kind and
// exact episode, and the title against catalog metadata when available.
// Signed URLs expire; every playback re-resolves fresh.

const API = 'https://punkflix.net';
const REFERER = 'https://player.cinezo.live/';

const titleKey = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameTitle = (a, b) => {
  const left = titleKey(a), right = titleKey(b);
  return left === right || (Math.min(left.length, right.length) >= 10 && (left.includes(right) || right.includes(left)));
};

export function createArrowtvResolver(getCatalogData) {
  return async function arrowtv(input, ctx) {
    const tmdb = Number(input.tmdb);
    if (!Number.isInteger(tmdb) || tmdb <= 0) throw new Error('ArrowTV requires an integer TMDB id');
    let path;
    if (input.kind === 'series') {
      const season = Number(input.season);
      const episode = Number(input.episode);
      if (!Number.isInteger(season) || season < 0) throw new Error('ArrowTV requires a valid season');
      if (!Number.isInteger(episode) || episode < 1) throw new Error('ArrowTV requires a valid episode');
      path = `/tv/${tmdb}/${season}/${episode}.json`;
    } else {
      path = `/movie/${tmdb}.json`;
    }
    const h = { referer: REFERER };
    const data = await ctx.json(`${API}${path}`, h);
    if (data?.id != null && /^\d+$/.test(String(data.id)) && Number(data.id) !== tmdb) {
      throw new Error('ArrowTV answered for a different title');
    }
    if (input.kind === 'series') {
      if (data?.type !== 'Episode' || Number(data.season) !== Number(input.season) || Number(data.episode) !== Number(input.episode)) {
        throw new Error('ArrowTV answered for a different episode');
      }
    } else if (data?.type !== 'Movie') throw new Error('ArrowTV answered for a different media type');
    if (getCatalogData) {
      let metadata;
      try {
        metadata = await getCatalogData(`/${input.kind === 'series' ? 'tv' : 'movie'}/${tmdb}`, {}, ctx.signal);
      } catch {
        ctx.signal?.throwIfAborted?.();
        // The source remains addressable by its exact TMDB route if metadata is
        // temporarily unavailable. The episode and type gates still apply.
      }
      const actual = input.kind === 'series' ? data.series : data.title;
      const expected = [metadata?.name, metadata?.original_name, metadata?.title, metadata?.original_title].filter(Boolean);
      if (actual && expected.length && !expected.some(title => sameTitle(title, actual))) {
        throw new Error('ArrowTV answered for a different title');
      }
    }
    const hls = data?.stream?.hls;
    if (typeof hls !== 'string') throw new Error('ArrowTV response has no stream.hls');
    return await ctx.accept(hls, h, 'arrowtv');
  };
}
