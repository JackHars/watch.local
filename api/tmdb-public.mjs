import { load } from 'cheerio';
import { problem } from './settings.mjs';

// The public Today panel loaded by TMDB's homepage. No API key, cookie or login.
export const trendingURL = 'https://www.themoviedb.org/remote/panel?panel=trending_scroller&group=today';

export function parseTrendingPanel(html) {
  const $ = load(html), items = [], seen = new Set();
  $('a[data-media-type][href]').each((_, element) => {
    const link = $(element), match = /^\/(movie|tv)\/([1-9]\d*)(?:[-/]|$)/.exec(link.attr('href'));
    if (!match || match[1] !== link.attr('data-media-type') || link.attr('data-media-adult') === 'true') return;
    const [, type, rawID] = match, id = Number(rawID), key = `${type}:${id}`;
    if (!Number.isSafeInteger(id) || seen.has(key)) return;
    const image = link.find('img').first();
    const title = (link.find('h2').text() || image.attr('alt') || link.attr('title') || '').trim();
    if (!title) return;
    let poster_path = null;
    try {
      const imageURL = new URL(image.attr('src'));
      if (['media.themoviedb.org','image.tmdb.org'].includes(imageURL.hostname)) {
        poster_path = /^\/t\/p\/[^/]+(\/[\w./-]+)$/.exec(imageURL.pathname)?.[1] || null;
      }
    } catch { /* A title can still be browsed without a poster. */ }
    const card = link.closest('[data-object-id], .card');
    const released = Date.parse(card.find('.release_date').first().text());
    const date = Number.isFinite(released) ? new Date(released).toISOString().slice(0,10) : '';
    seen.add(key);
    items.push({ id, media_type: type, adult: false, poster_path,
      ...(type === 'tv' ? {name: title, first_air_date: date} : {title, release_date: date}) });
  });
  if (!items.length) throw problem(502, 'TMDB’s public trending list could not be read.');
  return items.slice(0,20);
}

async function publicHTML(url, {fetcher, signal, timeoutMs = 8000}) {
  let response;
  try {
    response = await fetcher(url, {
      headers: {accept:'text/html', 'accept-language':'en-US,en;q=0.8', 'user-agent':'watch.local/1.0'},
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
  } catch {
    signal?.throwIfAborted();
    throw problem(502, 'TMDB’s public catalog is temporarily unavailable.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw problem(502, 'TMDB’s public catalog is temporarily unavailable.');
  }
  const html = await response.text();
  if (html.length > 1024 * 1024) throw problem(502, 'TMDB’s public catalog response is too large.');
  return html;
}

export async function fetchTrendingPanel(options) {
  return parseTrendingPanel(await publicHTML(trendingURL, options));
}

export async function fetchPublicIMDb(type, id, options) {
  const $ = load(await publicHTML(`https://www.themoviedb.org/${type}/${id}`, options));
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(element).text()), url = new URL(data.url);
      if (url.hostname !== 'www.themoviedb.org' || !new RegExp(`^/${type}/${id}(?:-|/|$)`).test(url.pathname)) continue;
      if (data['@type'] !== (type === 'tv' ? 'TVSeries' : 'Movie')) continue;
      for (const sameAs of Array.isArray(data.sameAs) ? data.sameAs : []) {
        const external = new URL(sameAs);
        const imdb = /^\/title\/(tt\d+)\/?$/.exec(external.pathname);
        if (['www.imdb.com','imdb.com'].includes(external.hostname) && imdb) return {id:Number(id),imdb_id:imdb[1]};
      }
    } catch { /* Ignore unrelated structured data and malformed links. */ }
  }
  throw problem(502, 'This title has no public IMDb mapping.');
}
