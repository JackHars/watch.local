import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveZlive, zliveHeaders, zliveOrigin } from './zlive-resolver.mjs';
import { xml } from './sports.mjs';

export const ZLIVE_ID_BASE = 1000000000;
const groups = ['Entertainment', 'Sports', 'F1', 'Kids', 'Other'];
const problem = (status, message) => Object.assign(new Error(message), { status });
const keyOK = key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(key);
const clean = value => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300);
const category = channel => String(2000 + groups.indexOf(channel.group));
const channelID = channel => `zlive-${channel.key}`;
const xmlDate = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + ' +0000';
const localDate = seconds => {
  const d = new Date(seconds * 1000), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function readResponse(response, limit = 8 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw problem(502, `ZLive returned HTTP ${response.status}.`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw problem(502, 'ZLive response is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createZliveSource({ fetchResource = fetch, resolve = resolveZlive } = {}) {
  const get = url => fetchResource(url, { headers: zliveHeaders, signal: AbortSignal.timeout(12000) }).then(readResponse);
  return {
    async list() {
      const data = JSON.parse(await get(zliveOrigin + '/channels.json'));
      const rows = Array.isArray(data) ? data : data.channels;
      if (!Array.isArray(rows) || !rows.length) throw problem(502, 'ZLive has no channel catalog available.');
      const channels = new Map();
      for (const row of rows) {
        const sources = [...new Set((row.sources || []).map(s => s.key).filter(keyOK))];
        if (!keyOK(row.id) || !clean(row.name) || !sources.length) continue;
        channels.set(row.id, { key: row.id, name: clean(row.name), group: groups.includes(row.sport) ? row.sport : 'Other',
          quality: clean(row.quality), region: clean(row.region), live: row.live !== false,
          accent: /^#[\da-f]{6}$/i.test(row.accent) ? row.accent : '#648bd9', sources: sources.slice(0, 8) });
      }
      if (!channels.size) throw problem(502, 'ZLive returned an invalid channel catalog.');
      return [...channels.values()];
    },
    async guide() {
      const data = JSON.parse(await get(zliveOrigin + '/epg.json'));
      if (!Array.isArray(data.channels)) throw problem(502, 'ZLive guide is unavailable.');
      return Object.fromEntries(data.channels.filter(c => keyOK(c.id)).map(c => [c.id, [c.now, c.next].filter(Boolean).map(p => ({
        title: clean(p.title), description: clean(p.desc), start: Date.parse(p.start) / 1000, stop: Date.parse(p.stop) / 1000,
      })).filter(p => p.title && Number.isFinite(p.start) && Number.isFinite(p.stop) && p.stop > p.start)]));
    },
    async resolve(key) {
      const url = await resolve(key, { fetchResource });
      const manifest = await get(url);
      if (!manifest.trimStart().startsWith('#EXTM3U')) throw problem(502, 'ZLive did not return a live playlist.');
      return { url, headers: zliveHeaders };
    },
  };
}

export function createZliveProvider({ directory, source = createZliveSource(), now = Date.now }) {
  const file = join(directory, 'zlive.json'), playing = new Map(), pending = new Map();
  let state = { ids: {}, nextId: ZLIVE_ID_BASE, channels: [], guide: {}, updatedAt: 0, guideAt: 0 };
  let refreshing, retryAt = 0, error = null, saveQueue = Promise.resolve();
  const save = () => {
    const text = JSON.stringify(state);
    const operation = saveQueue.then(async () => { await writeFile(file + '.tmp', text, { mode: 0o600 }); await rename(file + '.tmp', file); });
    saveQueue = operation.catch(() => {}); return operation;
  };
  async function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    if (!force && now() < retryAt) return;
    const catalogDue = force || !state.updatedAt || now() - state.updatedAt >= 3600000;
    const guideDue = force || !state.guideAt || now() - state.guideAt >= 300000;
    if (!catalogDue && !guideDue) return;
    refreshing = (async () => {
      const results = await Promise.allSettled([catalogDue ? source.list() : null, guideDue && source.guide ? source.guide() : null]);
      if (catalogDue) {
        if (results[0].status === 'fulfilled' && results[0].value) {
          state.channels = results[0].value.map(channel => {
            state.ids[channel.key] ||= ++state.nextId;
            return { ...channel, id: state.ids[channel.key] };
          });
          state.updatedAt = now(); error = null;
        } else { error = results[0].reason?.message || 'ZLive channel list is unavailable.'; retryAt = now() + 30000; }
      }
      if (guideDue && results[1].status === 'fulfilled' && results[1].value) { state.guide = results[1].value; state.guideAt = now(); }
      else if (guideDue) retryAt = now() + 30000;
      await save();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function ensure() {
    if (!state.channels.length) await refresh();
    else refresh().catch(() => {});
    return state.channels;
  }
  const programs = channel => (state.guide[channel.key] || []).filter(p => p.stop > now() / 1000 - 3600 && p.start < now() / 1000 + 86400);
  async function stream(channel, { fresh = false, preferred } = {}) {
    if (pending.has(channel.key)) return pending.get(channel.key);
    const cached = playing.get(channel.key);
    if (!fresh && cached && now() - cached.at < 60000) return cached.stream;
    const work = (async () => {
      let last;
      const keys = [...new Set([preferred, ...channel.sources].filter(k => channel.sources.includes(k)))];
      for (const key of keys) try {
        const result = await source.resolve(key);
        const resolved = { ...result, playback: { provider: 'zlive', channel: channel.key, source: key, root: result.url } };
        playing.set(channel.key, { stream: resolved, at: now() });
        while (playing.size > 100) playing.delete(playing.keys().next().value);
        return resolved;
      } catch (e) { last = e; }
      throw problem(502, `ZLive could not open ${channel.name}. ${last?.message || 'Try again shortly.'}`);
    })().finally(() => pending.delete(channel.key));
    pending.set(channel.key, work); return work;
  }
  return {
    async initialize() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    ensure, refresh,
    status: () => ({ channels: state.channels.length, updatedAt: state.updatedAt || null, refreshing: Boolean(refreshing), error }),
    async categories() {
      const rows = await ensure();
      return groups.filter(group => rows.some(c => c.group === group)).map(group => ({ category_id: String(2000 + groups.indexOf(group)), category_name: `ZLive · ${group}`, parent_id: 0 }));
    },
    async rows(makeURL, filter) {
      return (await ensure()).filter(c => !filter || filter === 'all' || category(c) === filter).map((c, i) => ({ num: i + 1, name: c.name, stream_type: 'live', stream_id: c.id,
        stream_icon: '', epg_channel_id: channelID(c), added: String(Math.floor(state.updatedAt / 1000)), category_id: category(c), custom_sid: '',
        tv_archive: 0, tv_archive_duration: 0, direct_source: makeURL(c.id), container_extension: 'm3u8' }));
    },
    async browserRows() {
      return (await ensure()).map(c => {
        const current = programs(c).find(p => p.start <= now() / 1000 && p.stop > now() / 1000);
        return { stream_id: c.id, name: c.name, title: c.name, provider: 'zlive', kind: 'channel', category_id: `zlive-${c.group.toLowerCase()}`,
          category_name: c.group === 'F1' ? 'Formula 1' : c.group, artwork: '', accent: c.accent, quality: c.quality, region: c.region,
          starts_at: current?.start || 0, ends_at: current?.stop || 0, always_live: true, status: c.live ? 'LIVE' : 'UNKNOWN', program: current?.title || '' };
      }).sort((a, b) => a.title.localeCompare(b.title));
    },
    async epg(id) {
      const channel = (await ensure()).find(c => c.id === Number(id));
      return { epg_listings: channel ? programs(channel).map((p) => ({ id: `${channel.id}-${p.start}`, epg_id: String(channel.id), channel_id: channelID(channel),
        title: Buffer.from(p.title).toString('base64'), description: Buffer.from(p.description).toString('base64'), lang: 'en',
        start: localDate(p.start), end: localDate(p.stop), start_timestamp: String(p.start), stop_timestamp: String(p.stop),
        now_playing: p.start <= now() / 1000 && p.stop > now() / 1000 ? 1 : 0, has_archive: 0 })) : [] };
    },
    async xmltv() {
      const rows = ['<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="watch.local">'];
      const channels = await ensure();
      for (const channel of channels) rows.push(`<channel id="${xml(channelID(channel))}"><display-name>${xml(channel.name)}</display-name></channel>`);
      for (const channel of channels) {
        for (const p of programs(channel)) rows.push(`<programme start="${xmlDate(p.start)}" stop="${xmlDate(p.stop)}" channel="${xml(channelID(channel))}"><title>${xml(p.title)}</title><desc>${xml(p.description)}</desc><category>${xml(channel.group)}</category></programme>`);
      }
      return rows.concat('</tv>', '').join('\n');
    },
    async resolve(id, options) {
      const channel = (await ensure()).find(c => c.id === Number(id));
      if (!channel) throw problem(404, 'ZLive channel not found. Refresh Live TV.');
      return stream(channel, options);
    },
    async media(url, context) {
      const channel = (await ensure()).find(c => c.key === context.channel);
      if (!channel || !channel.sources.includes(context.source)) throw problem(404, 'ZLive channel is no longer available.');
      const current = url === context.root ? await stream(channel, { preferred: context.source }) : playing.get(channel.key)?.stream;
      const from = new URL('.', context.root).href, to = current ? new URL('.', current.url).href : from;
      const target = url === context.root && current ? current.url : url.startsWith(from) ? to + url.slice(from.length) : url;
      return { url: target, headers: zliveHeaders, playback: current?.playback || context };
    },
  };
}
