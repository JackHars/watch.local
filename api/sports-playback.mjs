import { load } from 'cheerio';

const problem = message => Object.assign(new Error(message), { status: 502 });
const httpURL = (value, base) => {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem('Invalid sports media URL.');
  return url.href;
};
const remap = (url, previous, current) => url === previous ? current : url.startsWith(new URL('.', previous).href)
  ? new URL(url.slice(new URL('.', previous).href.length), new URL('.', current)).href : url;

export function sportsMediaURL(url, playback, current = playback) {
  const target = new URL(httpURL(url));
  if (playback.provider === 'streamfree' && target.hash.startsWith('#sf=')) return httpURL(decodeURIComponent(target.hash.slice(4)), playback.player);
  // Expose a stable URL for each segment while credentials rotate upstream.
  return remap(target.href, current.root, playback.root);
}

// Stream Control's public player authorizes a channel when Play is pressed.
// Keep its short-lived session server-side and renew it as media is requested.
// Only the signed relay context (not key_auth or the session) reaches clients.
export function createSportsPlayback({ request, now = Date.now }) {
  const sessions = new Map(), streamFree = new Map();
  const headersFor = player => ({ referer: player, origin: new URL(player).origin });
  async function freeSource(player, page) {
    let item = streamFree.get(player);
    if (!item) {
      item = { value: null, pending: null, renewAt: 0 }; streamFree.set(player, item);
      while (streamFree.size > 100) streamFree.delete(streamFree.keys().next().value);
    }
    if (item.value && now() < item.renewAt && !page) return item.value;
    if (item.pending) return item.pending;
    item.pending = (async () => {
      page ??= (await request(player, player)).text;
      // Read the public player's configuration as data; never execute its scripts.
      const endpoint = page.match(/sfFetch\(['"](\/get-stream-key\/[a-z0-9-]+)['"]\)/)?.[1];
      const quality = page.match(/\bconst\s+QUALITY\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const slug = page.match(/\bconst\s+VARIANT\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const suffix = page.match(/\bconst\s+SOURCE_SUFFIX\s*=\s*['"]([^'"]*)['"]/)?.[1] || '';
      if (!endpoint || !quality || !slug) throw problem('The sports player configuration is unavailable.');
      const signed = page.match(/\bconst\s+_0x\s*=\s*(\{[^\n]+\})\s*;/)?.[1];
      const params = signed ? JSON.parse(signed)[quality] : null;
      const data = JSON.parse((await request(new URL(endpoint, player).href, player)).text);
      // Prefer the provider's direct CDN: its external-CDN playlist can lag
      // behind and advertise fallback segments that have already been removed.
      const paths = data.is_external && data.external_url ? [data.external_url] :
        (data.server_name === 'externalcdn' ? ['/live-cdn/', '/live/', '/live-externalcdn/'] : data.server_name && data.server_name !== 'origin' ? ['/live-cdn/', '/live/'] : ['/live/'])
          .map(prefix => `${prefix}${slug}${quality}${suffix}/index.m3u8`);
      let last;
      for (const path of paths) {
        try {
          const url = new URL(httpURL(path, player));
          if (!data.is_external) for (const key of ['_t', '_e', '_n']) if (params?.[key] != null) url.searchParams.set(key, String(params[key]));
          const manifest = await request(url.href, player);
          if (!manifest.text.trimStart().startsWith('#EXTM3U')) throw problem('The sports source did not return an HLS playlist.');
          item.value = { url: url.href, headers: headersFor(player), playback: { provider: 'streamfree', player, root: url.href } };
          item.renewAt = Math.min(now() + 1800000, params?._e ? Number(params._e) * 1000 - 60000 : Infinity);
          return item.value;
        } catch (error) { last = error; }
      }
      throw last;
    })().finally(() => { item.pending = null; });
    return item.pending;
  }
  function entry(context) {
    const cacheKey = JSON.stringify([context.player, context.key, context.embedOrigin]);
    let item = sessions.get(cacheKey);
    if (!item) {
      item = { auth: null, pending: null, renewAt: 0 };
      sessions.set(cacheKey, item);
      while (sessions.size > 100) sessions.delete(sessions.keys().next().value);
    }
    return item;
  }
  async function authorize(context) {
    const item = entry(context);
    if (item.auth && now() < item.renewAt) return item.auth;
    if (item.pending) return item.pending;
    item.pending = (async () => {
      async function post(renew) {
        const response = await request(new URL('/api/v1/playback/' + (renew ? 'renew' : 'authorize'), context.player).href, context.player, {
          method: 'POST', body: JSON.stringify({ key: context.key, native: false, embed_origin: context.embedOrigin, ...(renew ? { session: item.auth.session } : {}) }),
        });
        const data = JSON.parse(response.text);
        if (!data.ok || !Array.isArray(data.sources) || !data.sources.length) throw problem('The sports player has no available broadcast.');
        if (data.drm) throw problem('This sports broadcast requires a DRM player.');
        data.sources = data.sources.map(source => ({ ...source, url: httpURL(source.url, context.player) }));
        if (!(Number(data.expires) * 1000 > now())) throw problem('The sports player returned an expired broadcast.');
        return data;
      }
      try {
        // Expired/restarted provider sessions can be replaced by a new Play request.
        let data;
        if (item.auth?.session) { try { data = await post(true); } catch { data = await post(false); } }
        else data = await post(false);
        item.auth = data;
        item.renewAt = Math.min(now() + Math.max(30, Number(data.renew_in) || 300) * 1000, Number(data.expires) * 1000 - 15000);
        return data;
      } catch (error) {
        // A transient renewal failure need not interrupt a still-valid stream.
        if (item.auth && Number(item.auth.expires) * 1000 > now() + 15000) {
          item.renewAt = Math.min(now() + 30000, Number(item.auth.expires) * 1000 - 15000);
          return item.auth;
        }
        throw error;
      }
    })().finally(() => { item.pending = null; });
    return item.pending;
  }
  return {
    async resolve(page, player, referer) {
      if (/sfFetch\(['"]\/get-stream-key\//.test(page)) return freeSource(httpURL(player), page);
      const root = load(page)('#scp[data-key][data-hls]');
      const key = root.attr('data-key');
      if (!key || !/^[a-z0-9]{8,80}$/i.test(key)) return null;
      const context = { provider: 'stream-control', player: httpURL(player), key, embedOrigin: new URL(referer).origin };
      const auth = await authorize(context);
      let last;
      for (const source of auth.sources.slice(0, 4)) {
        try {
          const result = await request(source.url, player);
          if (!result.text.trimStart().startsWith('#EXTM3U')) throw problem('The sports source did not return an HLS playlist.');
          return { url: source.url, headers: headersFor(player), playback: { ...context, source: source.id, root: source.url } };
        } catch (error) { last = error; }
      }
      throw last;
    },
    async media(url, context) {
      if (context.provider === 'streamfree') {
        const current = await freeSource(context.player), target = new URL(httpURL(url));
        // The player's manifest includes its own CDN as a segment fallback.
        // Use that MPEG-TS feed directly: the other CDN may return image bait,
        // and native players cannot run the page's JavaScript fallback loader.
        const next = target.hash.startsWith('#sf=') ? httpURL(decodeURIComponent(target.hash.slice(4)), context.player)
          : remap(target.href, context.root, current.url);
        return { url: next, headers: current.headers, playback: current.playback };
      }
      if (context.provider !== 'stream-control') throw problem('Unknown sports player.');
      const auth = await authorize(context), source = auth.sources.find(s => s.id === context.source) || auth.sources[0];
      const target = new URL(httpURL(url)), headers = headersFor(context.player);
      // Keys live on the player host, even when the playlist points at its CDN.
      // Never forward key authorization to media CDNs or unrelated hosts.
      if (target.pathname.startsWith(`/sc-key/${context.key}/`) && /^\/sc-key\/[a-z0-9]+\/[a-z0-9]+\.key$/i.test(target.pathname)) {
        if (!auth.key_auth) throw problem('The sports player did not authorize its media key.');
        return { url: new URL(target.pathname, context.player).href, headers: { ...headers, 'x-sc-auth': auth.key_auth }, playback: context };
      }
      // Resolve against the renewed source directory, also allowing CDN failover.
      // Child URLs from older playlists remain usable after token rotation.
      const next = remap(target.href, context.root, source.url);
      return { url: next, headers, playback: { ...context, source: source.id, root: source.url } };
    },
  };
}
