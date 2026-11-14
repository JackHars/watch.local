// Executable mechanism example, not an integration with a real endpoint.
// Copy into api/<id>.mjs and name the export for that provider. Implement
// loadSources from verified API evidence, using ctx.json/text/read.
// Normalized candidates:
// { url, headers?, id?, tmdb?, kind?: 'movie'|'series', season?, episode? }
// Map upstream identity fields into these names before returning them.
export function createExampleResolver({ loadSources, sourceName = 'example' } = {}) {
  if (typeof loadSources !== 'function') throw new TypeError('loadSources must be implemented from the provider contract');
  return async function resolveExample(input, ctx) {
    ctx.signal?.throwIfAborted();
    let candidates;
    try { candidates = await loadSources(input, ctx); }
    catch {
      ctx.signal?.throwIfAborted();
      throw new Error(`${sourceName} could not load its source list`);
    }
    if (!Array.isArray(candidates)) throw new Error(`${sourceName} returned an invalid source list`);
    const seen = new Set();
    for (const candidate of candidates.slice(0, 8)) {
      ctx.signal?.throwIfAborted();
      if (!candidate || typeof candidate.url !== 'string' || !candidate.url.trim() || seen.has(candidate.url)) continue;
      if (candidate.tmdb !== undefined && Number(candidate.tmdb) !== input.tmdb) continue;
      if (candidate.kind !== undefined && candidate.kind !== input.kind) continue;
      if (input.kind === 'series' && (
        candidate.season !== undefined && Number(candidate.season) !== input.season ||
        candidate.episode !== undefined && Number(candidate.episode) !== input.episode
      )) continue;
      seen.add(candidate.url);
      try {
        const result = await ctx.accept(candidate.url, candidate.headers || {}, sourceName);
        ctx.signal?.throwIfAborted();
        return result;
      } catch {
        ctx.signal?.throwIfAborted();
        // One rejected mirror must not discard the provider's other mirrors.
        // Do not include signed URLs or raw upstream response bodies in errors.
      }
    }
    throw new Error(`${sourceName} has no playable HLS source for this item`);
  };
}
