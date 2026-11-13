import { isIP } from 'node:net';
import { createChannelProvider } from './channel-provider.mjs';
import { probeSportsStream } from './sports-probe.mjs';

export const TIMSTREAMS_ID_BASE = 1100000000;
export const timstreamsOrigin = 'https://tim-streams.com';
const agent = 'Mozilla/5.0';
const fail = message => Object.assign(new Error(message), { status: 502 });
const clean = value => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300);
const genres = { 1: 'entertainment', 2: 'sports', 3: 'kids', 4: 'movies', 5: 'news' };

function httpsURL(value) {
  let url; try { url = new URL(value); } catch { throw fail('Tim Streams returned an invalid media address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /\.(local|lan|localhost)$/i.test(url.hostname)) throw fail('Tim Streams returned an unsupported media address.');
  return url;
}

async function body(response, limit) {
  if (!response.ok) { await response.body?.cancel(); throw fail(`Tim Streams returned HTTP ${response.status}.`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length; if (size > limit) throw fail('Tim Streams response is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

export function createTimstreamsSource({ fetchResource = fetch, probe = probeSportsStream } = {}) {
  const request = async (value, headers) => {
    let url = httpsURL(value);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetchResource(url.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: url.href };
      await response.body?.cancel();
      url = httpsURL(new URL(response.headers.get('location'), url).href);
    }
    throw fail('Tim Streams returned too many player redirects.');
  };
  return {
    async list() {
      const { response } = await request(timstreamsOrigin + '/api/channels', { 'user-agent': agent });
      const data = JSON.parse((await body(response, 4 * 1024 * 1024)).toString());
      if (!Array.isArray(data.channels)) throw fail('Tim Streams channel catalog is unavailable.');
      const channels = new Map();
      for (const row of data.channels) {
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(row.url || '') || !clean(row.name)) continue;
        const sources = [...new Set((Array.isArray(row.streams) ? row.streams : []).flatMap(s => {
          try { return [httpsURL(s.url).href]; } catch { return []; }
        }))].slice(0, 8);
        if (!sources.length) continue;
        channels.set(row.url, { provider: 'timstreams', key: row.url, name: clean(row.name), category: genres[row.genre] || 'entertainment',
          flag: /^[a-z]{2}$/i.test(row.flag || '') ? row.flag.toUpperCase() : '', quality: '', live: true, sources });
      }
      if (!channels.size) throw fail('Tim Streams has no channels available.');
      return [...channels.values()];
    },
    async resolve(playerURL) {
      try {
        const player = await request(playerURL, { 'user-agent': agent, referer: timstreamsOrigin + '/' });
        const ticket = timstreamsTicket((await body(player.response, 1024 * 1024)).toString());
        const headers = { 'user-agent': agent, referer: player.url, origin: new URL(player.url).origin };
        const blob = await request(ticket, headers);
        const stream = { url: decodeTimstreamsTicket(await body(blob.response, 8192), ticket), headers };
        // Some channels publish a playlist while their video CDN is offline.
        // Fail before opening the native player, allowing another feed to try.
        await probe(stream, { fetchResource });
        return stream;
      } catch (error) {
        if (error.status === 502) throw fail(error.message.replace(/\bSports\b/g, 'Tim Streams').replace(/\bsports\b/g, 'Tim Streams'));
        throw fail('Tim Streams could not reach this channel. Try another feed or retry shortly.');
      }
    },
  };
}

export const createTimstreamsProvider = options => createChannelProvider({ provider: 'timstreams', label: 'Tim Streams', idBase: TIMSTREAMS_ID_BASE, ...options, source: options.source || createTimstreamsSource() });
