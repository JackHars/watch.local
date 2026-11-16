// BingeBang (https://bingebang.sx) — ticketed, encrypted MPEG-TS movie/episode resolver.
//
// Chain (live-verified 2026-11-15, evidence artifact 91ef04783869):
//   movie: GET /api/movie/<tmdb> -> {id, media_type:'movie', play_url:'/movie/play/<slug>'}
//          (plain JSON; the id is the TMDB id itself)
//   series: catalog title -> GET /api/search/multi?query=<title> -> TV candidates
//          (site-internal ids, /tv/play/<slug> play_url) -> GET /tv/play/<slug>/<s>/<e>
//   play page -> inline IIFE: 7-byte repeating XOR (key array k in the same script)
//          -> decoded text sets window.__BB_PLAYER__
//          {ticket (short-lived, one-shot per fetch), mediaId, mediaType, imdb,
//            season, episode, segmentsTmdb, title, sourcesUrl}
//   GET <sourcesUrl> [X-BB-Player: 1, X-BB-Ticket: <ticket>]
//          -> {"enc":...}; decrypt(enc, deriveKey(__BBKEY, ticket))
//          -> {ok, servers: [{name, source_url (iCdn top)}]}  (rotating pool, failover)
//   GET <resolve>?src=<iCdn top> [same headers] -> {ok, url (iCdn top), type, ...}
//   iCdn top -> one-shot 302 -> short-TTL signed master -> variants
//          -> MPEG-TS segments (0x47 at every 188-byte offset)
//
// Identity: a movie payload must have mediaId === input TMDB; an episode payload
// must have segmentsTmdb === input TMDB and the same season/episode. A mismatched
// candidate is never substituted: the adapter walks candidates in order and only
// reports failure when none matches, so the central resolver falls through to the
// next provider.
//
// The iCdn CDN rejects requests without the site's Origin/Referer, so the shared
// accept chain is passed https://bingebang.sx headers for every media hop. The
// CDN rate-limits (HTTP 429 with Retry-After); one bounded backoff is retried per
// request, then the provider fails fast rather than hammering the edge.
// bb-crypto.mjs is a verbatim copy of the site's published player crypto scope.
import './bb-crypto.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const BBC = globalThis.BBCrypto;
const KEY = globalThis.__BBKEY;
if (!BBC?.decrypt || !BBC?.deriveKey || !BBC?.encrypt || typeof KEY !== 'string' || !KEY) {
  throw new Error('BingeBang player crypto extract failed to initialize');
}

const ORIGIN = 'https://bingebang.sx';
const SITE = { origin: ORIGIN, referer: `${ORIGIN}/` };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const H = { 'user-agent': UA, ...SITE, accept: 'application/json' };
const RATE_LIMITED = 'BingeBang is rate-limited; retry shortly';

function siteUrl(path) {
  return path?.startsWith('http') ? path : `${ORIGIN}${path || '/'}`;
}

function xorDecode(data, key) {
  let out = '';
  for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i] ^ key[i % key.length]);
  return out;
}

