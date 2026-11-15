import { createHash, createDecipheriv } from 'node:crypto';

// FlickyStream (https://flickystream.mov) — TMDB-backed movie/TV front end;
// playback is resolved through the site's own API at
// https://api.flickystream.mov. There is no public catalog JSON: content is
// addressed directly by TMDB id (site pages /play/movie/<id>, /play/tv/<id>;
// API paths /streams/movie/<id> and /streams/tv/<id>/<season>/<episode>).
//
// FlickyStream is a rebranded clone of the MeowTV cluster: same codebase
// family and the same geffe448mik.com media CDN (the app bundle even migrates
// localStorage from the meowtv.* namespace), but it has its own API host, its
// own Origin gate, its own build key material, and a deobfuscator WASM that
// takes both envelope fields: deobfuscate(n, d).
//
// Resolver chain (re-verified live 2026-11-15):
//   1. POST /streams/ticket (Origin: https://flickystream.mov, body {})
//        -> { ticket }  — tickets are single-use; one is minted per
//                         encrypted request.
//      GET /streams/{movie|tv}/...?s=acme&list=1 (x-stream-ticket header)
//        -> { n, d }    — encrypted envelope of the stream list.
//   2. The envelope is decrypted by the site's own deobfuscator WASM:
//        key  = concat(base64(p0..p3)) XOR SHA-256(env)
//        wasm = AES-256-CTR(key, counter=V (full 16 bytes), C)  (wasm-bindgen)
//        json = wasm.deobfuscate(n, d)
//      -> { streams: [{ language, url, headers }] }
//      A zero-extended low-64 counter (WebCrypto `length:64`) decrypts to
//      garbage on this build; the full 16-byte counter is required.
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

const API = 'https://api.flickystream.mov';
const SITE_ORIGIN = 'https://flickystream.mov';
const MAX_STREAMS = 8;

// Public build constants extracted from the site's own published Vite bundles
// (see source.build). They are shipped to every browser visitor of
// flickystream.mov — public protocol data, not credentials. They rotate only
// when the site rebuilds those assets: the size guards below then throw
// "build changed" and the provider fails honestly instead of playing wrong
// media.
// Re-extraction: load any /play/ page in a browser, fetch and import the
// s-*.js chunks, and read their p / C / V exports.
const KEY_MATERIAL = {
  "source": {
    "build": "flickystream.mov Vite build serving /assets/s-k0-zC51wlXF.js, /assets/s-k1-CBdpio2D.js, /assets/s-k2-Un7gvRgU.js, /assets/s-k3-DiTPfoAW.js, /assets/s-p-Db499fZ6.js, /assets/s-core-Drx_6DPr.js",
    "extraction": "executed the site's own unmodified chunk modules in a real Chromium tab (flickystream.mov/play/movie/27205); each chunk exports p (base64) after its anti-environment shuffle completes; s-p exports C (AES-CTR ciphertext of the deobfuscator WASM) and V (16-byte CTR counter)",
    "extracted_at": "2026-11-15T11:40:00+00:00",
    "nature": "public client-side build constants shipped to every visitor of this site's own bundles; not credentials. FlickyStream is a rebranded clone of the MeowTV cluster (same codebase, own api.flickystream.mov API); this build's constants differ from meowtv.ru's. Stale only when this site rebuilds these assets."
  },
  "p": [
    "cARV2FiqSmE=",
    "i+BhQChzTQU=",
    "APrnnKGRwJg=",
    "XZLzXG6jzGk="
  ],
  "C": "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",
  "V": "He+4IzT1S/ez1cXBWLhRQg==",
  "env": "objectobjectstringfunction",
  "key_derivation": "key[32] = concat(p0..p3 decoded)[32] XOR sha256(env)  -- env is the deterministic string 'objectobjectstringfunction' (typeof window + typeof document + typeof navigator.userAgent + typeof crypto.subtle.digest in any real browser)"
};

