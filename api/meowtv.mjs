import { createHash, webcrypto } from 'node:crypto';

// MeowTV (https://meowtv.ru) — TMDB-backed movie/TV front end; playback is
// resolved through the site API at https://api.meowtv.ru. There is no public
// catalog JSON: content is addressed directly by TMDB id (site pages
// /play/movie/<id>, /play/tv/<id>; API paths /streams/movie/<id> and
// /streams/tv/<id>/<season>/<episode>).
//
// Resolver chain (re-verified live 2026-11-15):
//   1. POST /streams/ticket (Origin: https://meowtv.ru, body {})
//        -> { ticket, exp }  — tickets are single-use (replay answers 410
//                              "Ticket already used"); one is minted per
//                              encrypted request.
//      GET /streams/{movie|tv}/...?s=acme&list=1 (x-stream-ticket header)
//        -> { n, d }         — encrypted envelope of the stream list.
//   2. The envelope is decrypted by the site's own deobfuscator WASM:
//        key  = concat(base64(p0..p3)) XOR SHA-256(env)
//        wasm = AES-256-CTR(key, counter=V, C)   (wasm-bindgen module)
//        json = wasm.deobfuscate(n, d)
//      -> { streams: [{ language, url, headers }] }
//   3. Each stream.url is a signed, time-limited CDN HLS master playlist
//      (build-specific host) that requires the Referer returned inside the
//      stream entry (a build-specific alias domain). Variants are per-height
//      playlists; segments are MPEG-TS (video/mp2t, 0x47 sync) — accepted by
//      the shared isVideo check.
//
// Identity: the decrypted payload carries no id field; identity is bound to
// the exact TMDB path requested. Content the site does not carry answers
// 404 {"error":"No stream"} (verified for a nonexistent id), so a missing
// title or episode fails honestly — this adapter never substitutes another
// episode. Each (id, season, episode) request mints fresh signed tokens,
// verified to differ across episodes.
//
// "acme" is the built-in anonymous provider; peak/dcloud/tik/hindi/english
// are retired (HTTP 410); febbox needs a personal user token and is out of
// scope for anonymous integration.

const { subtle } = webcrypto;
const API = 'https://api.meowtv.ru';
const SITE_ORIGIN = 'https://meowtv.ru';
const MAX_STREAMS = 8;

// Public build constants extracted from the site's own published Vite bundles
// (meowtv.ru/assets/s-k0-Cv2SoWw7.js, s-k1-BCiQXwyN.js, s-k2-CszsFB7Y.js,
// s-k3-DEt-Ijnl.js, s-p-DJJOaLfH.js, s-core-CLWaWtzg.js; build served
// 2026-11-15). They are shipped to every browser visitor of meowtv.ru —
// public protocol data, not credentials. They rotate only when MeowTV
// rebuilds those assets: the size guards below then throw "build changed"
// and the provider fails honestly instead of playing wrong media.
// Re-extraction: load any /play/ page in a browser, fetch and import the
// five s-*.js chunks, and read their p / C / V exports.
const KEY_MATERIAL = {
    "source": {
      "build": "meowtv.ru Vite build serving /assets/s-k0-Cv2SoWw7.js, /assets/s-k1-BCiQXwyN.js, /assets/s-k2-CszsFB7Y.js, /assets/s-k3-DEt-Ijnl.js, /assets/s-p-DJJOaLfH.js, /assets/s-core-CLWaWtzg.js",
      "extraction": "executed the site's own unmodified chunk modules in a real Chromium tab (meowtv.ru/play/movie/27205); each chunk exports p (base64) after its anti-environment shuffle completes; s-p exports C (AES-CTR ciphertext of the deobfuscator WASM) and V (16-byte CTR counter)",
      "extracted_at": "2026-11-15T11:30:00+00:00",
      "nature": "public client-side build constants shipped to every visitor in the site's own bundles; not credentials. Stale only when MeowTV rebuilds these assets."
    },
    "p": [
      "URlryrwgZro=",
      "Woujt4YNwU0=",
      "lpQlV8dEWuw=",
      "h7RSetS+a24="
    ],
    "C": "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",
    "V": "DFDsHxHeNrR+pbIftcVySw==",
    "env": "objectobjectstringfunction",
    "key_derivation": "key[32] = concat(p0..p3 decoded)[32] XOR sha256(env)  -- env is the deterministic string 'objectobjectstringfunction' (typeof window + typeof document + typeof navigator.userAgent + typeof crypto.subtle.digest in any real browser)"
  };

const b64Decode = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// Exported so tests can pin the shape guard.
export async function meowtvKey(material) {
  const parts = Array.isArray(material?.p) ? material.p : [];
  const raw = new Uint8Array(32);
  let length = 0;
  for (const part of parts) {
    const bytes = b64Decode(String(part));
    raw.set(bytes, length);
    length += bytes.length;
  }
  if (length !== 32) throw new Error('MeowTV build changed — key material no longer matches the live site');
  const env = typeof material.env === 'string' && material.env ? material.env : 'objectobjectstringfunction';
  const mask = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(env)));
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = raw[i] ^ mask[i];
  return key;
}

