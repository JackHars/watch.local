import { load } from 'cheerio';
import { publicFetch as fetch, readPublicBody } from './public-fetch.mjs';
import { publishedURL, publishedPlaylists, fetchPublished } from './published-stream.mjs';
import { createChannelProvider } from './channel-provider.mjs';
import { probeSportsStream } from './sports-probe.mjs';

export const TIMSTREAMS_ID_BASE = 1100000000;
export const timstreamsOrigin = 'https://tim-streams.com';
const agent = 'Mozilla/5.0';
const fail = message => Object.assign(new Error(message), { status: 502 });
const clean = value => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300);
const genres = { 1: 'entertainment', 2: 'sports', 3: 'kids', 4: 'movies', 5: 'news' };
const channelKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

function httpsURL(value) {
  if (!publishedURL(value)) throw fail('Tim Streams returned an unsupported media address.');
  return new URL(value);
}

async function body(response, limit) {
  if (!response.ok) { await response.body?.cancel(); throw fail(`Tim Streams returned HTTP ${response.status}.`); }
  return readPublicBody(response, limit);
}

// Read the player's encoded configuration as data. Never execute its scripts,
// advertising, anti-debugging code or eval(), and never persist signed tickets.
export function timstreamsTicket(html) {
  if (html.length > 1024 * 1024) throw fail('Tim Streams player is too large.');
  const pattern = /var\s+[\w$]+\s*=\s*\[([\d,\s]+)\]\s*,\s*[\w$]+\s*=\s*(\d+)\s*,\s*[\w$]+\s*=\s*(\d+)\s*,/g;
  for (const match of html.matchAll(pattern)) {
    if (match[1].length > 200000) continue;
    const bytes = match[1].split(',').map(Number), xor = Number(match[2]), shift = Number(match[3]);
    if (![xor, shift, ...bytes].every(n => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
    const code = bytes.map(n => String.fromCharCode(((n ^ xor) - shift + 256) % 256)).join('');
    const ticket = code.match(/\bloadStreamUrl\(\s*(["'])(https:\/\/[^"'\s]+)\1\s*,/);
    if (ticket) {
      const url = httpsURL(ticket[2]);
      if (/^\/p\/[a-zA-Z0-9_-]{8,128}$/.test(url.pathname) && !url.search && !url.hash) return url.href;
    }
  }
  throw fail('Tim Streams player format changed or this channel is unavailable.');
}

export function decodeTimstreamsTicket(input, ticket) {
  const bytes = Buffer.from(input), key = httpsURL(ticket).pathname.split('/').pop();
  if (bytes.length < 2 || bytes.length > 8192 || !key) throw fail('Tim Streams returned an invalid stream ticket.');
  let value = '';
  for (let i = 1; i < bytes.length; i++) value += String.fromCharCode(bytes[i] ^ key.charCodeAt((i - 1) % key.length) ^ ((bytes[0] + i - 1) & 255));
  const url = httpsURL(value);
  if (!/\.m3u8$/i.test(url.pathname)) throw fail('Tim Streams did not return an HLS stream.');
  return url.href;
}

export function createTimstreamsSource({ fetchResource = fetch, probe = probeSportsStream, now = Date.now } = {}) {
  const publicHeaders = { 'user-agent': agent };
  let snapshot, pending, expires = 0, nextFailureRefresh = 0;
  async function directory(fresh) {
    if (pending) return pending;
    if (!fresh && snapshot && now() < expires) return snapshot;
    pending = (async () => {
      const { response } = await fetchPublished(fetchResource, timstreamsOrigin + '/api/channels', { headers: publicHeaders });
      const data = JSON.parse((await body(response, 4 * 1024 * 1024)).toString());
      if (!Array.isArray(data.channels)) throw fail('Tim Streams channel catalog is unavailable.');
      const channels = new Map();
      for (const row of data.channels) {
        if (!channelKey(row.url) || !clean(row.name) || Number(row.vip) === 1) continue;
        const sources = [...new Set((Array.isArray(row.streams) ? row.streams : [])
          .filter(s => s && Number(s.vip) !== 1).map(s => publishedURL(s.url, timstreamsOrigin)?.href).filter(Boolean))].slice(0, 8);
        if (!sources.length) continue;
        channels.set(row.url, { provider: 'timstreams', key: row.url, name: clean(row.name), category: genres[row.genre] || 'entertainment',
          flag: /^[a-z]{2}$/i.test(row.flag || '') ? row.flag.toUpperCase() : '', quality: '', live: true, sources });
      }
      if (!channels.size) throw fail('Tim Streams has no channels available.');
      snapshot = channels;
      expires = now() + 60000;
      return channels;
    })().catch(error => {
      nextFailureRefresh = now() + 30000;
      if (snapshot) expires = nextFailureRefresh;
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }

  function refreshFailedDirectory() {
    if (pending) return pending;
    if (snapshot && now() < nextFailureRefresh) return Promise.resolve(snapshot);
    nextFailureRefresh = now() + 30000;
    return directory(true);
  }

  async function openPlayer(reference, excludeURL, signal) {
    const verify = async (url, headers) => {
      if (url === excludeURL) throw fail('Tim Streams still lists the previous feed.');
      const acceptRoot = target => target.href !== excludeURL;
      const verified = await probe({ url, headers }, {
        signal, fetchResource: (value, options) => fetchPublished(fetchResource, value, options, value === url ? acceptRoot : undefined),
      });
      const root = verified?.root || url;
      return { url: root, mediaPlaylist: verified?.mediaPlaylist, headers: new URL(root).origin === new URL(url).origin ? headers : publicHeaders };
    };
    const pages = [httpsURL(reference).href];
    let last;
    for (const [index, url] of pages.entries()) {
      signal.throwIfAborted();
      try {
        if (/\.m3u8$/i.test(new URL(url).pathname)) return await verify(url, publicHeaders);
        const player = await fetchPublished(fetchResource, url, { headers: { ...publicHeaders, referer: timstreamsOrigin + '/' }, signal });
        const text = (await body(player.response, 2 * 1024 * 1024)).toString('utf8');
        if (text.trimStart().startsWith('#EXTM3U')) return await verify(player.url, publicHeaders);
        const $ = load(text);
        const links = publishedPlaylists($, player.url);
        for (const link of links) {
          try { return await verify(link, publicHeaders); } catch (error) { last = error; }
        }
        if (index === 0) {
          if (!links.length) {
            let ticket;
            try { ticket = timstreamsTicket(text); } catch (error) { last = error; }
            if (ticket) {
              const headers = { ...publicHeaders, referer: player.url, origin: new URL(player.url).origin };
              const blob = await fetchPublished(fetchResource, ticket, { headers, signal });
              return await verify(decodeTimstreamsTicket(await body(blob.response, 8192), ticket), headers);
            }
          }
          for (const el of $('iframe#player-frame[src], iframe[allowfullscreen][src]')) {
            const frame = publishedURL($(el).attr('src'), player.url);
            if (frame && frame.href !== player.url && !pages.includes(frame.href)) pages.push(frame.href);
            if (pages.length === 3) break;
          }
        }
      } catch (error) { last = error; }
    }
    throw last || fail('Tim Streams has not published a playable source for this channel.');
  }

  return {
    // The persistent ID and saved favorites use the channel slug. Player links
    // can rotate or carry query credentials and stay only in the memory cache.
    referencesFor: channel => [channel.key],
    async list() {
      return [...(await directory(true)).values()].map(channel => ({ ...channel, sources: [channel.key] }));
    },
    async resolve(reference, { fresh = false, excludeURL, signal: caller } = {}) {
      const timeout = AbortSignal.timeout(25000);
      const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
      try {
        signal.throwIfAborted();
        if (!channelKey(reference)) return await openPlayer(reference, excludeURL, signal);
        const before = snapshot;
        const current = await (excludeURL ? refreshFailedDirectory() : directory(fresh)).catch(error => { if (before) return before; throw error; });
        const tried = new Set();
        let last;
        async function tryChannel(channels) {
          for (const player of channels.get(reference)?.sources || []) {
            if (tried.has(player)) continue;
            tried.add(player);
            signal.throwIfAborted();
            try { return await openPlayer(player, excludeURL, AbortSignal.any([signal, AbortSignal.timeout(8000)])); } catch (error) { last = error; }
          }
        }
        let stream = await tryChannel(current);
        if (!stream && snapshot !== current) stream = await tryChannel(snapshot);
        else if (!stream && current === before && !fresh && !excludeURL) {
          signal.throwIfAborted();
          stream = await tryChannel(await refreshFailedDirectory());
        }
        if (stream) return stream;
        throw last || fail('Tim Streams has not published a playable source for this channel.');
      } catch (error) {
        if (error.status === 502) throw fail(error.message.replace(/\bSports\b/g, 'Tim Streams').replace(/\bsports\b/g, 'Tim Streams'));
        throw fail('Tim Streams could not reach this channel. Try another feed or retry shortly.');
      }
    },
  };
}

export const createTimstreamsProvider = options => createChannelProvider({ provider: 'timstreams', label: 'Tim Streams', idBase: TIMSTREAMS_ID_BASE, ...options, source: options.source || createTimstreamsSource() });
