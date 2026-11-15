// Movy (www.movy.sx) — VOD movie and TV-episode sources.
// The site's stream API (api.wecollege.net) answers /<city>/sources with a
// base64url payload that is XOR-decrypted with a PRNG keystream derived from
// a per-media seed (GET /seed?mediaId=) and the TMDB id, prefixed by the
// "mov1" magic. The cipher below is a verbatim port of the site's public
// Next.js module 8311; no credentials, cookies, or stored secrets are
// required — the upstream edge only wants the movy.sx Origin/Referer.
// Detail metadata (title, year, IMDb id, season count) comes from
// db.wecollege.net/3/<mediaType>/<tmdbId>, so a TMDB id alone resolves.

const ORIGIN = 'https://www.movy.sx';
const API_ORIGIN = 'https://api.wecollege.net';
const DB_ORIGIN = 'https://db.wecollege.net';
const CITY = 'miami';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const apiHeaders = { 'user-agent': UA, origin: ORIGIN, referer: `${ORIGIN}/`, accept: 'application/json, text/plain, */*' };
const media = { 'user-agent': UA, referer: `${ORIGIN}/` };
const API_TIMEOUT = 15000;

// ---- verbatim cipher primitives (module 8311) ----
const d = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174];
const MAGIC = [109, 118, 109, 49]; // "mov1"
const r = e => (e * (e + 1) & 1) === 0;
function o(e) { e >>>= 0; e ^= e >>> 16; e = Math.imul(e, 0x85ebca6b) >>> 0; e ^= e >>> 13; e = Math.imul(e, 0xc2b2ae35) >>> 0; return (e ^= e >>> 16) >>> 0; }
function u(e, a) { return (e >>>= 0, 0 === (a &= 31)) ? e >>> 0 : (e << a | e >>> 32 - a) >>> 0; }

export function movyKeystream(seed, mediaId, length) {
  const s = function (e, a) {
    let t;
    if (((t = e.length) * (t + 1) & 1) === 1)
      return {
        S: function (e) {
          let a = Array(256); for (let e = 0; e < 256; e++) a[e] = e;
          let t = 0; for (let s = 0; s < 256; s++) { t = t + a[s] + e.charCodeAt(s % e.length) & 255; let n = a[s]; a[s] = a[t]; a[t] = n; }
          return a;
        }(e),
        acc: function (e) {
          let a = 0x67452301;
          for (let t = 0; t < e.length; t++) a = u((a ^ Math.imul(e.charCodeAt(t), d[15 & t])) >>> 0, 5);
          return o(a);
        }(e)
      };
    const s = Array(61);
    let n = o(function (e) { let a = 0x811c9dc5; for (let t = 0; t < e.length; t++) a = Math.imul(a ^ e.charCodeAt(t), 0x1000193) >>> 0; return o(a); }(e) ^ o(a >>> 0 ^ 0x9e3779b9)) >>> 0;
    for (let e = 0; e < 8; e++) if (r(e)) { let a = n % 61; n = u(n + 0x9e3779b9 >>> 0, 7 + (7 & e)); s[a] = (n ^ o(n)) >>> 0; n = o(n + a >>> 0); } else s[e] = d[15 & e];
    return { S: s, acc: o(0xa5a5a5a5 ^ n) >>> 0 };
  }(seed, mediaId);
  const out = new Uint8Array(length);
  let l = 0;
  for (let e = 0; e < length;) {
    const a = function (e, a) {
      let n = e.S, l = e.acc, d2 = l % 61, idx = 0 - Number(d2 in n), rr = n[d2] >>> 0, c = Math.imul(0x9e3779b9, a + 1) >>> 0;
      const tt = l, ss = (rr ^ c) >>> 0;
      let b = ((tt ^ ss) >>> 0 | (tt & ss & idx) >>> 0) >>> 0;
      l = o((b = (u(b + l >>> 0, 31 & d2) ^ u(l, 31 & Math.imul(d2, 7))) >>> 0) + 0x9e3779b9 >>> 0);
      n[d2] = l >>> 0; e.acc = l; return l >>> 0;
    }(s, l++);
    out[e++] = 255 & a;
    if (e < length) out[e++] = a >>> 8 & 255;
    if (e < length) out[e++] = a >>> 16 & 255;
    if (e < length) out[e++] = a >>> 24 & 255;
  }
  return out;
}

