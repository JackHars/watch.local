import { publicFetch as fetch } from './public-fetch.mjs';
import { load } from 'cheerio';

const ORIGIN = 'https://mande.net';
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const statuses = new Map([
  ['development', 'In development'], ['active development', 'In development'],
  ['preproduction', 'Pre-production'], ['pre production', 'Pre-production'],
  ['filming in production', 'In production'], ['post', 'Post-production'],
  ['post production', 'Post-production'], ['completed', 'Production complete'],
]);
const words = value => new Set(normalize(value).split(' ').filter(word => word.length > 4 && !['season','series','story','their','about','after','before','which','there','where','those','these','would','could','final','young','lives','world'].includes(word)));

export function parseProductionReport(html, { title, season, overview = '', now = Date.now() } = {}) {
  const $ = load(html), expected = normalize(`${title} Season ${season}`);
  if (normalize($('main h1').first().text()) !== expected) return null;
  const fields = new Map();
  $('main dt').each((index, element) => fields.set($(element).text().trim(), $(element).next('dd, p').text().replace(/\s+/g, ' ').trim()));
  if (fields.get('Type') !== 'Series') return null;
  // Short names such as FROM or Ghosts are easy to confuse with other shows.
  // Require a matching synopsis as well as the exact season title in that case.
  if (normalize(title).split(' ').length === 1 || normalize(title).length < 9) {
    const expectedWords = words(load(overview).text()), plotWords = words(fields.get('Plot'));
    if ([...plotWords].filter(word => expectedWords.has(word)).length < 2) return null;
  }
  const productionStatus = statuses.get(normalize(fields.get('Production Status'))) || null;
  const rawRelease = fields.get('Main release') || '';
  const years = rawRelease.match(/\b20\d{2}\b/g) || [];
  const releaseWindow = rawRelease.length <= 70 && years.some(year => Number(year) >= new Date(now).getUTCFullYear()) && /^[\w\s,./()–—-]+$/.test(rawRelease) ? rawRelease : null;
  const rawStart = fields.get('Scheduled start');
  const scheduledStart = rawStart && !Number.isNaN(Date.parse(rawStart)) ? new Date(rawStart).toISOString().slice(0, 10) : null;
  const updatedDates = $('main time[datetime]').map((index, element) => $(element).attr('datetime')).get()
    .filter(value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Date.parse(value) <= now).sort();
  if (!productionStatus && !releaseWindow) return null;
  return { productionStatus, releaseWindow, scheduledStart, updatedAt: updatedDates.at(-1)?.slice(0, 10) || null, confidence: 'reported', source: 'M&E' };
}

export async function fetchProductionReport({ title, season, overview }, { fetcher = fetch, now = Date.now() } = {}) {
  if (!title || !Number.isSafeInteger(season) || season < 1) return null;
  const slug = normalize(title).replace(/ /g, '-');
  if (!slug || slug.length > 160) return null;
  const url = `${ORIGIN}/production-listings/series/${slug}/season-${season}`;
  try {
    const response = await fetcher(url, { headers: { accept: 'text/html', 'user-agent': 'watch.local' }, signal: AbortSignal.timeout(6000), redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return null;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw Error('Production report is too large.');
      chunks.push(chunk);
    }
    const report = parseProductionReport(Buffer.concat(chunks).toString('utf8'), { title, season, overview, now });
    return report ? { ...report, url } : null;
  } catch { return null; }
}
