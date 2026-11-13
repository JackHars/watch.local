import { readReelixProtocol, reelixHandshake, reelixChallenge, decryptReelixResponse } from './reelix-protocol.mjs';

export const reelixOrigin = 'https://reelix.ac';
const origin = 'https://vidcore.io';
const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const unavailable = () => new Error('Reelix has no playable source for this title');

export function reelixPlayerURL(input) {
  if (!/^[1-9]\d*$/.test(String(input.tmdb)) || !Number.isSafeInteger(Number(input.tmdb))) throw unavailable();
  if (input.kind === 'movie') return `${origin}/movie/${input.tmdb}`;
  if (input.kind !== 'series' || !Number.isSafeInteger(input.season) || input.season < 0 || !Number.isSafeInteger(input.episode) || input.episode < 1) throw unavailable();
  return `${origin}/tv/${input.tmdb}/${input.season}/${input.episode}`;
}

export function createReelixResolver() {
  const protocols = new Map();
  return async function reelix(input, ctx) {
    // IDs are authoritative: a fuzzy title search must never change the movie
    // or episode being requested. Reelix embeds this canonical VidCore route.
    const player = reelixPlayerURL(input);
    const headers = { 'user-agent': agent, origin, referer: player };
    const html = await ctx.text(player, { ...headers, referer: reelixOrigin + '/' });
    const session = html.replaceAll('\\"', '"').match(/"en"\s*:\s*"([A-Za-z0-9_-]{16,256})"/)?.[1];
    if (!session) throw unavailable();
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].flatMap(m => {
      const url = new URL(m[1], origin);
      return url.origin === origin && /^\/_next\/static\/chunks\/\d+-[a-f0-9]+\.js$/.test(url.pathname) ? [url.href] : [];
    });
    // Reuse only public protocol parameters. Per-playback tickets stay in the
    // request and are never written to settings, the catalog, or disk.
    let protocol;
    for (const url of scripts) {
      const hit = protocols.get(url);
      if (hit && hit.expires > Date.now()) { protocol = hit.value; break; }
    }
    if (!protocol) {
      scripts.sort((a, b) => Number(b.includes('/281-')) - Number(a.includes('/281-')));
      for (const url of scripts.slice(0, 5)) {
        try {
          protocol = readReelixProtocol(await ctx.text(url, headers, { limit: 3 * 1024 * 1024 }));
          protocols.set(url, { value: protocol, expires: Date.now() + 3600000 });
          while (protocols.size > 4) protocols.delete(protocols.keys().next().value);
          break;
        } catch { ctx.signal?.throwIfAborted(); }
      }
    }
    if (!protocol) throw new Error('Reelix player format changed or is unavailable');
    const post = path => ctx.text(origin + path, headers, { body: {}, limit: 1024 * 1024 });
    const challenge = await post(protocol.handshakePath + '/' + reelixHandshake(session, protocol));
    const sources = decryptReelixResponse(await post(protocol.sourcesPath + '/' + reelixChallenge(challenge, protocol)), protocol);
    if (!Array.isArray(sources)) throw unavailable();
    for (const source of sources.slice(0, 4)) {
      if (!/^[A-Za-z0-9_-]{16,8192}$/.test(source?.data)) continue;
      try {
        const media = decryptReelixResponse(await post(protocol.streamPath + '/' + source.data), protocol);
        if (Number(media?.tmdbId) !== Number(input.tmdb) || typeof media.url !== 'string' || media.mp4) continue;
        const result = await ctx.accept(media.url, media.noReferrer ? { 'user-agent': agent } : headers, 'reelix');
        return result;
      } catch { ctx.signal?.throwIfAborted(); }
    }
    throw unavailable();
  };
}
