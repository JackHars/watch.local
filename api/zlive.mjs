import { resolveZlive, zliveHeaders, zliveOrigin } from './zlive-resolver.mjs';
import { createChannelProvider } from './channel-provider.mjs';

export const ZLIVE_ID_BASE = 1000000000;
const groups = ['Entertainment', 'Sports', 'F1', 'Kids', 'Other'];
const problem = (status, message) => Object.assign(new Error(message), { status });
const keyOK = key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(key);
const clean = value => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300);
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
          quality: clean(row.quality), region: clean(row.region), flag: clean(row.flag), live: row.live !== false,
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

export const createZliveProvider = options => createChannelProvider({ provider: 'zlive', label: 'ZLive', idBase: ZLIVE_ID_BASE, defaultHeaders: zliveHeaders, ...options, source: options.source || createZliveSource() });
