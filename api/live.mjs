import { createSportsProvider } from './sports.mjs';
import { createZliveProvider, ZLIVE_ID_BASE } from './zlive.mjs';

// Existing sports IDs stay unchanged. Persistent TV channels occupy their own
// numeric range so Xtream clients can retain favorites across imports/restarts.
export function createLiveProvider({ directory, sportsSource, zliveSource, getConfig = () => ({ sports: true, zlive: true }) }) {
  const providers = {
    sports: createSportsProvider({ directory, source: sportsSource }),
    zlive: createZliveProvider({ directory, source: zliveSource }),
  };
  const enabled = () => Object.entries(providers).filter(([id]) => getConfig()[id]);
  const providerFor = id => Number(id) >= ZLIVE_ID_BASE ? 'zlive' : 'sports';
  const requireProvider = id => {
    if (!providers[id] || !getConfig()[id]) throw Object.assign(new Error('This live TV provider is disabled in Settings.'), { status: 403 });
    return providers[id];
  };
  async function gather(method, ...args) {
    const results = await Promise.allSettled(enabled().map(([, provider]) => provider[method](...args)));
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  }
  return {
    initialize: () => Promise.all(Object.values(providers).map(p => p.initialize())),
    ensure: () => gather('ensure'),
    refresh: options => gather('refresh', options),
    status: () => Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { enabled: Boolean(getConfig()[id]), ...p.status() }])),
    categories: async () => (await gather('categories')).flat(),
    rows: async (...args) => (await gather('rows', ...args)).flat().map((row, i) => ({ ...row, num: i + 1 })),
    browserRows: async () => (await gather('browserRows')).flat().map(item => item.provider ? item : {
      ...item, provider: 'sports', kind: 'event', category_id: `sports-${item.sport}`,
    }),
    epg: id => requireProvider(providerFor(id)).epg(id),
    resolve: (id, options) => requireProvider(providerFor(id)).resolve(id, options),
    media: (url, context) => requireProvider(context.provider === 'zlive' ? 'zlive' : 'sports').media(url, context),
    async xmltv() {
      const docs = await gather('xmltv');
      // XMLTV requires every channel declaration before the programmes, even
      // when the guide combines documents from independent providers.
      const channels = docs.flatMap(doc => doc.match(/<channel\b[^>]*>[\s\S]*?<\/channel>/g) || []);
      const programs = docs.flatMap(doc => doc.match(/<programme\b[^>]*>[\s\S]*?<\/programme>/g) || []);
      return '<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="watch.local">\n'
        + [...channels, ...programs, '</tv>', ''].join('\n');
    },
  };
}
