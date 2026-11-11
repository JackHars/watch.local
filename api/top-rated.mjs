// Mainstream English-language, live-action picks for the two web discovery rows.
// These filters do not change the full catalog, search, or title availability.
const policies = {
  movie: {minimumVotes:1000, priorVotes:3000},
  tv: {minimumVotes:500, priorVotes:1500},
};
const PRIOR_RATING = 7, MAX_POPULARITY_BONUS = 0.35;

export function rankTopRated(items, type, today = new Date().toISOString().slice(0,10)) {
  const policy = policies[type];
  if (!policy) throw new Error('Unknown top-rated media type.');
  const unique = new Map();
  for (const item of items) {
    const id = Number(item.id), votes = Number(item.vote_count), rating = Number(item.vote_average);
    const date = type === 'movie' ? item.release_date : item.first_air_date;
    if (!Number.isSafeInteger(id) || id <= 0 || (item.media_type && item.media_type !== type) || item.adult) continue;
    if (item.original_language !== 'en' || !Array.isArray(item.genre_ids) || !item.genre_ids.length) continue;
    const genres = item.genre_ids.map(Number);
    if (genres.includes(16) || genres.some(id=>!Number.isSafeInteger(id) || id <= 0)) continue;
    if (!Number.isSafeInteger(votes) || votes < policy.minimumVotes || !Number.isFinite(rating) || rating < 7 || rating > 10) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || date > today) continue;
    if (!item.poster_path || !(item.title || item.name)) continue;
    const previous = unique.get(id);
    if (!previous || votes > Number(previous.vote_count)) unique.set(id,item);
  }
  const score = item => {
    const votes = Number(item.vote_count), rating = Number(item.vote_average);
    const confidenceRating = (votes * rating + policy.priorVotes * PRIOR_RATING) / (votes + policy.priorVotes);
    const popularity = Number.isFinite(Number(item.popularity)) ? Math.max(0,Number(item.popularity)) : 0;
    const bonus = MAX_POPULARITY_BONUS * Math.min(1,Math.log1p(popularity)/Math.log(201));
    return confidenceRating + bonus;
  };
  return [...unique.values()].sort((a,b)=>score(b)-score(a) || Number(b.vote_count)-Number(a.vote_count) || Number(a.id)-Number(b.id));
}

export async function collectTopRated(type, fetchPage, {today,signal} = {}) {
  const boards = [{name:'top_rated',pages:6},{name:'popular',pages:3}];
  const pages = new Map(), tasks = [];
  let failures = 0;
  const load = async (board,page,first = false) => {
    try {
      signal?.throwIfAborted();
      const data = await fetchPage(`/${type}/${board.name}`,{page},signal);
      if (!Array.isArray(data.results) || !Number.isInteger(data.total_pages)) throw new Error('Invalid candidate list.');
      pages.set(`${board.name}:${page}`,data.results);
      if (first) for (let next = 2; next <= Math.min(board.pages,data.total_pages); next++) tasks.push({board,page:next});
    } catch {
      signal?.throwIfAborted();
      failures++;
    }
  };
  await Promise.all(boards.map(board=>load(board,1,true)));
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},async()=>{
    while (next < tasks.length) {const task=tasks[next++];await load(task.board,task.page);}
  }));
  signal?.throwIfAborted();
  // Resolve duplicate metadata in source order, independent of network timing.
  const items = [];
  for (const board of boards) for (let page = 1; page <= board.pages; page++) items.push(...(pages.get(`${board.name}:${page}`)||[]));
  return {results:rankTopRated(items,type,today),complete:failures === 0};
}
