// Dulo (https://dulo.mov) — zcluster ZCDN worker-edge movie/episode resolver.
//
// Chain (all keyless plain HTTPS on the Cloudflare workers edge; verified 2026-11-15):
//   1. GET https://dulo.mov/dulo-config.js
//      -> window.__CONFIG__ advertising the live WORKER_DOMAIN. The domain rotates
//         between workers edge namespaces (retired-history list in the site's own
//         /dulo-worker-rewrite.js), so the config is the source of truth on every call.
//   2. GET https://zcdn1|2|3.<WORKER_DOMAIN>/cdn?tmdb=<id>&type=movie|tv[&season=&episode=]
//      -> { ready: true, url: "<zcdnN host>/play/<token>/<suffix>" }.
//      No auth, no cookies, no ticket. The per-request signed /play/<token>/ path is
//      rotated per /cdn call and never stored; the site's optional ?_rb badge round
//      trip is not required by the worker, so it is not used.
//   3. <url> -> master HLS (4 ladder levels, avc1+mp4a, no non-NONE keys)
//      -> VOD media playlist: #EXT-X-MAP init (ftyp isom) + ~6 s fMP4 segments
//      (moof+mdat; the worker mislabels fragment content-type as image/png — bytes
//      are validated, not content-type).
//
// Bounded candidate fanout: the three zcdn subdomains are tried in order; the first
// ready answer wins. A { ready:false } answer (the cluster queues unknown titles)
// fails that host honestly and the central resolver falls back to the next provider.
// The central ctx.accept validates the master ladder, the MAP init, and the first
// fMP4 segment (moof at bytes 4..8) before anything is returned.

const SITE = 'https://dulo.mov/';
const ORIGIN = 'https://dulo.mov';
// Last verified WORKER_DOMAIN (2026-11-15 probe). Used only if the live config
// stops advertising a domain; the config fetch is always tried first.
const FALLBACK_WORKER_DOMAIN = 'c3204a347-edge.workers.dev';
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,8}$/;

function workerDomainFromConfig(text) {
  const match = text.match(/WORKER_DOMAIN:\s*'([a-z0-9.-]+)'/) || text.match(/WORKER_DOMAIN\s*=\s*"([a-z0-9.-]+)"/);
  return (match?.[1] || match?.[2] || '').toLowerCase();
}

function assertWorkerDomain(value) {
  if (!DOMAIN_SHAPE.test(value)) throw new Error('Dulo worker domain is unavailable from its live config');
  return value;
}

export function createDuloResolver() {
  return async function dulo(input, ctx) {
    const h = { origin: ORIGIN, referer: SITE };
    const config = await ctx.text(`${SITE}dulo-config.js`, h);
    const domain = assertWorkerDomain(workerDomainFromConfig(config) || FALLBACK_WORKER_DOMAIN);
    const type = input.kind === 'series' ? 'tv' : 'movie';
    const query = `tmdb=${input.tmdb}&type=${type}` + (type === 'tv' ? `&season=${input.season}&episode=${input.episode}` : '');
    const errors = {};
    for (const n of [1, 2, 3]) {
      ctx.signal.throwIfAborted();
      const host = `zcdn${n}.${domain}`;
      try {
        const data = await ctx.json(`https://${host}/cdn?${query}`, h);
        if (data?.ready !== true || typeof data.url !== 'string') {
          throw new Error(`cdn not ready (${data?.status || 'no status'})`);
        }
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid cdn url');
        return await ctx.accept(url.href, h, 'dulo');
      } catch (e) {
        errors[host] = e.message;
      }
    }
    throw new Error(Object.entries(errors).map(([host, message]) => `${host}: ${message}`).join('; '));
  };
}
