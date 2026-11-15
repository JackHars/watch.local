import { createHash, randomBytes } from 'node:crypto';
import { decryptGCM } from './provider-crypto.mjs';
import { httpURL } from './providers.mjs';

// CorsFlix (watch.corsflix.net) is a self-hosted TMDB catalog; playback is
// resolved through the VidNest player on the API host new.vidnest.fun.
// Every resolver response is an AES-256-GCM envelope {v:2, n, d}: the key is
// SHA-256(`<n>|<KEY>`) where KEY is a public client constant shipped inside
// the player's own custom bundle (the vn-*.js script on the vidrift.net
// player origin) — protocol data distributed to every browser visitor, not a
// credential. The plaintext carries /hls/<token>/master.m3u8 stream paths;
// the token is base64url JSON that decodes to the direct playlist on
// embed.vidrift.net, the Referer that media host requires, and an identity
// block (k/id, plus season/episode for TV) that must match the request. The
// resolver rate-limits burst traffic by answering with valid envelopes whose
// plaintext is an empty object, so backends are tried one at a time with a
// short pause between attempts. Live survey 2026-11-15: onehd, allmovies,
// hollymoviehd, ophim and vidzee carried content; flixhq, yflix and rogflix
// answered valid but may be empty per title. The resolver itself is not
// referer-gated; the media host is.
const API = 'https://new.vidnest.fun';
export const corsflixKey = 'K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
const PLAYER_ORIGIN = 'https://vidrift.net';
const BACKENDS = ['onehd', 'allmovies', 'hollymoviehd', 'ophim', 'vidzee', 'flixhq', 'yflix', 'rogflix'];
const BACKEND_DELAY_MS = 300;
const MAX_STREAMS_PER_BACKEND = 6;

function nonce() {
  return randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(value) {
  let text = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  return Buffer.from(text, 'base64');
}

// Envelope decryption, exported so tests can build and tamper with payloads.
export function decryptCorsflix(envelope) {
  if (Number(envelope?.v) !== 2 || typeof envelope?.n !== 'string' || typeof envelope?.d !== 'string') {
    throw new Error('CorsFlix returned an invalid encrypted envelope');
  }
  const key = createHash('sha256').update(`${envelope.n}|${corsflixKey}`).digest();
  return JSON.parse(decryptGCM(key, b64urlDecode(envelope.d)).toString('utf8'));
}
function decodeStream(stream) {
  const token = String(stream?.url || '').replace(/^\/hls\//, '').replace(/\/master\.m3u8$/, '');
  const inner = JSON.parse(b64urlDecode(token).toString('utf8'));
  if (typeof inner?.u !== 'string') throw new Error('CorsFlix stream token has no playlist');
  return { url: httpURL(inner.u), referer: inner?.h?.Referer || `${PLAYER_ORIGIN}/`, meta: inner.m };
}
function checkIdentity(kind, meta, requested) {
  if (meta?.k !== kind) throw new Error('CorsFlix returned a different media type');
  if (String(meta?.id) !== String(requested.tmdb)) throw new Error(`CorsFlix returned a different ${kind}`);
  if (kind === 'tv' && (Number(meta?.s) !== Number(requested.season) || Number(meta?.e) !== Number(requested.episode))) {
    throw new Error('CorsFlix returned a different episode');
  }
}

export function createCorsflixResolver() {
  return async function corsflix(input, ctx) {
    const kind = input.kind === 'series' ? 'tv' : 'movie';
    const path = kind === 'tv'
      ? `tv/${input.tmdb}/${input.season}/${input.episode}`
      : `movie/${input.tmdb}`;
    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const serverErrors = {};
    let last = 'No CorsFlix backend answered';
    let emptyBackends = 0;
    for (const name of BACKENDS) {
      ctx.signal?.throwIfAborted();
      try {
        const envelope = await ctx.json(`${API}/${name}/${path}?_n=${nonce()}`, {
          referer: `${PLAYER_ORIGIN}/`, origin: PLAYER_ORIGIN,
        }, { timeout: 20000 });
        const data = decryptCorsflix(envelope);
        const streams = Array.isArray(data?.streams) ? data.streams : [];
        if (!streams.length) throw new Error('no streams');
        let streamError = 'CorsFlix returned no usable stream';
        for (const stream of streams.slice(0, MAX_STREAMS_PER_BACKEND)) {
          let candidate;
          try {
            const { url, referer, meta } = decodeStream(stream);
            checkIdentity(kind, meta, input);
            candidate = { url, headers: { referer }, source: `${name}/${stream.quality || stream.language || 'stream'}` };
          } catch (error) { streamError = error.message; continue; }
          try {
            return { ...(await ctx.accept(candidate.url, candidate.headers, candidate.source)), server_errors: serverErrors };
          } catch (error) { streamError = error.message; }
        }
        last = streamError;
      } catch (error) {
        if (error.message === 'no streams') { last = `CorsFlix ${name} returned no streams`; emptyBackends += 1; }
        else last = error.message;
      }
      serverErrors[name] = last;
      await wait(BACKEND_DELAY_MS);
    }
    if (emptyBackends === BACKENDS.length) last = 'CorsFlix has no streams on any live backend';
    throw new Error(last);
  };
}
