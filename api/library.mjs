import { problem } from './settings.mjs';

const PAGE_SIZE = 24;
const sorts = ['recommended', 'popular', 'rating', 'newest', 'title'];
const collections = ['all', 'trending', 'new', 'top_rated'];
const title = item => item.title || item.name || '';
const date = item => item.release_date || item.first_air_date || '';
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function normalize(item, type) {
  if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0 || item.adult || !(item.title || item.name) || (item.media_type || item.type || type) !== type) return null;
  return { id: Number(item.id), type, title: title(item),
    poster_path: item.poster_path || null, backdrop_path: item.backdrop_path || null,
    overview: String(item.overview || '').slice(0, 1000),
    genre_ids: [...new Set((item.genre_ids || item.genres?.map(g => g.id) || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))],
    release_date: date(item), vote_average: number(item.vote_average), vote_count: number(item.vote_count), popularity: number(item.popularity),
  };
}

export function libraryOptions(input) {
  const type = input.type, view = input.view || 'discover', collection = input.collection || 'all', sort = input.sort || 'recommended';
  if (!['movie','tv'].includes(type) || !['discover','browse'].includes(view) || !collections.includes(collection) || !sorts.includes(sort)) throw problem(400, 'Unknown library view or sort order.');
  const genre = input.genre === undefined || input.genre === '' ? 0 : Number(input.genre), page = input.page === undefined || input.page === '' ? 1 : Number(input.page);
  if (!Number.isSafeInteger(genre) || genre < 0 || !Number.isSafeInteger(page) || page < 1 || page > 10000) throw problem(400, 'Invalid library filter or page.');
  return { type, view, collection, sort, genre, page };
}

