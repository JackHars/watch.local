import { publicFetch } from './public-fetch.mjs';
import { probeSportsStream } from './sports-probe.mjs';

const API = 'https://testscore.pxxl.pro';
const HEADERS = {
  origin: 'https://scorezonetv.live',
  referer: 'https://scorezonetv.live/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const SPORTS = { nba: 'basketball', nhl: 'hockey', nfl: 'american-football', cfb: 'american-football', mlb: 'baseball', soccer: 'soccer' };
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const clean = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const participants = title => String(title || '').split(/\s+(?:vs?\.?|versus|at|@)\s+/i).map(clean);
const teamMatches = (wanted, found, sport) => wanted === found || sport === 'cfb' && (found.startsWith(wanted + ' ') || wanted.startsWith(found + ' '));

function startTime(value) {
  const s = String(value || '');
  if (!/^\d{14}$/.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}
function names(event) {
  return [event.T1?.[0]?.Nm || event.T1?.Nm, event.T2?.[0]?.Nm || event.T2?.Nm];
}
function leagueMatches(sport, stage) {
  const league = clean(stage.CompN || stage.Cnm || stage.Snm);
  if (sport === 'nba') return league === 'nba';
  if (sport === 'nhl') return league === 'nhl';
  if (sport === 'mlb') return league === 'mlb';
  if (sport === 'nfl') return league === 'nfl';
  if (sport === 'cfb') return /^(?:ncaa|college football)/.test(league);
  return true;
}

export function matchScorezoneEvent(event, stages) {
  if (!SPORTS[event.sport] || !(event.starts_at > 0)) return null;
  const wanted = participants(event.title);
  if (wanted.length !== 2 || !wanted.every(Boolean)) return null;
  const matches = [];
  for (const stage of stages || []) {
    if (!leagueMatches(event.sport, stage)) continue;
    for (const candidate of stage.Events || []) {
      const [home, away] = names(candidate), found = [clean(home), clean(away)];
      const timestamp = startTime(candidate.Esd);
      if (!candidate.Eid || !found.every(Boolean) || !Number.isFinite(timestamp) || Math.abs(timestamp / 1000 - event.starts_at) > 90 * 60) continue;
      const direct = teamMatches(wanted[0], found[0], event.sport) && teamMatches(wanted[1], found[1], event.sport);
      const reversed = teamMatches(wanted[0], found[1], event.sport) && teamMatches(wanted[1], found[0], event.sport);
      if (direct || reversed) matches.push({ id: String(candidate.Eid), home, away, start: timestamp, competition: String(stage.CompN || stage.Cnm || ''), sport: SPORTS[event.sport] });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function mediaURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9-]+\.scorezone\.workers\.dev$/i.test(url.hostname) || !/^\/hls\/[^/]+\/index\.m3u8$/.test(url.pathname)) throw fail('ScoreZone returned an unsupported video address.');
  return url.href;
}

export function createScorezoneSource({ fetchResource = publicFetch, now = Date.now, probe = probeSportsStream } = {}) {
  const streams = new Map();
  let lastError = '', checkedAt = null;
  async function json(url, { method = 'GET', body, signal } = {}) {
    const response = await fetchResource(url, { method, headers: { ...HEADERS, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail(`ScoreZone returned HTTP ${response.status}.`); }
    const length = Number(response.headers.get('content-length'));
    if (length > 2 * 1024 * 1024) { await response.body?.cancel(); throw fail('ScoreZone response is too large.'); }
    const chunks = []; let total = 0;
    for await (const chunk of response.body) { total += chunk.length; if (total > 2 * 1024 * 1024) throw fail('ScoreZone response is too large.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('ScoreZone returned invalid JSON.'); }
  }
  async function match(event, signal) {
    const date = new Date(event.starts_at * 1000).toISOString().slice(0, 10).replaceAll('-', '');
    const data = await json(`${API}/api/livescore/${SPORTS[event.sport]}/${date}`, { signal });
    const found = matchScorezoneEvent(event, data.Stages);
    if (!found) throw fail('ScoreZone has no matching event.', 503);
    return found;
  }
  async function channels(meta, signal) {
    const query = new URLSearchParams({ home: meta.home, away: meta.away, sport: meta.sport, eventId: meta.id, start: String(meta.start), competition: meta.competition });
    const data = await json(`${API}/api/matches/channels?${query}`, { signal });
    if (!data?.key || !Array.isArray(data.channels)) throw fail('ScoreZone has no broadcast for this game.', 503);
    return data;
  }
  async function open(meta, channelId, { signal, fresh = false, listing } = {}) {
    const key = `${meta.id}:${channelId}`;
    const cached = streams.get(key);
    if (!fresh && cached && now() < cached.expires) return cached.stream;
    const current = listing || await channels(meta, signal);
    if (!current.channels.some(row => row.id === channelId && !row.locked)) throw fail('ScoreZone broadcast is no longer available.', 503);
    const data = await json(`${API}/api/matches/playback`, { method: 'POST', body: { matchKey: current.key, channelId }, signal });
    const url = mediaURL(data?.url);
    const stream = { url, headers: HEADERS, playback: { provider: 'scorezone', root: url, scorezoneMeta: meta, channelId } };
    await probe(stream, { fetchResource, signal });
    streams.set(key, { stream, expires: now() + 4 * 60_000 });
    while (streams.size > 100) streams.delete(streams.keys().next().value);
    return stream;
  }
  return {
    validatesStreams: true,
    status: () => ({ checkedAt, error: lastError }),
    async resolve(event, { signal, fresh = false } = {}) {
      if (!SPORTS[event.sport]) throw fail('ScoreZone does not cover this sport.', 503);
      try {
        const meta = await match(event, signal), listing = await channels(meta, signal);
        let last;
        for (const row of listing.channels.filter(row => !row.locked && /^[a-z0-9-]{1,100}$/i.test(row.id)).slice(0, 4)) {
          signal?.throwIfAborted();
          try { const stream = await open(meta, row.id, { signal, fresh, listing }); checkedAt = now(); lastError = ''; return stream; }
          catch (error) { last = error; }
        }
        throw last || fail('ScoreZone has no unlocked broadcast for this game.', 503);
      } catch (error) { lastError = error.message; checkedAt = now(); throw error; }
    },
    async media(url, context) {
      if (url !== context.root) return { url, headers: HEADERS, playback: context };
      return open(context.scorezoneMeta, context.channelId);
    },
  };
}
