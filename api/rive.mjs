// Rive (www.rivestream.app) — movie and TV-episode sources resolved through
// its public scrapper API. TMDB ids map 1:1 into the mirror catalog; mirrors
// return plain HLS whose media hosts require the site referer.
import { httpURL } from './providers.mjs';

const API = 'https://scrapper.rivestream.app';
const ORIGIN = 'https://www.rivestream.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API_HEADERS = { 'user-agent': UA, accept: 'application/json, text/plain, */*' };
const MEDIA_HEADERS = { 'user-agent': UA, referer: `${ORIGIN}/` };
const API_TIMEOUT = 20000;
// Bounded mirror order from the live provider catalog (2026-11-14 integration
// evidence): mirrors with verified playable TS first, then the remaining
// catalog mirrors, which the central validator still checks per request.
const UPSTREAMS = ['primevids', 'citadel', 'valiant', 'sentinel', 'rift', 'apogee', 'electra', 'lumen', 'pulse'];

function qualityRank(quality) {
  const label = String(quality || '');
  const match = /(\d{3,4})p/i.exec(label);
  if (match) return Number(match[1]);
  if (/cloud/i.test(label)) return 1080;
  return 0;
}

export function createRiveResolver() {
  return async function rive(input, ctx) {
    const type = input.kind === 'series' ? 'tv' : 'movie';
    const errors = {};
    for (const upstream of UPSTREAMS) {
      ctx.signal.throwIfAborted();
      try {
        const query = new URLSearchParams({ provider: upstream, id: String(input.tmdb) });
        if (type === 'tv') { query.set('season', input.season); query.set('episode', input.episode); }
        const data = await ctx.json(`${API}/api/provider?${query}`, API_HEADERS, { timeout: API_TIMEOUT });
        const candidates = (Array.isArray(data?.data?.sources) ? data.data.sources : [])
          .filter(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url) && !/[\r\n]/.test(s.url))
          .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
        if (!candidates.length) throw new Error('no sources');
        for (const candidate of candidates.slice(0, 4)) {
          ctx.signal.throwIfAborted();
          const quality = String(candidate.quality || '').split(' | ')[0].trim();
          try {
            return await ctx.accept(httpURL(candidate.url), MEDIA_HEADERS, `${upstream}/${quality || 'source'}`);
          } catch (e) {
            errors[`${upstream}/${quality || 'source'}`] = e.message;
          }
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        errors[upstream] = e.message;
      }
    }
    throw new Error(`Rive has no playable source for this title: ${Object.values(errors).slice(-3).join('; ')}`);
  };
}