let deobfuscatorPromise = null;
// Assembles the site's own deobfuscator WASM from the committed key material.
// Exported so tests can verify the committed material still builds the module.
export function buildMeowtvDeobfuscator() {
  if (!deobfuscatorPromise) deobfuscatorPromise = (async () => {
    const key = await meowtvKey(KEY_MATERIAL);
    const C = b64Decode(KEY_MATERIAL.C);
    const V = b64Decode(KEY_MATERIAL.V);
    if (C.length < 16 || V.length !== 16) throw new Error('MeowTV build changed — key material no longer matches the live site');
    const handle = await subtle.importKey('raw', key, { name: 'AES-CTR' }, false, ['decrypt']);
    const wasmBytes = new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter: V, length: 64 }, handle, C));
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, {
      env: { abort: () => { throw new Error('MeowTV deobfuscator aborted'); } },
    });
    const memory = () => instance.exports.memory.buffer;
    // wasm-bindgen string ABI: ptr -> ptr + len*2 (u16 units) stored at ptr-4
    const strFrom = (o) => {
      if (!o) return null;
      const end = o + new Uint32Array(memory())[(o - 4) >>> 2] >>> 1;
      const units = new Uint16Array(memory());
      let at = o >>> 1, out = '';
      for (; end - at > 1024;) out += String.fromCharCode(...units.subarray(at, at += 1024));
      return out + String.fromCharCode(...units.subarray(at, end));
    };
    const strTo = (o) => {
      if (o == null) return 0;
      const ptr = instance.exports.__new(o.length << 1, 2) >>> 0;
      const units = new Uint16Array(memory());
      for (let i = 0; i < o.length; i++) units[(ptr >>> 1) + i] = o.charCodeAt(i);
      return ptr;
    };
    return (n, d) => strFrom(instance.exports.deobfuscate(strTo(n), strTo(d)) >>> 0);
  })().catch((error) => { deobfuscatorPromise = null; throw error; });
  return deobfuscatorPromise;
}

let deobfuscatorOverride = null;
/** Test seam: substitute the envelope deobfuscator (default: the site's own WASM). */
export function setMeowtvDeobfuscator(fn) {
  deobfuscatorOverride = fn ? Promise.resolve(fn) : null;
}
function getDeobfuscator() {
  return deobfuscatorOverride || buildMeowtvDeobfuscator();
}

export function createMeowtvResolver() {
  return async function meowtv(input, ctx) {
    const kind = input.kind === 'series' ? 'tv' : 'movie';
    const path = kind === 'tv'
      ? `tv/${input.tmdb}/${input.season}/${input.episode}`
      : `movie/${input.tmdb}`;
    const subject = kind === 'tv' ? `${kind} ${input.tmdb} S${input.season}E${input.episode}` : `${kind} ${input.tmdb}`;
    const apiHeaders = { origin: SITE_ORIGIN, referer: `${SITE_ORIGIN}/` };
    let ticket;
    try {
      const issued = await ctx.json(`${API}/streams/ticket`, apiHeaders, { body: {}, timeout: 15000 });
      ticket = typeof issued?.ticket === 'string' ? issued.ticket : null;
      if (!ticket) throw new Error('no ticket');
    } catch (error) {
      throw new Error(`MeowTV ticket unavailable: ${error.message}`);
    }
    let data;
    try {
      const envelope = await ctx.json(
        `${API}/streams/${path}?s=acme&list=1`,
        { ...apiHeaders, 'x-stream-ticket': ticket },
        { timeout: 20000 },
      );
      if (typeof envelope?.n !== 'string' || typeof envelope?.d !== 'string') throw new Error('no stream');
      data = JSON.parse(await (await getDeobfuscator())(envelope.n, envelope.d));
    } catch (error) {
      if (/build changed|deobfuscator aborted|Unexpected token/i.test(error.message)) {
        throw new Error(`MeowTV envelope failed to decrypt (site build may have changed): ${error.message}`);
      }
      throw new Error(`MeowTV has no stream for ${subject}: ${error.message}`);
    }
    const streams = Array.isArray(data?.streams) ? data.streams.slice(0, MAX_STREAMS) : [];
    if (!streams.length) throw new Error(`MeowTV has no stream for ${subject}`);
    // Every entry is the same requested title/episode in a different
    // language. Try them in the site's order, best-first, through the
    // central validation gate; each entry carries the CDN Referer its media
    // requires.
    const serverErrors = {};
    let last = 'MeowTV returned no usable stream';
    for (const stream of streams) {
      ctx.signal?.throwIfAborted();
      const url = typeof stream?.url === 'string' ? stream.url : '';
      if (!/^https?:\/\//i.test(url)) continue;
      const referer = typeof stream?.headers?.Referer === 'string' && stream.headers.Referer
        ? stream.headers.Referer
        : `${SITE_ORIGIN}/`;
      const source = `meowtv/${stream?.language || 'stream'}`;
      try {
        return { ...(await ctx.accept(url, { referer }, source)), server_errors: serverErrors };
      } catch (error) {
        last = error.message;
        serverErrors[source] = last;
      }
    }
    throw new Error(`MeowTV has no playable stream for ${subject}: ${last}`);
  };
}
