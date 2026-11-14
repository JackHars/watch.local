// Native port of the Hermes Strmfree API. No dependency on the developer's
// container, local port 8095, saved signatures, cookies or browser scripts.
import { isIP } from 'node:net';
import { probeSportsStream } from './sports-probe.mjs';

const MIRRORS = ['strmfree.pk', 'strmfree.st', 'streamfree.top'];
const DIRECTORY = 'https://strmfree.link/api/domains';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\bst[. ]/g, 'saint ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const aliases = { 'ul monroe': 'louisiana monroe', 'ul monroe warhawks': 'louisiana monroe', 'louisiana monroe warhawks': 'louisiana monroe', 'louisiana ragin cajuns': 'louisiana' };
const team = value => aliases[normalize(value)] || normalize(value);
function participants(title) { return String(title || '').split(/\s+(?:vs?\.?|versus|at|@)\s+/i).map(team); }
function teamScore(a, b, allowMascot) {
  if (a === b && a) return 1;
  // Allow a college mascot suffix, not arbitrary fuzzy city/name matches.
  if (allowMascot && a.length >= 5 && b.startsWith(a + ' ')) return 0.9;
  if (allowMascot && b.length >= 5 && a.startsWith(b + ' ')) return 0.9;
  return 0;
}
function compatible(event, candidate) {
  const category = String(candidate.category || '').toLowerCase(), league = normalize(candidate.league);
  const rules = { nba: ['basketball', /^nba$/], nhl: ['hockey', /^nhl$/], nfl: ['football', /^nfl$/], cfb: ['football', /^(ncaaf|ncaa football|college football)$/], cfl: ['football', /^cfl$/], mlb: ['baseball', /^mlb$/], soccer: ['soccer'], mma: ['combat', /^(ufc|mma|bellator|pfl)/], boxing: ['combat', /boxing/], wwe: ['combat', /wwe/], f1: ['racing', /^(f1|formula 1)$/] };
  const rule = rules[event.sport];
  return rule && rule[0] === category && (!rule[1] || rule[1].test(league));
}
export function matchStrmfreeEvent(event, candidates) {
  if (!Number.isFinite(event.starts_at) || event.starts_at <= 0 || event.always_live) return null;
  const wanted = participants(event.title);
  const matches = [];
  for (const candidate of candidates) {
    const delta = Math.abs(Number(candidate.match_timestamp) - event.starts_at);
    if (!Number.isFinite(delta) || delta > 90 * 60 || !compatible(event, candidate)) continue;
    const found = participants(candidate.name);
    let score = 0;
    if (wanted.length === 2 && found.length === 2) {
      const compare = (a, b) => teamScore(a, b, event.sport === 'cfb');
      score = Math.max(Math.min(compare(wanted[0], found[0]), compare(wanted[1], found[1])), Math.min(compare(wanted[0], found[1]), compare(wanted[1], found[0])));
    } else if (normalize(event.title) === normalize(candidate.name)) score = 1;
    if (score >= 0.9) matches.push({ candidate, score: score - delta / 100_000 });
  }
  matches.sort((a, b) => b.score - a.score);
  // Ambiguous fixtures are not interchangeable broadcasts.
  return matches.length && (matches.length === 1 || matches[0].score - matches[1].score > 0.02) ? matches[0].candidate : null;
}

function mediaURL(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname) || !url.hostname.includes('.') || /\.(?:local|lan|localhost)$/.test(url.hostname)) throw fail('Invalid Strmfree media address.');
  return url;
}
export function rawStrmfreeURL(value, base) {
  let url = mediaURL(value, base);
  if (url.hash.startsWith('#sf=')) {
    let raw; try { raw = decodeURIComponent(url.hash.slice(4).split('|')[0]).trim(); } catch { throw fail('Invalid Strmfree video reference.'); }
    url = mediaURL(raw, 'https://cdn1.strmfree.st/');
  }
  if (/(^|\.)ttcdn[^.]*\./i.test(url.hostname)) throw fail('Strmfree has not published a raw video fallback for this stream.');
  url.hash = ''; return url.href;
}
function headersFor(url, player) {
  // The .pk mirror works for playlists but is rejected by the raw CDN.
  const referer = /^cdn\d*\.strmfree\.st$/i.test(new URL(url).hostname) ? 'https://strmfree.st/' : player;
  return { 'user-agent': UA, referer, origin: new URL(referer).origin };
}