export function payloadFromPage(html) {
  const match = String(html).match(/<script[^>]*>\s*\(function\(\)\{var k=(\[[\d,]+\]),d=(\[[\d,]+\])/s);
  if (!match) throw new Error('BingeBang play page has no player payload');
  let decoded;
  try { decoded = xorDecode(JSON.parse(match[2]), JSON.parse(match[1])); }
  catch { throw new Error('BingeBang player payload is unreadable'); }
  // This text comes from a live site. Its object also contains executable
  // methods, but the resolver only needs these literal identity and routing
  // fields. Never evaluate the decoded JavaScript in the server process.
  if (decoded.length > 16384) throw new Error('BingeBang player payload format changed');
  const prefix = decoded.match(/^\s*window\.__BB_PLAYER__\s*=\s*\{([\s\S]*?)(?:,\s*resolve\s*:\s*function\b|}\s*;\s*$)/)?.[1];
  if (!prefix) throw new Error('BingeBang player payload format changed');
  const field = (name, type, required = true) => {
    const string = String.raw`"(?:\\.|[^"\\])*"`;
    const number = String.raw`(?:0|[1-9][0-9]*)`;
    const literal = type === 'string' ? string : type === 'number' ? number : `(?:${string}|${number})`;
    const matches = [...prefix.matchAll(new RegExp(String.raw`(?:^|[,\n])\s*(?:"${name}"|${name})\s*:\s*(${literal})\s*(?=,|$)`, 'g'))];
    if (!required && matches.length === 0) return undefined;
    if (matches.length !== 1) throw new Error('BingeBang player payload format changed');
    try { return JSON.parse(matches[0][1]); }
    catch { throw new Error('BingeBang player payload is unreadable'); }
  };
  const payload = {
    ticket: field('ticket', 'string'),
    mediaType: field('mediaType', 'string'),
    mediaId: field('mediaId', 'number'),
    segmentsTmdb: field('segmentsTmdb', 'id', false),
    season: field('season', 'number', false),
    episode: field('episode', 'number', false),
    sourcesUrl: field('sourcesUrl', 'string', false),
  };
  if (!payload || typeof payload.ticket !== 'string' || payload.ticket.length < 32 || payload.ticket.length > 512) {
    throw new Error('BingeBang player payload is invalid');
  }
  return payload;
}

function decryptEnvelope(body, ticket, label) {
  if (body && typeof body.enc === 'string') {
    const plain = BBC.decrypt(body.enc, BBC.deriveKey(KEY, ticket));
    if (typeof plain !== 'string' || !plain.trim()) throw new Error(`BingeBang ${label} envelope would not decrypt`);
    try { body = JSON.parse(plain); }
    catch { throw new Error(`BingeBang ${label} envelope is not JSON`); }
  }
  return body;
}

export function createBingebangResolver(getCatalogData, { rateLimitDelayMs = 3000 } = {}) {
  async function getJson(ctx, url, ticket = '') {
    ctx.signal?.throwIfAborted();
    const headers = ticket ? { ...H, 'x-bb-player': '1', 'x-bb-ticket': ticket } : H;
    try {
      return await ctx.json(url, headers);
    } catch (error) {
      // The central read already burned one 429 retry; one more bounded backoff,
      // then fail fast so other providers can serve the request.
      if (error?.message !== 'HTTP 429' || rateLimitDelayMs <= 0) throw error;
      ctx.signal?.throwIfAborted();
      await delay(rateLimitDelayMs, undefined, { signal: ctx.signal });
      try {
        return await ctx.json(url, headers);
      } catch (retry) {
        if (retry?.message === 'HTTP 429') throw new Error(RATE_LIMITED);
        throw retry;
      }
    }
  }

  async function playWithTicket(ctx, payload) {
    const sourcesPath = payload.sourcesUrl || '/api/player/sources';
    const resolvePath = sourcesPath.replace(/\/sources$/, '/resolve');
    const sources = decryptEnvelope(await getJson(ctx, siteUrl(sourcesPath), payload.ticket), payload.ticket, 'sources');
    if (sources?.ok === false || !Array.isArray(sources?.servers) || !sources.servers.length) {
      throw new Error('BingeBang returned no servers');
    }
    const errors = {};
    for (const server of sources.servers.slice(0, 6)) {
      ctx.signal?.throwIfAborted();
      const name = String(server?.name || server?.label || server?.id || 'server');
      const top = typeof server?.source_url === 'string' ? server.source_url : '';
      if (!top) continue;
      try {
        const resolved = decryptEnvelope(
          await getJson(ctx, `${ORIGIN}${resolvePath}?src=${encodeURIComponent(top)}`, payload.ticket),
          payload.ticket,
          `resolve ${name}`,
        );
        if (resolved?.ok === false || typeof resolved.url !== 'string') {
          throw new Error(`BingeBang ${name} resolve has no stream`);
        }
        const url = new URL(resolved.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('BingeBang returned an unsafe stream URL');
        return { ...(await ctx.accept(url.href, { ...SITE, 'user-agent': UA }, 'bingebang')), server: name };
      } catch (error) {
        if (error?.message === RATE_LIMITED) throw error;
        errors[name] = error?.message || 'unavailable';
      }
    }
    throw new Error(Object.entries(errors).map(([name, message]) => `${name}: ${message}`).join('; ') || 'BingeBang returned no servers');
  }

  async function movie(tmdb, ctx) {
    ctx.signal?.throwIfAborted();
    const meta = decryptEnvelope(await getJson(ctx, `${ORIGIN}/api/movie/${tmdb}`), '', 'movie');
    if (meta?.ok === false || meta?.media_type !== 'movie' || String(meta?.id) !== String(tmdb) || typeof meta?.play_url !== 'string') {
      throw new Error(`BingeBang has no movie ${tmdb}`);
    }
    const payload = payloadFromPage(await ctx.text(siteUrl(meta.play_url), H));
    if (payload.mediaType !== 'movie' || String(payload.mediaId) !== String(tmdb)) {
      throw new Error('BingeBang returned a different movie');
    }
    return await playWithTicket(ctx, payload);
  }

  async function series(tmdb, season, episode, ctx) {
    ctx.signal?.throwIfAborted();
    const meta = await getCatalogData(`/tv/${tmdb}`, {}).catch(() => null);
    const title = meta?.name || meta?.title || meta?.original_name;
    if (!title) throw new Error(`No catalog title for TMDB ${tmdb}`);
    const found = decryptEnvelope(await getJson(ctx, `${ORIGIN}/api/search/multi?query=${encodeURIComponent(title)}`), '', 'search');
    const candidates = (Array.isArray(found?.results) ? found.results : [])
      .filter(item => item?.media_type === 'tv' && typeof item?.play_url === 'string' && item.play_url.startsWith('/tv/play/'))
      .slice(0, 8);
    if (!candidates.length) throw new Error(`BingeBang has no series ${tmdb}`);
    const errors = {};
    for (const candidate of candidates) {
      ctx.signal?.throwIfAborted();
      const label = String(candidate?.name || candidate?.play_url);
      let payload;
      try {
        const page = await ctx.text(siteUrl(candidate.play_url) + `/${season}/${episode}`, H);
        payload = payloadFromPage(page);
      } catch (error) {
        if (error?.message === RATE_LIMITED) throw error;
        errors[label] = error?.message || 'unavailable';
        continue;
      }
      if (payload.mediaType !== 'episode' || String(payload.segmentsTmdb) !== String(tmdb) ||
        Number(payload.season) !== season || Number(payload.episode) !== episode) {
        errors[label] = 'identity mismatch';
        continue;
      }
      return await playWithTicket(ctx, payload);
    }
    throw new Error(Object.entries(errors).map(([label, message]) => `${label}: ${message}`).join('; ') || `BingeBang has no series ${tmdb}`);
  }

  return async function bingebang(input, ctx) {
    const tmdb = Number(input?.tmdb);
    if (!Number.isSafeInteger(tmdb) || tmdb <= 0) throw new Error('BingeBang requires a valid TMDB id');
    if (input?.kind === 'series') {
      const season = Number(input.season);
      const episode = Number(input.episode);
      if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) {
        throw new Error('BingeBang requires a valid season and episode');
      }
      return await series(tmdb, season, episode, ctx);
    }
    return await movie(tmdb, ctx);
  };
}
