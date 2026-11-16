const DAY = 86400000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const calendar = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 14h3m-3 4h3m4-4h1"/></svg>';
const formatDate = (value, options) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
function reportLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'mande.net' && url.pathname.startsWith('/production-listings/series/') && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function countdown(date, today) {
  const days = Math.round((Date.parse(date) - Date.parse(today)) / DAY);
  if (days < 0) return 'Premiere date has passed';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

export function upcomingPresentation(data, { today = localToday() } = {}) {
  if (!data?.season && !data?.nextEpisode) return null;
  const { season, nextEpisode: episode, report } = data;
  const heading = season ? `Season ${season.number}` : `Season ${episode.season}${episode.number ? ` · Episode ${episode.number}` : ''}`;
  const date = season ? season.premiereDate : episode.airDate;
  const base = { heading, eyebrow: season ? 'Coming next' : 'Next episode' };
  if (validDate(date)) return { ...base, kind: 'scheduled', status: 'Scheduled', date, release: formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' }), eta: countdown(date, today), note: episode?.name && (!season || episode.season === season.number) ? episode.name : '' };
  const url = reportLink(report?.url);
  if (url && report.confidence === 'reported' && (report.releaseWindow || report.productionStatus)) {
    return { ...base, kind: 'reported', status: 'Reported', release: report.releaseWindow ? `Expected ${report.releaseWindow}` : 'Release date TBA', eta: '', production: report.productionStatus || '', url,
      updated: validDate(report.updatedAt) ? formatDate(report.updatedAt, { month: 'short', day: 'numeric', year: 'numeric' }) : '', note: '' };
  }
  return { ...base, kind: 'unknown', status: 'Announced', release: 'Release date TBA', eta: '', note: '' };
}

export function upcomingCard(data, { poster = '', today } = {}) {
  const view = upcomingPresentation(data, { today });
  if (!view) return '';
  const artwork = poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : calendar;
  const release = view.date ? `<time datetime="${esc(view.date)}">${esc(view.release)}</time>` : esc(view.release);
  const source = view.url ? `<div class="upcoming-report"><a href="${esc(view.url)}" target="_blank" rel="noopener noreferrer" aria-label="Read the M&amp;E production report">Production report <span aria-hidden="true">↗</span></a>${view.updated ? `<span>Updated ${esc(view.updated)}</span>` : ''}</div>` : '';
  return `<section class="upcoming-card" aria-label="Upcoming release"><div class="upcoming-main"><div class="upcoming-art ${poster ? '' : 'upcoming-art-placeholder'}">${artwork}</div><div class="upcoming-copy"><div class="upcoming-heading"><span class="upcoming-label">${esc(view.eyebrow)}</span><span class="upcoming-status">${esc(view.status)}</span></div><h2>${esc(view.heading)}</h2><p class="upcoming-date">${release}</p>${view.eta ? `<p class="upcoming-countdown">${esc(view.eta)}</p>` : ''}${view.production ? `<p class="upcoming-production">${esc(view.production)}</p>` : ''}</div></div>${view.note ? `<p class="upcoming-note">${esc(view.note)}</p>` : ''}${source}</section>`;
}
