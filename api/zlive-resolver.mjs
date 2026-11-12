import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createContext, Script } from 'node:vm';

export const zliveOrigin = 'https://iptv.zlive.st';
// Keep the verified resolver User-Agent and use lowercase names to override the
// shared relay's defaults without sending duplicate Origin/Referer headers.
export const zliveHeaders = { origin: 'https://zlive.st', referer: 'https://zlive.st/', 'user-agent': 'Mozilla/5.0' };
let script;

// Hermes extracted this signer from ZLive's public web player. Keep its globals
// outside the app, and supply the same headers to ticket AND resolve requests.
// Omitting Origin here returns a playable blocking video instead of a channel.
export async function resolveZlive(key, { fetchResource = fetch } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(key)) throw Error('Invalid ZLive source.');
  script ||= readFile(new URL('./vendor/zlive-resolver.cjs', import.meta.url), 'utf8').then(text => new Script(text));
  const context = createContext({ module: { exports: {} }, crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa,
    fetch: (url, options = {}) => {
      const target = new URL(url);
      if (target.origin !== zliveOrigin || !['/session/ticket', '/resolve'].includes(target.pathname)) throw Error('Unexpected ZLive resolver request.');
      return fetchResource(target, { ...options, headers: { ...zliveHeaders, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    },
  });
  (await script).runInContext(context, { timeout: 2000 });
  const result = new URL(await context.module.exports.E8(key));
  if (result.protocol !== 'https:' || result.username || result.password || result.port) throw Error('Invalid ZLive stream URL.');
  return result.href;
}