export function decryptMovyPayload(payload, seed, mediaId) {
  const raw = String(payload).trim().replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(String(payload).trim().length / 4), '=');
  const n = new Uint8Array(Buffer.from(raw, 'base64'));
  const ks = movyKeystream(seed, mediaId, n.length);
  for (let e = 0; e < n.length; e++) n[e] ^= ks[e];
  for (let e = 0; e < MAGIC.length; e++) if (n[e] !== MAGIC[e]) throw new Error('Movy payload did not decrypt (bad seed or tampered payload)');
  return new TextDecoder('utf-8').decode(n.subarray(MAGIC.length));
}

// ---- adapter ----
function qualityRank(quality) {
  const match = String(quality || '').match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : 0;
}

export function createMovyResolver() {
  const seedCache = new Map();
  return async function movy(input, ctx) {
    const type = input.kind === 'series' ? 'tv' : 'movie';
    const tmdb = input.tmdb;
    const detail = await ctx.json(`${DB_ORIGIN}/3/${type}/${tmdb}`, apiHeaders, { timeout: API_TIMEOUT });
    // Guard against a different title being served for the requested id.
    if (detail?.id !== tmdb) throw new Error('Movy returned a different title for this TMDB id');
    const body = {
      title: encodeURIComponent(type === 'tv' ? (detail.original_name || detail.name || '') : (detail.original_title || detail.title || '')),
      mediaType: type,
      year: String(type === 'tv' ? (detail.first_air_date || '') : (detail.release_date || '')).slice(0, 4),
      totalSeasons: type === 'tv' ? detail.number_of_seasons : undefined,
      episodeId: type === 'tv' ? input.episode : undefined,
      seasonId: type === 'tv' ? input.season : undefined,
      tmdbId: tmdb,
      imdbId: detail.imdb_id || undefined,
    };
    async function getSeed() {
      const hit = seedCache.get(String(tmdb));
      if (hit && hit.expiresAt - 5000 > Date.now()) return hit.seed;
      const data = await ctx.json(`${API_ORIGIN}/seed?mediaId=${tmdb}`, apiHeaders, { timeout: API_TIMEOUT });
      if (!data?.seed) throw new Error('Movy seed response is missing its seed');
      seedCache.set(String(tmdb), { seed: String(data.seed), expiresAt: Date.now() + (Number(data.ttlMs) || 30000) });
      while (seedCache.size > 32) seedCache.delete(seedCache.keys().next().value);
      return String(data.seed);
    }
    async function getSources(seed) {
      const parts = [];
      for (const [key, value] of Object.entries({ ...body, enc: '2', seed })) {
        if (value === undefined || value === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      const raw = (await ctx.read(`${API_ORIGIN}/${CITY}/sources?${parts.join('&')}`, apiHeaders, { timeout: API_TIMEOUT })).bytes.toString('utf8').trim();
      return decryptMovyPayload(raw.startsWith('"') ? JSON.parse(raw) : raw, seed, tmdb);
    }
    let seed = await getSeed();
    let text;
    try {
      text = await getSources(seed);
    } catch (error) {
      // The site refreshes the seed when the upstream rejects a rotated one.
      if (String(error.message) !== 'HTTP 401') throw error;
      seedCache.delete(String(tmdb));
      seed = await getSeed();
      text = await getSources(seed);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Movy sources payload is not JSON'); }
    const candidates = (Array.isArray(data.sources) ? data.sources : [])
      .filter(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url) && !/[\r\n]/.test(s.url))
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
      .slice(0, 4);
    if (!candidates.length) throw new Error('Movy has no source for this title');
    const errors = {};
    for (const candidate of candidates) {
      ctx.signal?.throwIfAborted();
      const label = `movy/${candidate.quality || 'source'}`;
      try { return await ctx.accept(candidate.url, media, label); }
      catch (error) { errors[label] = error.message; }
    }
    throw new Error('Movy has no playable source for this title: ' + Object.values(errors).slice(-3).join('; '));
  };
}
