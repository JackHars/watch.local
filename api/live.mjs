import { createSportsProvider } from './sports.mjs';
import { createZliveProvider, ZLIVE_ID_BASE } from './zlive.mjs';
import { createTimstreamsProvider, TIMSTREAMS_ID_BASE } from './timstreams.mjs';
import { createStrmfreeSource } from './strmfree.mjs';
import { createScorezoneSource } from './scorezone.mjs';
import { createAurasportsSource } from './aurasports.mjs';
import { groupChannels, probeChannelStream } from './channel-groups.mjs';

// Existing sports IDs stay unchanged. Persistent TV channels occupy their own
// numeric range so Xtream clients can retain favorites across imports/restarts.
export function createLiveProvider({ directory, sportsSource, zliveSource, timstreamsSource, strmfreeSource = createStrmfreeSource(), scorezoneSource = createScorezoneSource(), aurasportsSource = createAurasportsSource(), probeChannel = probeChannelStream, getConfig = () => ({ sports: true, zlive: true, timstreams: true, strmfree: true, scorezone: true, aurasports: true }) }) {
  const providers = {
    sports: createSportsProvider({ directory, source: sportsSource, fallback: strmfreeSource, fallbackEnabled: () => getConfig().strmfree !== false,
      fallbacks: [{ id: 'scorezone', source: scorezoneSource, enabled: () => getConfig().scorezone !== false }, { id: 'aurasports', source: aurasportsSource, enabled: () => getConfig().aurasports !== false }] }),
    zlive: createZliveProvider({ directory, source: zliveSource }),
    timstreams: createTimstreamsProvider({ directory, source: timstreamsSource }),
  };
  const enabled = () => Object.entries(providers).filter(([id]) => getConfig()[id]);
  const providerFor = id => Number(id) >= TIMSTREAMS_ID_BASE ? 'timstreams' : Number(id) >= ZLIVE_ID_BASE ? 'zlive' : 'sports';
  const requireProvider = id => {
    if (!providers[id] || !getConfig()[id]) throw Object.assign(new Error('This live TV provider is disabled in Settings.'), { status: 403 });
    return providers[id];
  };
  async function gather(method, ...args) {
    const results = await Promise.allSettled(enabled().map(([, provider]) => provider[method](...args)));
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  }
  const selected = new Map(), resolving = new Map();
  const browserItems = async () => (await gather('browserRows')).flat().map(item => item.provider ? item : { ...item, provider: 'sports', kind: 'event', category_id: `sports-${item.sport}` });
  async function resolveChannel(id, options = {}, skip = []) {
    requireProvider(providerFor(id));
    const groups = groupChannels(await browserItems());
    const group = groups.find(g => g.members.some(row => row.stream_id === Number(id)));
    if (!group) return requireProvider(providerFor(id)).resolve(id, options);
    const cached = selected.get(group.key);
    if (!options.fresh && cached && Date.now() - cached.at < 60000 && group.members.some(r => r.stream_id === cached.id)) return { ...cached.stream, playback: { ...cached.stream.playback, requestedId: Number(id) } };
    const pendingKey = JSON.stringify([id, Boolean(options.fresh), skip, options.replace?.root]);
    if (resolving.has(pendingKey)) return resolving.get(pendingKey);
    const operation = (async () => {
      const failed = [...skip];
      const preferred = !options.fresh && cached ? cached.id : Number(id);
      const members = [...group.members].sort((a, b) => Number(b.stream_id === preferred) - Number(a.stream_id === preferred));
      for (const row of members) {
        if (failed.includes(row.stream_id)) continue;
        try {
          const replacing = options.replace?.memberId === row.stream_id;
          const result = await requireProvider(row.provider).resolve(row.stream_id, { ...options, excludeURL: replacing ? options.replace.root : undefined });
          if (members.length > 1) await probeChannel(result);
          const stream = { ...result, playback: { ...result.playback, requestedId: Number(id), group: group.key, memberId: row.stream_id, failedIds: failed,
            ...(replacing ? { rediscoveredAt: Date.now() } : {}) } };
          selected.set(group.key, { stream, at: Date.now(), id: row.stream_id });
          while (selected.size > 100) selected.delete(selected.keys().next().value);
          return stream;
        } catch { failed.push(row.stream_id); }
      }
      selected.delete(group.key);
      throw Object.assign(new Error(`No working feed is available for ${group.item.channel_name || group.item.title} right now. All matching sources were checked. Try again shortly.`), { status: 502 });
    })().finally(() => resolving.delete(pendingKey));
    resolving.set(pendingKey, operation); return operation;
  }
  return {
    initialize: () => Promise.all(Object.values(providers).map(p => p.initialize())),
    ensure: () => gather('ensure'),
    refresh: options => gather('refresh', options),
    status: () => ({ ...Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { enabled: Boolean(getConfig()[id]), ...p.status() }])), strmfree: { enabled: getConfig().strmfree !== false, ...strmfreeSource?.status?.() }, scorezone: { enabled: getConfig().scorezone !== false, ...scorezoneSource?.status?.() }, aurasports: { enabled: getConfig().aurasports !== false, ...aurasportsSource?.status?.() } }),
    categories: async () => [...new Map((await gather('categories')).flat().map(c => [c.category_id, c])).values()],
    rows: async (...args) => (await gather('rows', ...args)).flat().map((row, i) => ({ ...row, num: i + 1 })),
    async browserRows() {
      const items = await browserItems();
      return [...items.filter(row => row.kind !== 'channel'), ...groupChannels(items).map(group => ({ ...group.item, title: group.item.channel_name || group.item.title, source_count: group.members.length }))];
    },
    epg: id => requireProvider(providerFor(id)).epg(id),
    resolve: (id, options) => providerFor(id) === 'sports' ? requireProvider('sports').resolve(id, options) : resolveChannel(id, options),
    async media(url, context, variant) {
      if (context.group && url === context.root) return resolveChannel(context.requestedId);
      if (context.group && variant) {
        const stream = selected.get(context.group)?.stream;
        if (stream?.mediaPlaylist && stream.url !== context.root && getConfig()[stream.playback.provider]) return { ...stream, url: stream.mediaPlaylist };
      }
      return requireProvider(['zlive', 'timstreams'].includes(context.provider) ? context.provider : 'sports').media(url, context, variant);
    },
    async recover(context) {
      if (!context.group) return requireProvider('sports').recover(context);
      const cached = selected.get(context.group);
      if (cached && Date.now() - cached.at < 60000 && getConfig()[cached.stream.playback.provider] &&
          (cached.id !== context.memberId || cached.stream.url !== context.root)) return cached.stream;
      const failed = new Set(context.failedIds || []);
      const rediscover = context.provider === 'timstreams' && (!context.rediscoveredAt || Date.now() - context.rediscoveredAt >= 30000);
      if (!rediscover) failed.add(context.memberId);
      return resolveChannel(context.requestedId, { fresh: true, replace: rediscover ? context : undefined }, [...failed]);
    },
    async xmltv(base) {
      const docs = await gather('xmltv', base);
      // XMLTV requires every channel declaration before the programmes, even
      // when the guide combines documents from independent providers.
      const channels = docs.flatMap(doc => doc.match(/<channel\b[^>]*>[\s\S]*?<\/channel>/g) || []);
      const programs = docs.flatMap(doc => doc.match(/<programme\b[^>]*>[\s\S]*?<\/programme>/g) || []);
      return '<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="watch.local">\n'
        + [...channels, ...programs, '</tv>', ''].join('\n');
    },
  };
}
