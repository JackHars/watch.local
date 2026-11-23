import { load } from 'cheerio';
import { publicFetch, readPublicBody } from './public-fetch.mjs';
import { publishedURL, publishedPlaylists, fetchPublished } from './published-stream.mjs';
import { probeSportsStream } from './sports-probe.mjs';
import { decodeZliveMedia, ZLIVE_MEDIA_LIMIT } from './zlive-media.mjs';

const SCHEDULE = 'https://aurasports.cfd/api/schedule';
const legacyFrame = 'frame.embedme.cfd';
const knownFrames = new Set([legacyFrame, 'frame.aurasportsplayer.cfd']);
const legacyHeaders = { referer: 'https://frame.embedme.cfd/', origin: 'https://frame.embedme.cfd' };
// New streams are public. Existing signed relay URLs predate the frameHost field.
const mediaHeaders = (frameHost = legacyFrame) => frameHost === legacyFrame ? legacyHeaders : {};
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

export function createAurasportsSource({ fetchResource = publicFetch, now = Date.now, probe = probeSportsStream } = {}) {
  const cache = new Map();
  let checkedAt = null, lastError = '';
  async function get(url, headers, signal, accept) {
    const timeout = AbortSignal.timeout(8000);
    const page = await fetchPublished(fetchResource, url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }, accept);
    const { response } = page;
    if (!response.ok) { await response.body?.cancel(); throw fail(`AuraSports returned HTTP ${response.status}.`); }
    return { url: page.url, text: (await readPublicBody(response, 2 * 1024 * 1024)).toString('utf8') };
  }
  async function decodedFetch(url, options, accept) {
    const headers = new Headers(options.headers);
    if (!headers.has('range')) return fetchPublished(fetchResource, url, options, accept);
    // The probe marks the video request with Range. A wrapped segment needs
    // its complete upstream response regardless of its filename.
    headers.delete('range');
    const { response } = await fetchPublished(fetchResource, url, { ...options, headers });
    if (!response.ok) return response;
    if (Number(response.headers.get('content-length')) > ZLIVE_MEDIA_LIMIT) { await response.body?.cancel(); throw fail('AuraSports segment is too large.'); }
    const video = await decodeZliveMedia(await readPublicBody(response, ZLIVE_MEDIA_LIMIT));
    return new Response(video, { headers: { 'content-type': video[0] === 0x47 ? 'video/mp2t' : 'video/mp4' } });
  }
  async function open(row, signal, excludeURL) {
    const eventIds = url => [...url.pathname.split('/'), ...url.searchParams.values()].filter(part => /^espn-\d+$/i.test(part));
    // An exact schedule record can publish an opaque player or CDN URL. If the
    // destination does identify a game, it must still identify this game.
    const sameEvent = url => eventIds(url).every(id => id === row.id);
    const advertised = (Array.isArray(row.sources) ? row.sources.slice(0, 3) : []).map(source => source?.url);
    const pages = [...advertised, row.watchUrl, row.iframeUrl].map(value => publishedURL(value, SCHEDULE))
      .filter(url => url && sameEvent(url)).map(url => ({ url: url.href, player: true, referer: new URL(SCHEDULE).origin + '/' }));
    const visited = new Set(), manifests = new Set([excludeURL]);
    let last;
    while (pages.length) {
      signal?.throwIfAborted();
      const entry = pages.shift();
      if (visited.has(entry.url)) continue;
      visited.add(entry.url);
      try {
        const page = await get(entry.url, { referer: entry.referer }, signal, sameEvent);
        const base = new URL(page.url), frameHost = base.hostname;
        const $ = load(page.text);
        const declared = page.text.match(/\b(?:var|const|let)\s+streamUrl\s*=\s*["']([^"']+)["']/i)?.[1];
        const links = page.text.trimStart().startsWith('#EXTM3U') ? [page.url] : [...publishedPlaylists($, base), declared];
        for (const link of links) {
          const media = publishedURL(link, base);
          if (!media || !sameEvent(media) || manifests.has(media.href)) continue;
          manifests.add(media.href);
          const headers = mediaHeaders(frameHost);
          try {
            const acceptRoot = url => sameEvent(url) && url.href !== excludeURL;
            const verified = await probe({ url: media.href, headers }, {
              signal, fetchResource: (url, options) => decodedFetch(url, options, url === media.href ? acceptRoot : undefined),
            });
            const root = verified?.root || media.href;
            return { url: root, mediaPlaylist: verified?.mediaPlaylist, headers, playback: { provider: 'aurasports', root, frameHost } };
          } catch (error) { last = error; }
        }
        if (entry.player) {
          // A new external frame must be explicitly identified as the event player.
          const frames = [];
          for (const el of $('iframe[src]')) {
            const frame = publishedURL($(el).attr('src'), base);
            if (!frame || !sameEvent(frame)) continue;
            const marked = $(el).is('#player-frame');
            const matches = eventIds(frame).includes(row.id);
            if (!marked && !(matches && (frame.origin === base.origin || knownFrames.has(frame.hostname) || $(el).is('[allowfullscreen]')))) continue;
            frames.push({ url: frame.href, player: false, referer: base.origin + '/' });
            if (frames.length === 2) break;
          }
          pages.unshift(...frames);
        }
      } catch (error) { last = error; }
    }
    signal?.throwIfAborted();
    throw last || fail('AuraSports has not published a playlist for this event yet.', 503);
  }
  return {
    validatesStreams: true,
    status: () => ({ checkedAt, error: lastError }),
    async resolve(event, { signal, fresh = false, excludeURL } = {}) {
      const key = `${event.sport}:${clean(event.title)}:${event.starts_at}`;
      const saved = cache.get(key);
      if (!fresh && saved && saved.stream.url !== excludeURL && now() < saved.expires) return saved.stream;
      try {
        const groups = JSON.parse((await get(SCHEDULE, {}, signal)).text);
        const row = matchAurasportsEvent(event, groups);
        if (!row) throw fail('AuraSports has no matching event.', 503);
        const stream = await open(row, signal, excludeURL);
        cache.set(key, { stream, expires: now() + 2 * 60_000 });
        while (cache.size > 100) cache.delete(cache.keys().next().value);
        checkedAt = now(); lastError = '';
        return stream;
      } catch (error) { checkedAt = now(); lastError = error.message; throw error; }
    },
    media: async (url, context) => ({ url, headers: mediaHeaders(context.frameHost), playback: context }),
  };
}
