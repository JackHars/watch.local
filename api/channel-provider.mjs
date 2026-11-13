import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { xml } from './sports.mjs';
import { channelCategories, channelMetadata, channelArtwork } from './channel-metadata.mjs';
const problem = (status, message) => Object.assign(new Error(message), { status });
const category = channel => channelMetadata(channel).category_id;
const xmlDate = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + ' +0000';
const localDate = seconds => {
  const d = new Date(seconds * 1000), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function createChannelProvider({ directory, source, provider, label, idBase, defaultHeaders = {}, now = Date.now }) {
  const channelID = channel => `${provider}-${channel.key}`;
  const file = join(directory, `${provider}.json`), playing = new Map(), pending = new Map();
  let state = { ids: {}, nextId: idBase, channels: [], guide: {}, updatedAt: 0, guideAt: 0 };
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
        } else { error = results[0].reason?.message || `${label} channel list is unavailable.`; retryAt = now() + 30000; }
      }
      if (guideDue && results[1].status === 'fulfilled' && results[1].value) { state.guide = results[1].value; state.guideAt = now(); }
      else if (guideDue && source.guide) retryAt = now() + 30000;
      else if (guideDue) state.guideAt = now();
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
        const resolved = { ...result, playback: { provider, channel: channel.key, source: key, root: result.url } };
        playing.set(channel.key, { stream: resolved, at: now() });
        while (playing.size > 100) playing.delete(playing.keys().next().value);
        return resolved;
      } catch (e) { last = e; }
      throw problem(502, `${label} could not open ${channel.name}. ${last?.message || 'Try again shortly.'}`);
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
      const present = new Set(rows.map(category));
      return channelCategories.filter(c => present.has(c.iptv)).map(c => ({ category_id: c.iptv, category_name: c.name, parent_id: 0 }));
    },
    async rows(makeURL, filter) {
      return (await ensure()).filter(c => !filter || filter === 'all' || category(c) === filter).map((c, i) => ({ num: i + 1, name: channelMetadata(c).title, stream_type: 'live', stream_id: c.id,
        stream_icon: channelArtwork(c, makeURL(c.id)), epg_channel_id: channelID(c), added: String(Math.floor(state.updatedAt / 1000)), category_id: category(c), custom_sid: '',
        tv_archive: 0, tv_archive_duration: 0, direct_source: makeURL(c.id), container_extension: 'm3u8' }));
    },
    async browserRows() {
      return (await ensure()).map(c => {
        const current = programs(c).find(p => p.start <= now() / 1000 && p.stop > now() / 1000);
        const meta = channelMetadata(c);
        return { stream_id: c.id, name: meta.title, title: meta.title, channel_name: meta.name, search_name: c.name, provider, kind: 'channel', category_id: `tv-${meta.category}`,
          category: meta.category, category_name: meta.category_name, artwork: channelArtwork(c), artwork_kind: 'logo', white_logo: meta.white_logo, logo_plate: meta.logo_plate,
          accent: meta.accent, quality: c.quality, region: meta.region, country: meta.country, topics: meta.topics,
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
    async xmltv(base) {
      const rows = ['<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="watch.local">'];
      const channels = await ensure();
      for (const channel of channels) rows.push(`<channel id="${xml(channelID(channel))}"><display-name>${xml(channelMetadata(channel).title)}</display-name>${channelArtwork(channel, base) ? `<icon src="${xml(channelArtwork(channel, base))}"/>` : ''}</channel>`);
      for (const channel of channels) {
        for (const p of programs(channel)) rows.push(`<programme start="${xmlDate(p.start)}" stop="${xmlDate(p.stop)}" channel="${xml(channelID(channel))}"><title>${xml(p.title)}</title><desc>${xml(p.description)}</desc><category>${xml(channelMetadata(channel).category_name)}</category></programme>`);
      }
      return rows.concat('</tv>', '').join('\n');
    },
    async resolve(id, options) {
      const channel = (await ensure()).find(c => c.id === Number(id));
      if (!channel) throw problem(404, `${label} channel not found. Refresh Live TV.`);
      return stream(channel, options);
    },
    async media(url, context) {
      const channel = (await ensure()).find(c => c.key === context.channel);
      if (!channel || !channel.sources.includes(context.source)) throw problem(404, `${label} channel is no longer available.`);
      const current = url === context.root ? await stream(channel, { preferred: context.source }) : playing.get(channel.key)?.stream;
      const from = new URL('.', context.root).href, to = current ? new URL('.', current.url).href : from;
      const target = url === context.root && current ? current.url : url.startsWith(from) ? to + url.slice(from.length) : url;
      return { url: target, headers: { ...defaultHeaders, ...current?.headers }, playback: { ...context, ...current?.playback } };
    },
  };
}
