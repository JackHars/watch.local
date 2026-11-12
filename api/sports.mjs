// Port of /workspace/sports/sports_api.py, inspected in hermes-a6b133b6.
// Runs inside the LAN service; Docker and a second API listener are not needed.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { createSportsPlayback } from './sports-playback.mjs';
import { createSportsStatus } from './sports-status.mjs';

export const SPORTS = { nba: 'NBA', nfl: 'NFL', nhl: 'NHL', mlb: 'MLB', cfb: 'College Football', soccer: 'Soccer', mma: 'MMA', boxing: 'Boxing', wwe: 'WWE', f1: 'Formula 1', cfl: 'CFL' };
const HOSTS = ['streameasto.cx', 'streamseast.ws', 'streamking.cx'];
const ARTWORK_HOSTS = [...HOSTS, 'r2.thesportsdb.com', 'www.thesportsdb.com'];
export const sportsArtworkOrigins = ARTWORK_HOSTS.map(host => `https://${host}`);
export function sportsArtworkURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !ARTWORK_HOSTS.includes(url.hostname)) return '';
    if (!(HOSTS.includes(url.hostname) ? url.pathname.startsWith('/img/') : url.pathname.startsWith('/images/media/'))) return '';
    return url.href;
  } catch { return ''; }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const categoryID = sport => String(1000 + Object.keys(SPORTS).indexOf(sport));
