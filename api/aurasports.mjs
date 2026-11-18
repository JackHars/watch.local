import { publicFetch } from './public-fetch.mjs';
import { probeSportsStream } from './sports-probe.mjs';
import { decodeZliveMedia, ZLIVE_MEDIA_LIMIT } from './zlive-media.mjs';

const SCHEDULE = 'https://aurasports.cfd/api/schedule';
const HEADERS = { referer: 'https://frame.embedme.cfd/', origin: 'https://frame.embedme.cfd' };
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const teams = title => String(title || '').split(/\s+(?:vs?\.?|versus|at|@)\s+/i).map(clean);

export function matchAurasportsEvent(event, groups) {
  if (!(event.starts_at > 0)) return null;
  const wanted = teams(event.title);
  if (wanted.length !== 2 || !wanted.every(Boolean)) return null;
  const matches = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (clean(group.category_name) !== clean(event.sport)) continue;
    for (const row of Array.isArray(group.schedule) ? group.schedule : []) {
      const home = clean(row.teams?.home?.name), away = clean(row.teams?.away?.name);
      if (!/^espn-\d+$/.test(row.id || '') || !home || !away || !Number.isFinite(row.date) || Math.abs(row.date / 1000 - event.starts_at) > 90 * 60) continue;
      if ((wanted[0] === home && wanted[1] === away) || (wanted[0] === away && wanted[1] === home)) matches.push(row);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function verifiedURL(value, host, path) {
  let url;
  try { url = new URL(value); } catch { throw fail('AuraSports returned an invalid player address.'); }
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || !path.test(url.pathname)) throw fail('AuraSports returned an unsupported player address.');
  return url.href;
}

export function createAurasportsSource({ fetchResource = publicFetch, now = Date.now, probe = probeSportsStream } = {}) {
  const cache = new Map();
  let checkedAt = null, lastError = '';
  async function get(url, headers = {}, signal, limit = 2 * 1024 * 1024) {
    const response = await fetchResource(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail(`AuraSports returned HTTP ${response.status}.`); }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('AuraSports response is too large.'); }
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > limit) throw fail('AuraSports response is too large.'); parts.push(part); }
    return Buffer.concat(parts).toString('utf8');
  }
  async function decodedFetch(url, options) {
    if (!new URL(url).pathname.endsWith('.image')) return fetchResource(url, options);
    // The provider stores gzip-compressed MPEG-TS in PNG pixels. Range requests
    // would truncate that container, so validate the complete decoded segment.
    const headers = { ...options.headers }; delete headers.Range; delete headers.range;
    const response = await fetchResource(url, { ...options, headers });
    if (!response.ok) return response;
    if (Number(response.headers.get('content-length')) > ZLIVE_MEDIA_LIMIT) { await response.body?.cancel(); throw fail('AuraSports segment is too large.'); }
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > ZLIVE_MEDIA_LIMIT) throw fail('AuraSports segment is too large.'); parts.push(part); }
    const video = await decodeZliveMedia(Buffer.concat(parts));
    return new Response(video, { headers: { 'content-type': video[0] === 0x47 ? 'video/mp2t' : 'video/mp4' } });
  }
  async function open(row, signal) {
    const sources = (Array.isArray(row.sources) ? row.sources : []).slice(0, 3);
    let last;
    for (const source of sources) {
      signal?.throwIfAborted();
      try {
        const player = verifiedURL(source.url, 'play.aurasportsplayer.cfd', new RegExp(`^/event/${row.id}$`));
        const page = await get(player, { referer: 'https://aurasports.cfd/' }, signal);
        const frame = verifiedURL(page.match(/<iframe\b[^>]*\bsrc=["']([^"']+)/i)?.[1], 'frame.embedme.cfd', new RegExp(`^/frame/${row.id}$`));
        const html = await get(frame, { referer: player }, signal);
        // Read a literal configuration value; never execute provider page code.
        const media = html.match(/\b(?:var|const|let)\s+streamUrl\s*=\s*["']([^"']+)["']/i)?.[1];
        const url = verifiedURL(media, 'hls.meth-streams-hd.cfd', new RegExp(`^/live/${row.id}/index\\.m3u8$`));
        const stream = { url, headers: HEADERS, playback: { provider: 'aurasports', root: url } };
        await probe(stream, { fetchResource: decodedFetch, signal });
        return stream;
      } catch (error) { last = error; }
    }
    throw last || fail('AuraSports has no supported broadcast for this game.', 503);
  }
  return {
    validatesStreams: true,
    status: () => ({ checkedAt, error: lastError }),
    async resolve(event, { signal, fresh = false } = {}) {
      const key = `${event.sport}:${clean(event.title)}:${event.starts_at}`;
      const saved = cache.get(key);
      if (!fresh && saved && now() < saved.expires) return saved.stream;
      try {
        const groups = JSON.parse(await get(SCHEDULE, {}, signal));
        const row = matchAurasportsEvent(event, groups);
        if (!row) throw fail('AuraSports has no matching event.', 503);
        const stream = await open(row, signal);
        cache.set(key, { stream, expires: now() + 2 * 60_000 });
        while (cache.size > 100) cache.delete(cache.keys().next().value);
        checkedAt = now(); lastError = '';
        return stream;
      } catch (error) { checkedAt = now(); lastError = error.message; throw error; }
    },
    media: async (url, context) => ({ url, headers: HEADERS, playback: context }),
  };
}
