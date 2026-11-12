// Shared by the channel catalog, web filters and IPTV category export.
export const liveCategories = [
  { id: 'sports', name: 'Sports', iptv: '2001', icon: 'tv', color: '#167d93', description: 'The networks that bring you the game.' },
  { id: 'news', name: 'News', iptv: '2005', icon: 'globe', color: '#2460a8', description: 'Headlines, business and weather, around the clock.' },
  { id: 'entertainment', name: 'Entertainment', iptv: '2000', icon: 'tv', color: '#7253a6', description: 'Your everyday favourites and familiar networks.' },
  { id: 'movies', name: 'Movies', iptv: '2006', icon: 'film', color: '#974f40', description: 'A movie night, whenever you want one.' },
  { id: 'kids', name: 'Kids & Family', iptv: '2003', icon: 'smile', color: '#167f77', description: 'Cartoons, adventures and something for the whole family.' },
  { id: 'documentary', name: 'Documentaries', iptv: '2007', icon: 'globe', color: '#577440', description: 'Nature, history and the world around us.' },
  { id: 'comedy', name: 'Comedy', iptv: '2010', icon: 'smile', color: '#ac6136', description: 'Sitcoms, late nights and a little absurdity.' },
  { id: 'lifestyle', name: 'Lifestyle', iptv: '2008', icon: 'home', color: '#a34d65', description: 'Food, homes and fresh ideas.' },
  { id: 'music', name: 'Music & Arts', iptv: '2009', icon: 'music', color: '#9453a2', description: 'Music, performances and culture.' },
  { id: 'motorsports', name: 'Motorsports', iptv: '2002', icon: 'flag', color: '#a33d4b', description: 'Formula 1, MotoGP and racing from around the world.' },
];

export const liveTopics = {
  soccer: 'Football / Soccer', basketball: 'Basketball', 'american-football': 'American football',
  baseball: 'Baseball', hockey: 'Hockey', cricket: 'Cricket', tennis: 'Tennis', golf: 'Golf',
  combat: 'Combat sports', rugby: 'Rugby', 'australian-football': 'Australian football', college: 'College sports',
};
const eventTopics = { nba: 'basketball', nfl: 'american-football', cfl: 'american-football', cfb: 'college', mlb: 'baseball', nhl: 'hockey', soccer: 'soccer', mma: 'combat', boxing: 'combat', wwe: 'combat' };
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
export const liveCategory = item => item.category || (item.kind === 'event' || item.provider === 'sports' ? item.sport === 'f1' ? 'motorsports' : 'sports' : 'entertainment');
export const topicsFor = item => item.topics || (eventTopics[item.sport] ? [eventTopics[item.sport]] : []);
export const countryName = code => !code || code === 'INT' ? 'International' : regions.of(code);
export const normalizeLiveSearch = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function filterLiveItems(items, { kind = 'all', category = 'all', country = 'all', topic = 'all', query = '' } = {}) {
  const terms = String(query).trim().split(/\s+/).map(normalizeLiveSearch).filter(Boolean);
  return items.filter(item => (kind === 'all' || item.kind === kind)
    && (category === 'all' || liveCategory(item) === category)
    && (country === 'all' || item.country === country)
    && (topic === 'all' || topicsFor(item).includes(topic))
    && terms.every(term => normalizeLiveSearch([item.title, item.name, item.search_name, item.program, item.category_name,
      countryName(item.country), item.region, ...topicsFor(item).map(t => liveTopics[t])].join(' ')).includes(term)));
}

export function sortLiveItems(items, order = 'name') {
  return [...items].sort((a, b) => order === 'live' && (a.status === 'LIVE') !== (b.status === 'LIVE')
    ? Number(b.status === 'LIVE') - Number(a.status === 'LIVE')
    : a.kind !== b.kind ? Number(b.kind === 'channel') - Number(a.kind === 'channel')
    : a.kind === 'event' && b.kind === 'event' ? (a.starts_at || 0) - (b.starts_at || 0)
    : String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' }) || a.stream_id - b.stream_id);
}