// Feed snapshots are shared; profile history and recommendations are never cached
// across accounts. Genre filtering and sorting happen before pagination.
export function createLibrary({ catalog, localCatalog, history, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  async function feeds(type) {
    const hit = cache.get(type);
    if (hit && now() - hit.at < 5 * 60000) return hit;
    if (!pending.has(type)) pending.set(type, (async () => {
      const paths = [`/${type}/popular`, `/trending/${type}/day`, `/${type}/${type === 'movie' ? 'now_playing' : 'on_the_air'}`, `/curated/${type}/top_rated`, `/genre/${type}/list`];
      const results = await Promise.allSettled(paths.map(path => catalog(path, {}, AbortSignal.timeout(10000))));
      const rows = results.map(result => result.status === 'fulfilled' ? result.value : null);
      const value = { at: now(), popular: rows[0]?.results || hit?.popular || [], trending: rows[1]?.results || hit?.trending || [], new: rows[2]?.results || hit?.new || [], top_rated: rows[3]?.results || hit?.top_rated || [], genres: rows[4]?.genres || hit?.genres || [], partial: results.some(r => r.status === 'rejected') };
      // Briefly retry an incomplete refresh; keep the last usable rows meanwhile.
      if (value.partial) value.at -= 4 * 60000;
      cache.set(type, value); return value;
    })().finally(() => pending.delete(type)));
    return pending.get(type);
  }
  return async (userId, profileId, input) => {
    const options = libraryOptions(input), {type,genre,collection,sort,page} = options;
    // Validate profile ownership before accessing shared catalog work.
    const watched = (await history(userId, profileId)).filter(item => item.type === type && (item.completed || item.position >= 30));
    const [data, local] = await Promise.all([feeds(type), localCatalog(type)]);
    if (genre && !data.genres.some(g => g.id === genre)) throw problem(400, 'Unknown genre.');
    const pool = new Map();
    for (const raw of [...local, ...data.popular, ...data.new, ...data.top_rated, ...data.trending]) {
      const item = normalize(raw, type); if (!item) continue;
      const prior = pool.get(item.id);
      if (prior) for (const key of ['poster_path','backdrop_path','overview','release_date','vote_average','vote_count','popularity']) if (!item[key]) item[key] = prior[key];
      if (prior && !item.genre_ids.length) item.genre_ids = prior.genre_ids;
      pool.set(item.id, item);
    }
    if (!pool.size) throw problem(502, 'The library is temporarily unavailable. Try again shortly.');
    const weights = new Map(), seen = new Set(watched.map(item => Number(item.id)));
    const seeds = watched.slice(0, 8);
    const missing = seeds.filter(item => !pool.get(Number(item.id))?.genre_ids.length).slice(0, 3);
    const details = await Promise.allSettled(missing.map(item => catalog(`/${type}/${item.id}`, {}, AbortSignal.timeout(4000))));
    const seedDetails = new Map(missing.map((item, index) => [Number(item.id), details[index].status === 'fulfilled' ? normalize(details[index].value, type) : null]));
    seeds.forEach((item, index) => {
      const source = pool.get(Number(item.id))?.genre_ids.length ? pool.get(Number(item.id)) : seedDetails.get(Number(item.id));
      for (const id of source?.genre_ids || []) weights.set(id, (weights.get(id) || 0) + 1 / (1 + index / 2));
    });
    const maxWeight = Math.max(1, ...weights.values()), today = new Date(now()).toISOString().slice(0,10);
    const trending = new Set(data.trending.map(item => Number(item.id)));
    const rating = item => (item.vote_average * item.vote_count + 6.5 * 1000) / (item.vote_count + 1000);
    const score = item => rating(item) + Math.min(2, Math.log1p(item.popularity) / 4) + (trending.has(item.id) ? 1 : 0)
      + Math.min(2.5, item.genre_ids.reduce((sum, id) => sum + (weights.get(id) || 0) / maxWeight, 0)) - (seen.has(item.id) ? 3 : 0);
    const compare = (a, b) => (sort === 'popular' ? b.popularity - a.popularity : sort === 'rating' ? rating(b) - rating(a) : sort === 'newest' ? date(b).localeCompare(date(a)) : sort === 'title' ? collator.compare(title(a), title(b)) : score(b) - score(a)) || a.id - b.id;
    const matching = item => !genre || item.genre_ids.includes(genre);
    const eligible = item => item.poster_path && (!date(item) || date(item) <= today);
    const all = [...pool.values()].filter(eligible);
    const selectedIds = collection === 'all' ? null : new Set(data[collection].map(item => Number(item.id)));
    const filtered = all.filter(item => matching(item) && (!selectedIds || selectedIds.has(item.id))).sort(compare);
    const usedArtwork = new Set();
    const genres = data.genres.map(g => {
      const titles = all.filter(item => item.genre_ids.includes(g.id)).sort((a,b) => b.popularity - a.popularity || a.id - b.id);
      const artwork = titles.find(item => item.backdrop_path && !usedArtwork.has(item.backdrop_path))?.backdrop_path || titles.find(item => item.backdrop_path)?.backdrop_path || null;
      if (artwork) usedArtwork.add(artwork);
      return { ...g, count: titles.length, backdrop_path: artwork };
    });
    const response = { ...options, genres, personalized: weights.size > 0, partial: data.partial, total: filtered.length, pages: Math.ceil(filtered.length / PAGE_SIZE), items: filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE) };
    if (options.view === 'browse') return response;
    const recommended = all.filter(item => !seen.has(item.id) && matching(item)).sort((a,b) => score(b)-score(a) || a.id-b.id);
    const rows = [{key:'recommended',label:weights.size ? 'Recommended for you' : 'Recommended',subtitle:weights.size ? 'Inspired by the genres you’ve been watching.' : 'Popular picks with ratings from a broad audience.',items:recommended.slice(0,16)}];
    for (const [key,label,subtitle] of [
      ['trending','Trending now','What everyone is talking about.'],
      ['new',type === 'movie' ? 'New releases' : 'On TV this week',type === 'movie' ? 'Fresh from the cinema.' : 'New episodes from current shows.'],
      ['top_rated','Critically acclaimed','Highly rated, widely reviewed live-action favourites.'],
    ]) rows.push({key,label,subtitle,items:data[key].map(item=>pool.get(Number(item.id))).filter(item=>item && eligible(item) && matching(item)).filter((item,index,list)=>list.findIndex(i=>i.id===item.id)===index).slice(0,16)});
    const choices = type === 'movie' ? [28,35,53,18,878,99] : [18,35,80,10765,99,10764];
    for (const id of choices) {
      const info = genres.find(g=>g.id===id); if (!info || genre && genre!==id) continue;
      rows.push({key:'genre-'+id,genre:id,label:info.name,subtitle:'Find your next favourite.',items:all.filter(item=>item.genre_ids.includes(id)).sort((a,b)=>score(b)-score(a)||a.id-b.id).slice(0,16)});
    }
    return {...response,spotlight:recommended.find(item=>item.backdrop_path)||all.find(item=>item.backdrop_path)||null,rows:rows.filter(row=>row.items.length)};
  };
}
