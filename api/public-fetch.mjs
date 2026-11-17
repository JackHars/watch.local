import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

// Providers supply URLs, redirects, keys and playlist entries. None may reach
// the host, its LAN, a cloud metadata service, or another non-public network.
const blocked4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
// Exclude special-purpose assignments, Teredo, documentation and 6to4. IPv4
// mapped/compatible addresses, NAT64, ULA, link-local and multicast are outside
// 2000::/3, so they cannot hide an otherwise blocked IPv4 destination.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked6.addSubnet(address, prefix, 'ipv6');

const blocked = () => Object.assign(new Error('Upstream destination blocked: only public Internet addresses are allowed.'), { code: 'ERR_UPSTREAM_ADDRESS', status: 502 });
const hostText = value => String(value).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
export function isPublicAddress(address) {
  const host = hostText(address), family = isIP(host);
  return family === 4 ? !blocked4.check(host, 'ipv4')
    : family === 6 && global6.check(host, 'ipv6') && !blocked6.check(host, 'ipv6');
}
export function publicURL(value) {
  let url;
  try { url = new URL(value); } catch { throw blocked(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw blocked();
  const host = hostText(url.hostname);
  if (isIP(host) ? !isPublicAddress(host) : !host.includes('.') || /(?:^|\.)(?:localhost|local|lan|localdomain|internal|home|arpa)$/.test(host)) throw blocked();
  return url;
}

// This lookup is used by the socket itself, not by a separate preflight check.
// The validated addresses are the exact addresses Node connects to; a second
// DNS answer cannot swap a public address for a private one (DNS rebinding).
export function createPublicLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' ? options : { family: options };
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) return callback(blocked());
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
const dispatcher = new Agent({ connect: { lookup: createPublicLookup(), timeout: 10000 }, connections: 12, pipelining: 1 });

// Bound bodies buffered for parsing/decryption. Streaming video uses its reader
// directly, so this limit does not truncate normal playback.
export async function readPublicBody(response, limit = 8 * 1024 * 1024) {
  const chunks = []; let length = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) throw Object.assign(new Error('Upstream response is too large.'), { status: 502 });
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function publicFetch(value, options = {}) {
  let url = publicURL(value);
  const headers = new Headers(options.headers);
  headers.delete('host');
  let method = String(options.method || 'GET').toUpperCase(), body = options.body;
  const signal = options.signal || AbortSignal.timeout(30000);
  for (let hops = 0; ; hops++) {
    signal.throwIfAborted();
    let response;
    try {
      // Use the global transport so tests can inject fixtures without weakening
      // the production address policy or adding an allow-private setting.
      response = await globalThis.fetch(url.href, { ...options, headers: Object.fromEntries(headers), method, body, signal, dispatcher, redirect: 'manual' });
    } catch (error) {
      if (error.code === 'ERR_UPSTREAM_ADDRESS' || error.cause?.code === 'ERR_UPSTREAM_ADDRESS') throw blocked();
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || options.redirect === 'manual') return response;
    await response.body?.cancel();
    if (options.redirect === 'error' || hops >= 7) throw Object.assign(new Error('Upstream redirect refused.'), { status: 502 });
    const next = publicURL(new URL(location, url));
    if (next.origin !== url.origin) {
      for (const key of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(key);
    }
    if (([301, 302].includes(response.status) && method === 'POST') || (response.status === 303 && !['GET', 'HEAD'].includes(method))) {
      method = 'GET'; body = undefined;
      for (const key of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(key);
    }
    url = next;
  }
}
