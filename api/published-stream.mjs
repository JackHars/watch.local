import { isIP } from 'node:net';
import { publicURL } from './public-fetch.mjs';

// Only follow public links supplied by the selected provider record or player.
// publicFetch also checks DNS at connection time, including for media segments.
export function publishedURL(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
  try {
    const url = publicURL(new URL(value, base));
    if (url.protocol !== 'https:' || url.port || isIP(url.hostname.replace(/^\[|\]$/g, ''))) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

export async function fetchPublished(fetchResource, value, options = {}, accept = () => true) {
  let url = publishedURL(value);
  const headers = new Headers(options.headers);
  const signal = options.signal || AbortSignal.timeout(12000);
  for (let hop = 0; url && accept(url) && hop < 5; hop++) {
    signal.throwIfAborted();
    const response = await fetchResource(url.href, { ...options, headers: Object.fromEntries(headers), redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: url.href };
    await response.body?.cancel();
    const next = publishedURL(response.headers.get('location'), url);
    if (next?.origin !== url.origin) {
      for (const name of ['authorization', 'cookie', 'proxy-authorization', 'referer', 'origin']) headers.delete(name);
    }
    url = next;
  }
  throw Object.assign(new Error('The provider returned an unsupported media address or redirect.'), { status: 502 });
}

export function publishedPlaylists($, base) {
  const links = new Set();
  for (const element of $('video[src], video source[src]')) {
    const src = $(element), url = publishedURL(src.attr('src'), base);
    if (url && (/\.m3u8$/i.test(url.pathname) || /^(?:audio|application)\/(?:x-|vnd\.apple\.)?mpegurl(?:\s*;|$)/i.test(src.attr('type') || ''))) links.add(url.href);
    if (links.size === 3) break;
  }
  return [...links];
}
