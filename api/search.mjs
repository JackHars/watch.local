// Search is also autocomplete: a popular title beginning with the query can
// outrank an obscure exact match. Missing query words still rank much lower.
const normalize = value => String(value || '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[™®]/g, '').normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = value => value.replaceAll(' ', '');
const withoutArticle = value => value.replace(/^(?:the|an|a) /, '');
const typeOf = item => item.media_type || item.type || item.mediaType;
const identity = item => `${typeOf(item)}:${item.id}`;
const dateOf = item => item.release_date || item.first_air_date || item.releaseDate || '';
const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

const titles = item => [...new Set([item.title, item.name, item.original_title, item.original_name].filter(Boolean).map(normalize))];
const wordsIn = value => value.split(' ').filter(word => !['the','a','an','of','and'].includes(word));
function titleMatch(name, query) {
  const joined = compact(query);
  if (!name || !joined) return 0;
  if (compact(name) === joined || compact(withoutArticle(name)) === compact(withoutArticle(query))) return 100;
  const extra = Math.min(16, Math.max(0, wordsIn(name).length - wordsIn(query).length) * 4);
  if (compact(withoutArticle(name)).startsWith(compact(withoutArticle(query)))) return 94 - extra;
  if (` ${name} `.includes(` ${query} `)) return 90 - extra;
  const words = name.split(' '), terms = query.split(' ');
  if (terms.every(term => words.includes(term))) return 86 - extra;
  if (terms.every(term => words.some(word => word.startsWith(term)))) return 86 - extra;
  return 40 * terms.filter(term => words.some(word => word.startsWith(term))).length / terms.length;
}

// Build once when the IPTV catalog loads/refreshes. Search its title prefixes
// without rescanning or copying the catalog's large metadata objects each tap.
export function createSearchIndex() {
  let entries = [], prefixes = new Map();
  return {
    replace({ movies = [], series = [] } = {}) {
      entries = [['movie', movies], ['tv', series]].flatMap(([type, items]) => items
        .filter(item => !item.adult && item.id && (item.title || item.name))
        .map(item => ({ item, type, names: titles(item), interest: 7 * Math.log1p(finite(item.popularity)) + 1.5 * Math.log1p(finite(item.vote_count)) })));
      prefixes = new Map();
      entries.forEach((entry, index) => {
        const keys = new Set();
        for (const name of entry.names) for (const word of [...name.split(' '), compact(withoutArticle(name))]) {
          if (word.length >= 2) keys.add(word.slice(0, 2));
          if (word.length >= 3) keys.add(word.slice(0, 3));
        }
        for (const key of keys) {
          if (!prefixes.has(key)) prefixes.set(key, []);
          prefixes.get(key).push(index);
        }
      });
      for (const bucket of prefixes.values()) bucket.sort((a,b) => entries[b].interest - entries[a].interest);
    },
    matching(query, type = 'multi') {
      const text = normalize(query).replace(/ (?:19|20)\d{2}$/, '');
      const short = compact(text).length <= 3;
      const bucket = word => {
        const matches = prefixes.get(word.slice(0, Math.min(3, word.length))) || [];
        // Very broad starts such as "th" can match most of a large library.
        // Consider its most watched candidates without blocking media serving.
        return short ? matches.slice(0, 2000) : matches;
      };
      const words = wordsIn(text).filter(word => word.length >= 2);
      const smallest = words.map(bucket).sort((a,b) => a.length-b.length)[0] || [];
      // Include joined titles too: "vision quest" can match "visionquest" even
      // when the catalog supplies no word boundary before "quest".
      const candidates = new Set([...smallest, ...bucket(compact(withoutArticle(text)))]);
      const found = [...candidates].map(index => entries[index]).filter(entry => (type === 'multi' || entry.type === type) && entry.names.some(name => titleMatch(name, text) >= 70));
      return rankSearchResults(found.map(({ item, type }) => ({ ...item, media_type: type })), query).slice(0, 60);
    },
  };
}

export function mergeSearchCandidates(items, candidates, query, type = 'multi') {
  const text = normalize(query).replace(/ (?:19|20)\d{2}$/, '');
  const merged = new Map(items.map(item => [identity(item), { ...item }]));
  for (const candidate of candidates) {
    if (candidate.adult || !['movie','tv'].includes(typeOf(candidate)) || (type !== 'multi' && typeOf(candidate) !== type)) continue;
    if (!titles(candidate).some(name => titleMatch(name, text) >= 70)) continue;
    // Detail caches also contain credits and seasons; return lightweight cards.
    const keys = ['id','title','name','original_title','original_name','popularity','vote_count','vote_average','release_date','first_air_date','poster_path','backdrop_path','overview','adult','genre_ids','original_language'];
    const item = { ...Object.fromEntries(keys.filter(key => candidate[key] != null).map(key => [key, candidate[key]])), media_type: typeOf(candidate) };
    const prior = merged.get(identity(item));
    if (!prior) merged.set(identity(item), item);
    else {
      const fields = ['popularity','vote_count','vote_average','original_title','original_name'];
      merged.set(identity(item), { ...item, ...prior,
        ...Object.fromEntries(fields.filter(key => item[key] != null).map(key => [key, item[key]])) });
    }
  }
  return [...merged.values()];
}

export function rankSearchResults(items, query, { now = Date.now(), trending = [] } = {}) {
  let text = normalize(query), year = '';
  // A requested release year disambiguates remakes, but keep title numbers such
  // as "Blade Runner 2049" when no result was released in that year.
  const dated = text.match(/^(.+) ((?:19|20)\d{2})$/);
  if (dated && items.some(item => dateOf(item).startsWith(dated[2]))) [, text, year] = dated;
  const hot = new Set(trending.map(identity)), seen = new Set();
  return items.filter(item => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((item, index) => {
    const match = Math.max(0, ...titles(item).map(name => titleMatch(name, text)));
    const age = (now - Date.parse(dateOf(item))) / 86400000;
    const recent = age >= 0 ? Math.max(0, 1 - age / 730) * 3 : 0;
    const votes = finite(item.vote_count), rating = finite(item.vote_average ?? item.rating);
    // Shrink ratings toward a neutral baseline until there are enough votes;
    // a 10/10 from one fan must not outweigh a widely watched, well-rated show.
    const quality = rating > 0 ? (Math.min(10, rating) - 6.5) * votes / (votes + 100) * 2 : 0;
    const interest = Math.min(40, 7 * Math.log1p(finite(item.popularity)))
      + Math.min(15, 1.5 * Math.log1p(votes)) + quality + recent + (hot.has(identity(item)) ? 8 : 0);
    return { item, index, match, complete: match >= 70 ? 1 : 0,
      year: year && dateOf(item).startsWith(year) ? 1 : 0, score: match + interest };
  }).sort((a, b) => b.complete - a.complete || b.year - a.year || b.score - a.score || b.match - a.match || a.index - b.index).map(entry => entry.item);
}

export async function improveSearchResults(items, query, { getDetails, signal, budgetMs = 1200, ...ranking } = {}) {
  signal?.throwIfAborted();
  const ranked = rankSearchResults(items, query, ranking);
  if (!getDetails || ranked.length < 2) return ranked;
  // Public search cards omit popularity/vote counts. Enrich only the closest
  // candidates, at most four requests at once, with a deadline for the whole
  // batch. Details use the normal server cache; never fetch one per result.
  const sparse = ranked.filter(item => item.popularity == null || item.vote_count == null);
  const hot = new Set((ranking.trending || []).map(identity)), text = normalize(query);
  // Do not spend the entire detail budget on exact matches and starve popular
  // prefix matches. Trending candidates go first, then alternate both groups.
  const lanes = [sparse.filter(item => hot.has(identity(item))),
    sparse.filter(item => titles(item).some(name => titleMatch(name, text) === 100)),
    sparse.filter(item => !titles(item).some(name => titleMatch(name, text) === 100))];
  const candidates = [], picked = new Set();
  for (let index = 0; index < sparse.length && candidates.length < 12; index++) for (const lane of lanes) {
    const item = lane[index];
    if (item && !picked.has(identity(item)) && candidates.length < 12) { picked.add(identity(item)); candidates.push(item); }
  }
  if (!candidates.length) return ranked;
  const timeout = AbortSignal.timeout(budgetMs), bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const details = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length && !bounded.aborted) {
      const item = candidates[next++];
      try {
        const detail = await getDetails(typeOf(item), item.id, bounded);
        if (!bounded.aborted) details.set(identity(item), detail);
      } catch { signal?.throwIfAborted(); }
    }
  }));
  signal?.throwIfAborted();
  return rankSearchResults(ranked.map(item => {
    const detail = details.get(identity(item));
    if (!detail) return item;
    // Keep search labels/artwork intact and copy only the ranking metadata.
    const fields = ['popularity', 'vote_count', 'vote_average', 'original_title', 'original_name'];
    return { ...item, ...Object.fromEntries(fields.filter(key => detail[key] != null).map(key => [key, detail[key]])) };
  }), query, ranking);
}