const b64Decode = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// Exported so tests can pin the shape guard.
export async function flickystreamKey(material) {
  const parts = Array.isArray(material?.p) ? material.p : [];
  const raw = new Uint8Array(32);
  let length = 0;
  for (const part of parts) {
    const bytes = b64Decode(String(part));
    raw.set(bytes, length);
    length += bytes.length;
  }
  if (length !== 32) throw new Error('FlickyStream build changed — key material no longer matches the live site');
  const env = typeof material.env === 'string' && material.env ? material.env : 'objectobjectstringfunction';
  const mask = new Uint8Array(createHash('sha256').update(env).digest());
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = raw[i] ^ mask[i];
  return key;
}

let deobfuscatorPromise = null;
// Assembles the site's own deobfuscator WASM from the committed key material.
// Exported so tests can verify the committed material still builds the module.
export function buildFlickystreamDeobfuscator() {
  if (!deobfuscatorPromise) deobfuscatorPromise = (async () => {
    const key = await flickystreamKey(KEY_MATERIAL);
    const C = b64Decode(KEY_MATERIAL.C);
    const V = b64Decode(KEY_MATERIAL.V);
    if (C.length < 16 || V.length !== 16) throw new Error('FlickyStream build changed — key material no longer matches the live site');
    // Full 16-byte CTR counter, exactly as this build's client uses it.
    const decipher = createDecipheriv('aes-256-ctr', Buffer.from(key), Buffer.from(V));
    const wasmBytes = new Uint8Array(Buffer.concat([decipher.update(Buffer.from(C)), decipher.final()]));
    // \0asm magic, compared numerically (Uint8Array#toString takes no encoding)
    if (wasmBytes.length < 4 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
      throw new Error('FlickyStream build changed — deobfuscator no longer a WASM module');
    }
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, {
      env: { abort: () => { throw new Error('FlickyStream deobfuscator aborted'); } },
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
    // This build's deobfuscate takes both raw envelope fields (it derives
    // the per-envelope key from n internally).
    return (n, d) => strFrom(instance.exports.deobfuscate(strTo(n), strTo(d)) >>> 0);
  })().catch((error) => { deobfuscatorPromise = null; throw error; });
  return deobfuscatorPromise;
}

let deobfuscatorOverride = null;
/** Test seam: substitute the envelope deobfuscator (default: the site's own WASM). */
export function setFlickystreamDeobfuscator(fn) {
  deobfuscatorOverride = fn ? Promise.resolve(fn) : null;
}
function getDeobfuscator() {
  return deobfuscatorOverride || buildFlickystreamDeobfuscator();
}

export function createFlickystreamResolver() {
  return async function flickystream(input, ctx) {
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
      throw new Error(`FlickyStream ticket unavailable: ${error.message}`);
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
      if (/build changed|deobfuscator aborted|no longer a WASM|Unexpected token/i.test(error.message)) {
        throw new Error(`FlickyStream envelope failed to decrypt (site build may have changed): ${error.message}`);
      }
      throw new Error(`FlickyStream has no stream for ${subject}: ${error.message}`);
    }
    const streams = Array.isArray(data?.streams) ? data.streams.slice(0, MAX_STREAMS) : [];
    if (!streams.length) throw new Error(`FlickyStream has no stream for ${subject}`);
    // Every entry is the same requested title/episode in a different
    // language. Try them in the site's order, best-first, through the
    // central validation gate; each entry carries the CDN Referer its media
    // requires.
    const serverErrors = {};
    let last = 'FlickyStream returned no usable stream';
    for (const stream of streams) {
      ctx.signal?.throwIfAborted();
      const url = typeof stream?.url === 'string' ? stream.url : '';
      if (!/^https?:\/\//i.test(url)) continue;
      const referer = typeof stream?.headers?.Referer === 'string' && stream.headers.Referer
        ? stream.headers.Referer
        : `${SITE_ORIGIN}/`;
      const source = `flickystream/${stream?.language || 'stream'}`;
      try {
        return { ...(await ctx.accept(url, { referer }, source)), server_errors: serverErrors };
      } catch (error) {
        last = error.message;
        serverErrors[source] = last;
      }
    }
    throw new Error(`FlickyStream has no playable stream for ${subject}: ${last}`);
  };
}