const fail = (status, message) => Object.assign(new Error(message), { status });
const seconds = now => Math.floor(now() / 1000);
const plain = value => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim();
export const xml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
function unescapeHTML(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, code) => {
    if (code[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[code.toLowerCase()];
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
function absolute(value, base) {
  if (!String(value || '').trim()) return null;
  try { const url = new URL(unescapeHTML(value).replaceAll('\\/', '/'), base); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
export function eventStatus(event, now = Date.now) {
  if (event.always_live) return 'LIVE';
  const verified = event.broadcast_status;
  if (verified && now() - verified.checkedAt < 180000 && ['ENDED', 'LIVE', 'UPCOMING'].includes(verified.state)) return verified.state;
  const time = seconds(now);
  return event.ends_at > 0 && time >= event.ends_at ? 'ENDED' : event.starts_at > time ? 'UPCOMING' : event.starts_at > 0 ? 'LIVE' : 'UNKNOWN';
}
export function parseSportsEvent(page, { host, sport, slug }) {
  const match = page.match(/\bvar\s+sd\s*=\s*(\{[^\n]*?\})\s*;/);
  if (!match) throw new Error('Event page contains no sports metadata.');
  const sd = JSON.parse(match[1]);
  const pageURL = `https://${host}/live/${slug}`;
  const players = sportsPlayers(page, pageURL, sd.e);
  const title = page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '') || slug.split('/').at(-1).replaceAll('-', ' ');
  const icon = page.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1];
  return { host, sport, slug, title: plain(unescapeHTML(title)), icon: absolute(icon || '', pageURL) || '', starts_at: Number(sd.starts_at) || 0, ends_at: Number(sd.ends_at) || 0, always_live: Number(sd.always_live) === 1, has_payload: players.length > 0, stream_url: players[0] || null, stream_urls: players, pageURL };
}

function sportsPlayers(page, base, encoded) {
  const $ = load(page), urls = [];
  // Event directories now publish Watch links instead of an embedded player.
  // Follow the designated controls only, not advertisements or arbitrary links.
  for (const value of [encoded, ...$('#player-container[data-e], .stream-btn[data-e]').map((_, e) => $(e).attr('data-e')).get()]) {
    if (!value) continue;
    const payload = Buffer.from(Buffer.from(value, 'base64').map(byte => byte ^ 0x4f)).toString('utf8');
    urls.push(payload.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)/i)?.[1] || payload.match(/(?:https?:)?\/\/[^\s"'<>]+/)?.[0]);
  }
  urls.push(...$('.links-table a.watch-btn[href]').map((_, e) => $(e).attr('href')).get());
  return [...new Set(urls.map(url => absolute(url, base)).filter(Boolean))].slice(0, 8);
}

async function textResponse(response, limit = 2 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Sports source returned HTTP ${response.status}.`); }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Sports response is too large.'); chunks.push(chunk); }
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}
async function pool(items, work, concurrency = 3) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => { while (next < items.length) { const i = next++; result[i] = await work(items[i]); } }));
  return result;
}

export function createSportsSource({ fetchResource = fetch, hosts = HOSTS } = {}) {
  let active = 0; const waiting = [];
  async function get(url, referer, options = {}) {
    if (active >= 4) await new Promise(resolve => waiting.push(resolve)); else active++;
    try {
      const headers = { 'User-Agent': UA, Accept: 'text/html,application/vnd.apple.mpegurl,*/*', ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
      const response = await fetchResource(url, { ...options, headers, signal: AbortSignal.timeout(options.timeout || 15000) });
      return { text: await textResponse(response), url: response.url || url, headers };
    } finally { if (waiting.length) waiting.shift()(); else active--; }
  }
  async function event(host, sport, slug) {
    return parseSportsEvent((await get(`https://${host}/live/${slug}`, `https://${host}/${sport}`)).text, { host, sport, slug });
  }
  const playback = createSportsPlayback({ request: get });
  return {
    media: playback.media,
    status: createSportsStatus({ request: get }),
    async list(sport) {
      let last;
      for (const host of hosts) {
        try {
          const { text } = await get(`https://${host}/${sport}`);
          const slugs = [...new Set([...text.matchAll(new RegExp(`/live/${sport}/(\\d{4}-\\d{2}-\\d{2}/[a-z0-9-]+)`, 'g'))].map(m => `${sport}/${m[1]}`))].sort().slice(0, 24);
          const results = await pool(slugs, async slug => { try { return { event: await event(host, sport, slug) }; } catch (error) { return { error: error.message }; } }, 4);
          return { events: results.filter(r => r.event).map(r => r.event), errors: results.filter(r => r.error).map(r => r.error) };
        } catch (error) { last = error; }
      }
      throw last;
    },
    async resolve(record) {
      // Re-fetch at Play time: schedules can be published hours before player URLs.
      let latest, last;
      for (const host of [record.host, ...hosts.filter(host => host !== record.host)]) {
        try {
          const item = await event(host, record.sport, record.slug); latest ||= item;
          if (item.has_payload && item.stream_url) return item;
        } catch (error) { last = error; }
      }
      if (latest) return latest;
      throw last || new Error('The sports event is unavailable.');
    },
    async hls(item) {
      const queue = (item.stream_urls?.length ? item.stream_urls : [item.stream_url]).map(url => ({ url, referer: item.pageURL, depth: 0 })), visited = new Set();
      let last;
      while (queue.length && visited.size < 12) {
        const next = queue.shift(); if (!next.url || visited.has(next.url)) continue;
        visited.add(next.url);
        try {
          const result = await get(next.url, next.referer);
          if (result.text.trimStart().startsWith('#EXTM3U')) return { url: result.url, headers: { referer: next.referer, origin: new URL(next.referer).origin, 'user-agent': UA } };
          const controlled = await playback.resolve(result.text, result.url, next.referer);
          if (controlled) return { ...controlled, headers: { ...controlled.headers, 'user-agent': UA } };
          if (next.depth >= 4) continue;
          const page = unescapeHTML(result.text).replaceAll('\\/', '/').replaceAll('\\u0026', '&');
          const media = [...page.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi)].map(m => m[0]);
          const $ = load(result.text);
          const tags = $('iframe[src], source[src]').map((_, e) => $(e).attr('src')).get();
          const files = [...page.matchAll(/(?:file|src|url)\s*["']?\s*[:=]\s*["']([^"']+\.m3u8(?:\?[^"']*)?)/gi)].map(m => m[1]);
          const payload = result.text.match(/\bvar\s+sd\s*=\s*(\{[^\n]*?\})\s*;/)?.[1];
          let encoded; try { encoded = payload && JSON.parse(payload).e; } catch { /* Not an event metadata block. */ }
          const candidates = [...sportsPlayers(result.text, result.url, encoded), ...media, ...files, ...tags];
          if (payload && !candidates.length) last = fail(503, 'The sports source has not published a broadcast URL for this event yet.');
          for (const candidate of candidates) {
            const url = absolute(candidate, result.url);
            if (url) queue.push({ url, referer: result.url, depth: next.depth + 1 });
          }
        } catch (error) { last = error; }
      }
      throw fail(last?.status || 502, last?.message || 'This sports player does not expose a supported HLS broadcast.');
    },
  };
}

export function createSportsProvider({ directory, source = createSportsSource(), now = Date.now }) {
  let state = { nextId: 1, events: {}, updatedAt: null, errors: [] }, refreshing, saveQueue = Promise.resolve();
  const playing = new Map();
  async function updateStatus() {
    if (!source.status) return;
    const time = seconds(now);
    const events = Object.values(state.events).filter(e => e.listed && !e.always_live && e.starts_at <= time + 86400 && e.ends_at >= time - 21600);
    try {
      const statuses = await source.status(events);
      for (const event of events) if (state.events[event.slug]?.starts_at === event.starts_at) state.events[event.slug].broadcast_status = statuses.get(event.slug);
    } catch { /* Scoreboard availability must not prevent watching a live feed. */ }
  }
  const path = join(directory, 'sports.json');
  async function save() {
    const serialized = JSON.stringify(state);
    const operation = saveQueue.then(async () => { await writeFile(path + '.tmp', serialized, { mode: 0o600 }); await rename(path + '.tmp', path); });
    saveQueue = operation.catch(() => {}); return operation;
  }
  function listed() { return Object.values(state.events).filter(e => e.listed && eventStatus(e, now) !== 'ENDED' && e.lastSeen >= now() - 86400000).sort((a, b) => a.starts_at - b.starts_at || a.id - b.id); }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const errors = [];
      const results = await pool(Object.keys(SPORTS), async sport => {
        try { return { sport, ...(await source.list(sport)) }; } catch (error) { return { sport, events: [], errors: [error.message], failed: true }; }
      });
      for (const result of results) {
        for (const message of result.errors || []) errors.push({ sport: result.sport, message });
        if (result.failed) continue;
        // A partial scrape keeps old entries for the affected sport until expiry.
        if (!result.errors?.length) for (const event of Object.values(state.events)) if (event.sport === result.sport) event.listed = false;
        for (const event of result.events) {
          if (!SPORTS[event.sport] || !/^[a-z]+\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/.test(event.slug)) continue;
          const key = event.slug, previous = state.events[key];
          state.events[key] = { ...event, id: previous?.id || state.nextId++, added: previous?.added || String(seconds(now)), lastSeen: now(), listed: true };
        }
      }
      for (const [key, event] of Object.entries(state.events)) if (event.lastSeen < now() - 7 * 86400000) delete state.events[key];
      await updateStatus();
      state.updatedAt = now(); state.errors = errors; await save(); return listed();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function ensure() {
    if (!state.updatedAt) await refresh();
    else if (now() - state.updatedAt > 60000) refresh().catch(error => console.warn('Sports refresh:', error.message));
    await updateStatus();
    return listed();
  }
  function description(event) { return `${SPORTS[event.sport]} · ${event.title}. ${event.has_payload ? 'A player link is published; playback availability is checked when opened.' : 'The broadcaster has not published a playable feed yet.'}`; }
  const channelID = event => `sports-${event.id}`;
  const date = value => {
    // Xtream's unzoned date strings follow server_info.timezone; Unix times
    // below and XMLTV's explicit +0000 remain unambiguous across time zones.
    const d = new Date(value * 1000), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const xmlDate = value => new Date(value * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + ' +0000';
  return {
    async initialize() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    refresh, ensure,
    status() { const events = listed(); return { events: events.length, inProgress: events.filter(e => eventStatus(e, now) === 'LIVE').length, withPlayer: events.filter(e => e.has_payload).length, updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null, refreshing: Boolean(refreshing), errors: state.errors }; },
    async categories() { const events = await ensure(); return Object.entries(SPORTS).filter(([sport]) => events.some(e => e.sport === sport)).map(([sport, name]) => ({ category_id: categoryID(sport), category_name: `Sports · ${name}`, parent_id: 0 })); },
    async rows(makeURL, category) {
      return (await ensure()).filter(e => !category || category === 'all' || categoryID(e.sport) === category).map((e, i) => ({ num: i + 1, name: `${SPORTS[e.sport]} · ${e.title}`, stream_type: 'live', stream_id: e.id, stream_icon: e.icon || '', epg_channel_id: channelID(e), added: e.added, category_id: categoryID(e.sport), custom_sid: '', tv_archive: 0, tv_archive_duration: 0, direct_source: makeURL(e.id), container_extension: 'm3u8' }));
    },
    async browserRows() {
      const priority = { LIVE: 0, UPCOMING: 1, UNKNOWN: 2 };
      return (await ensure()).map(e => ({ stream_id: e.id, name: `${SPORTS[e.sport]} · ${e.title}`, title: e.title,
        sport: e.sport, category_name: SPORTS[e.sport], artwork: sportsArtworkURL(e.icon),
        starts_at: e.starts_at, ends_at: e.ends_at, always_live: Boolean(e.always_live), status: eventStatus(e, now),
      })).sort((a,b) => priority[a.status] - priority[b.status] || a.starts_at - b.starts_at || a.stream_id - b.stream_id);
    },
    async epg(id) {
      await ensure(); const event = Object.values(state.events).find(e => e.id === Number(id));
      if (!event || !(event.starts_at > 0 && event.ends_at > event.starts_at)) return { epg_listings: [] };
      return { epg_listings: [{ id: String(event.id), epg_id: String(event.id), channel_id: channelID(event), title: Buffer.from(event.title).toString('base64'), description: Buffer.from(description(event)).toString('base64'), lang: 'en', start: date(event.starts_at), end: date(event.ends_at), start_timestamp: String(event.starts_at), stop_timestamp: String(event.ends_at), now_playing: eventStatus(event, now) === 'LIVE' ? 1 : 0, has_archive: 0 }] };
    },
    async xmltv() {
      const events = await ensure();
      const rows = ['<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="Cinejoy Sports">'];
      for (const e of events) rows.push(`<channel id="${channelID(e)}"><display-name>${xml(SPORTS[e.sport] + ' · ' + e.title)}</display-name>${e.icon ? `<icon src="${xml(e.icon)}"/>` : ''}</channel>`);
      for (const e of events) if (e.starts_at > 0 && e.ends_at > e.starts_at) rows.push(`<programme start="${xmlDate(e.starts_at)}" stop="${xmlDate(e.ends_at)}" channel="${channelID(e)}"><title lang="en">${xml(e.title)}</title><desc lang="en">${xml(description(e))}</desc><category lang="en">${xml(SPORTS[e.sport])}</category></programme>`);
      return rows.concat('</tv>', '').join('\n');
    },
    async resolve(id, { fresh = false } = {}) {
      await ensure(); const stored = Object.values(state.events).find(e => e.id === Number(id));
      if (!stored) throw fail(404, 'Sports event not found. Refresh Live TV in your IPTV app.');
      if (eventStatus(stored, now) === 'ENDED') throw fail(410, 'This sports event has ended.');
      const cached = playing.get(Number(id));
      // IPTV apps re-request their original URL every few seconds. Keep the
      // player context stable during viewing; its media credentials renew below.
      if (!fresh && cached && now() - cached.used < 120000) { cached.used = now(); return cached.stream; }
      const event = await source.resolve(stored);
      if (!event.has_payload || !event.stream_url) throw fail(503, eventStatus(event, now) === 'UPCOMING' ? 'This event has not started and its broadcast is not available yet.' : 'The sports source has not published a broadcast URL for this event yet.');
      const stream = await source.hls(event);
      if (stream.playback) {
        playing.set(Number(id), { stream, used:now() });
        while (playing.size > 100) playing.delete(playing.keys().next().value);
      }
      return stream;
    },
    media: (url, context) => source.media(url, context),
  };
}
