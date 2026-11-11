// Title similarity always wins over popularity. In particular, spacing and
// punctuation must not bury a show such as "VisionQuest" under "Vision Quest".
const normalize = value => String(value || '').replace(/[™®]/g, '').normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = value => value.replaceAll(' ', '');
const withoutArticle = value => value.replace(/^(?:the|an|a) /, '');
const typeOf = item => item.media_type || item.type || item.mediaType;
const identity = item => `${typeOf(item)}:${item.id}`;
const dateOf = item => item.release_date || item.first_air_date || item.releaseDate || '';
const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function titleMatch(title, query) {
  const name = normalize(title), joined = compact(query);
  if (!name || !joined) return 0;
  if (compact(name) === joined || compact(withoutArticle(name)) === compact(withoutArticle(query))) return 100;
  if (` ${name} `.includes(` ${query} `)) return 85;
  const words = name.split(' '), terms = query.split(' ');
  if (terms.every(term => words.includes(term))) return 80;
  if (terms.every(term => words.some(word => word.startsWith(term))) || (joined.length >= 3 && compact(name).includes(joined))) return 70;
  return 40 * terms.filter(term => words.some(word => word.startsWith(term))).length / terms.length;
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
    const match = Math.max(...[item.title, item.name, item.original_title, item.original_name].map(name => titleMatch(name, text)));
    const age = (now - Date.parse(dateOf(item))) / 86400000;
    const recent = age >= 0 ? Math.max(0, 1 - age / 730) * 3 : 0;
    // Ratings alone can promote a title with only a handful of fans. Use current
    // popularity and audience size, with small recency/trending tie-breakers.
    const interest = Math.min(40, 5 * Math.log1p(finite(item.popularity)))
      + Math.min(15, 1.5 * Math.log1p(finite(item.vote_count))) + recent + (hot.has(identity(item)) ? 8 : 0);
    return { item, index, match, year: year && dateOf(item).startsWith(year) ? 1 : 0, interest };
  }).sort((a, b) => b.match - a.match || b.year - a.year || b.interest - a.interest || a.index - b.index).map(entry => entry.item);
}

export async function improveSearchResults(items, query, { getDetails, signal, budgetMs = 1200, ...ranking } = {}) {
  const ranked = rankSearchResults(items, query, ranking);
  if (!getDetails || ranked.length < 2) return ranked;
  // Public search cards omit popularity/vote counts. Enrich only the closest
  // candidates, at most four requests at once, with a deadline for the whole
  // batch. Details use the normal server cache; never fetch one per result.
  const candidates = ranked.slice(0, 12).filter(item => item.popularity == null || item.vote_count == null);
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
    const fields = ['popularity', 'vote_count', 'original_title', 'original_name'];
    return { ...item, ...Object.fromEntries(fields.filter(key => detail[key] != null).map(key => [key, detail[key]])) };
  }), query, ranking);
}