export function createStrmfreeSource({ fetchResource = fetch, now = Date.now, mirrors = MIRRORS, directoryURL = DIRECTORY } = {}) {
  let hosts = [...mirrors], mirrorsAt = 0, catalog = null, listing, refreshingMirrors, error = '';
  const streams = new Map();
  async function request(url, signal, headers = {}) {
    const response = await fetchResource(url, { headers: { 'user-agent': UA, ...headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail(`Strmfree returned HTTP ${response.status}.`); }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fail('Strmfree response is too large.'); chunks.push(chunk); }
    return { text: Buffer.concat(chunks).toString('utf8'), url: response.url || url };
  }
  async function refreshMirrors(signal) {
    if (!directoryURL || now() - mirrorsAt < 3600000) return;
    if (refreshingMirrors) return refreshingMirrors;
    refreshingMirrors = (async () => {
      try {
        const list = JSON.parse((await request(directoryURL, signal)).text);
        const valid = Array.isArray(list) ? list.map(value => String(value).replace(/^https:\/\//, '').replace(/\/$/, '')).filter(host => /^(?:strmfree|streamfree)\.[a-z]{2,12}$/.test(host)) : [];
        if (valid.length) hosts = [...new Set([...valid, ...mirrors])].slice(0, 6);
      } catch { /* Keep the known mirrors when the directory is unavailable. */ }
      mirrorsAt = now();
    })().finally(() => { refreshingMirrors = null; });
    return refreshingMirrors;
  }
  async function fromMirror(path, parse, signal, preferred) {
    let last;
    for (const host of [...new Set([preferred, ...hosts].filter(Boolean))]) {
      signal?.throwIfAborted();
      try { const result = await request(`https://${host}${path}`, signal); return { value: parse(result.text), host, url: result.url }; }
      catch (error) { last = error; }
    }
    throw last || fail('No Strmfree mirror is available.');
  }
  async function events({ signal, fresh = false } = {}) {
    if (!fresh && catalog && now() - catalog.at < 60000) return catalog.events;
    if (listing) return listing;
    listing = (async () => {
      try {
        await refreshMirrors(signal);
        const { value } = await fromMirror('/streams', text => {
          const data = JSON.parse(text); if (!data.streams || typeof data.streams !== 'object') throw fail('The Strmfree catalog is invalid.');
          return Object.entries(data.streams).flatMap(([category, rows]) => Array.isArray(rows) ? rows.filter(row => /^[a-z0-9-]{1,180}$/.test(row.stream_key || '') && typeof row.name === 'string').map(row => ({ key: row.stream_key, name: row.name.slice(0, 240), category: row.category || category, league: row.league || '', match_timestamp: Number(row.match_timestamp) || 0 })) : []);
        }, signal);
        catalog = { events: value, at: now() }; error = ''; return value;
      } catch (cause) { error = 'Strmfree is temporarily unavailable.'; if (catalog && now() - catalog.at < 300000 && !signal?.aborted) return catalog.events; throw cause; }
    })().finally(() => { listing = null; });
    return listing;
  }
  async function open(candidate, { signal, fresh = false } = {}) {
    signal ||= AbortSignal.timeout(20000);
    if (!/^[a-z0-9-]{1,180}$/.test(candidate.key || '') || !/^[a-z]{2,24}$/.test(candidate.category || '')) throw fail('Invalid Strmfree event.');
    const key = candidate.key;
    let cached = streams.get(key);
    if (!fresh && cached?.stream && now() < cached.expires) return cached.stream;
    if (cached?.pending) return cached.pending;
    cached ||= {}; streams.set(key, cached);
    while (streams.size > 100) streams.delete(streams.keys().next().value);
    cached.pending = (async () => {
      await refreshMirrors(signal);
      let last;
      // A working catalog does not mean this mirror serves working video.
      // Keep signatures, player headers and video checks on the same mirror,
      // and only cache a feed after its media bytes have passed preflight.
      for (const host of hosts) {
        signal.throwIfAborted();
        const mirrorSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
        try {
          const origin = `https://${host}`;
          const info = JSON.parse((await request(origin + '/get-stream-key/' + key, mirrorSignal)).text);
          if (!info || typeof info !== 'object' || Array.isArray(info)) throw fail('Invalid Strmfree stream details.');
          const player = `${origin}/player/${candidate.category}/${key}`;
          let targets = null;
          if (!info.is_external) {
            // The sign table includes offline renditions. Prefer the source
            // list used by the upstream player, including numbered backups.
            let published;
            try { published = JSON.parse((await request(origin + '/api/v1/sources/' + key, mirrorSignal)).text); }
            catch { mirrorSignal.throwIfAborted(); /* Older mirrors lack this endpoint. */ }
            if (published?.stream_key === key && Array.isArray(published.sources)) {
              targets = published.sources.filter(row => row.live === true).flatMap(row => {
                try {
                  const path = new URL(row.url, origin).pathname;
                  const prefix = `/embed/${candidate.category}/${key}`;
                  if (!path.startsWith(prefix)) return [];
                  const match = path.slice(prefix.length).match(/^(2160p|1080p|720p|540p)(_[a-z0-9-]{1,24})?$/);
                  return match ? [{ quality: match[1], suffix: match[2] || '' }] : [];
                } catch { return []; }
              });
              if (!targets.length) throw fail('Strmfree has not published live video for this event yet.', 503);
              targets.sort((a, b) => Number.parseInt(b.quality) - Number.parseInt(a.quality));
            }
          }
          const accept = async (url, player, expiry) => {
            const manifest = await request(url, mirrorSignal, headersFor(url, player));
            if (!manifest.text.trimStart().startsWith('#EXTM3U')) throw fail('Strmfree did not return an HLS stream.');
            for (const line of manifest.text.split(/\r?\n/)) if (line.trim() && !line.startsWith('#')) rawStrmfreeURL(line.trim(), manifest.url);
            const stream = { url: manifest.url, headers: headersFor(manifest.url, player), playback: { provider: 'strmfree', key, category: candidate.category, player, root: manifest.url } };
            // Resolve raw segment references directly here: calling source.media
            // would wait on this same in-flight open() and deadlock.
            await probeSportsStream(stream, { fetchResource, signal: mirrorSignal, media: async value => {
              const target = rawStrmfreeURL(value, manifest.url);
              return { url: target, headers: headersFor(target, player) };
            } });
            cached.stream = stream; cached.expires = expiry; return stream;
          };
          if (info.is_external) return await accept(mediaURL(info.external_url).href, player, now() + 60000);
          targets ||= ['1080p', '720p', '540p'].map(quality => ({ quality, suffix: '' }));
          const tables = new Map();
          const prefixes = info.server_name === 'origin' || !info.server_name ? ['live'] : ['live-cdn', 'live', ...(info.server_name === 'externalcdn' ? ['live-externalcdn'] : [])];
          let renditionError;
          for (const target of targets) {
            mirrorSignal.throwIfAborted();
            try {
              let embed = tables.get(target.suffix);
              if (!embed) {
                const result = await request(`${origin}/embed/${candidate.category}/${key}${target.quality}${target.suffix}`, mirrorSignal);
                const encoded = result.text.match(/\bconst\s+_0x\s*=\s*(\{[\s\S]*?\})\s*;/)?.[1];
                if (!encoded) throw fail('Strmfree has no broadcast yet.');
                embed = { table: JSON.parse(encoded), url: result.url }; tables.set(target.suffix, embed);
              }
              const params = embed.table[target.quality];
              if (!params?._t || !(Number(params._e) * 1000 > now() + 30000)) continue;
              for (const prefix of prefixes) {
                mirrorSignal.throwIfAborted();
                try {
                  const url = `${origin}/${prefix}/${key}${target.quality}${target.suffix}/index.m3u8?` + new URLSearchParams(Object.fromEntries(['_t', '_e', '_n'].map(name => [name, String(params[name] || '')])));
                  return await accept(url, embed.url, Math.min(now() + 30 * 60_000, Number(params._e) * 1000 - 30000));
                } catch (error) { renditionError = error; }
              }
            } catch (error) { renditionError = error; }
          }
          throw renditionError || fail('Strmfree returned expired or unavailable stream details.');
        } catch (error) { last = error; }
      }
      signal.throwIfAborted();
      throw last || fail('Strmfree has no playable broadcast for this event.', 503);
    })().finally(() => { cached.pending = null; });
    return cached.pending;
  }
  const source = {
    events, open, validatesStreams: true,
    status: () => ({ events: catalog?.events.length || 0, updatedAt: catalog?.at || null, error }),
    async resolve(event, options = {}) {
      const candidate = matchStrmfreeEvent(event, await events(options));
      if (!candidate) throw fail('Strmfree has no matching broadcast for this event.', 503);
      return open(candidate, options);
    },
    async media(url, context) {
      const current = await open({ key: context.key, category: context.category });
      let target = rawStrmfreeURL(url, context.root);
      if (url === context.root) target = current.url;
      else if (target.startsWith(new URL('.', context.root).href)) target = new URL(target.slice(new URL('.', context.root).href.length), new URL('.', current.url)).href;
      return { url: target, headers: headersFor(target, current.playback.player), playback: current.playback };
    },
    verify: (stream, options) => probeSportsStream(stream, { ...options, fetchResource, media: source.media }),
  };
  return source;
}
