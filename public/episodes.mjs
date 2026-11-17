import { formatTimeLeft } from './watch-progress.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function episodePresentation(episode, progress, { today = localToday(), seasonAirDate } = {}) {
  const completed = progress?.completed === true;
  const started = completed || Number.isFinite(progress?.position) && progress.position > 0 && Number.isFinite(progress?.duration) && progress.duration > 0;
  const dated = validDate(episode.air_date);
  // A recorded watch takes precedence over an incorrect or delayed catalog date.
  const upcoming = !started && (dated ? episode.air_date > today : validDate(seasonAirDate) && seasonAirDate > today);
  const release = upcoming ? dated ? new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', ...(episode.air_date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(new Date(`${episode.air_date}T12:00:00Z`)) : 'Release date TBA' : '';
  const percent = completed ? 100 : started ? Math.max(1, Math.min(99, Math.round(progress.position / progress.duration * 100))) : 0;
  const label = upcoming ? 'Upcoming' : completed ? 'Watched' : started ? formatTimeLeft(progress.duration - progress.position) : '';
  return { upcoming, completed, started, percent, label, release, date: upcoming && dated ? episode.air_date : '' };
}

function indicators(view, icon) {
  if (view.upcoming) return `<span class="episode-upcoming"><span>${icon('clock')}Upcoming</span>${view.date ? `<time datetime="${view.date}">${esc(view.release)}</time>` : `<small>${view.release}</small>`}</span>`;
  if (!view.started) return '';
  return `<span class="episode-watch-label">${view.completed ? icon('check') : ''}${esc(view.label)}</span><span class="watch-progress" aria-hidden="true"><span style="width:${view.percent}%"></span></span>`;
}
function accessibleLabel(episode, view) {
  const title = `Episode ${episode.episode_number}: ${episode.name || `Episode ${episode.episode_number}`}`;
  if (view.upcoming) return `${title}. Upcoming, ${view.release}.`;
  if (view.completed) return `Watch again. ${title}. Watched.`;
  if (view.started) return `Resume ${title}. ${view.percent}% watched, ${view.label}.`;
  return `Play ${title}.`;
}

export function episodeCard(episode, { id, season, show, progress, seasonAirDate, image, icon, today }) {
  const view = episodePresentation(episode, progress, { today, seasonAirDate });
  return `<button type="button" class="episode${view.upcoming ? ' is-upcoming' : ''}${view.started ? ' has-progress' : ''}" ${view.upcoming ? 'disabled' : 'data-action="play"'} data-type="tv" data-id="${esc(id)}" data-season="${esc(season)}" data-episode="${esc(episode.episode_number)}" data-title="${esc((show.name || show.title) + ' · S' + season + ' E' + episode.episode_number)}" aria-label="${esc(accessibleLabel(episode, view))}"><span class="episode-image">${image(episode.still_path || show.backdrop_path, '', 'w500')}<span class="episode-indicators" aria-hidden="true">${indicators(view, icon)}</span></span><strong>${esc(episode.episode_number)}. ${esc(episode.name || `Episode ${episode.episode_number}`)}</strong><p>${esc(episode.overview || 'Episode details are not available.')}</p></button>`;
}

export function mountEpisodeGrid(section, { id, show, profileId, api, image, icon }) {
  const select = section.querySelector('#season'), grid = section.querySelector('#episode-grid');
  const notice = document.createElement('p');
  notice.className = 'episode-notice muted'; notice.setAttribute('role', 'status'); notice.hidden = true;
  grid.before(notice);
  let disposed = false, revision = 0, metadata, history = new Map(), metadataController, historyController;
  const current = version => !disposed && version === revision && section.isConnected;
  const seasonAirDate = () => metadata?.air_date || show.seasons?.find(season => season.season_number === Number(select.value))?.air_date;
  const options = episode => ({ id, season: select.value, show, image, icon, progress: history.get(episode.episode_number), seasonAirDate: seasonAirDate() });
  function update() {
    if (!metadata) return;
    const episodes = new Map((metadata.episodes || []).map(episode => [episode.episode_number, episode]));
    for (const button of grid.querySelectorAll('.episode')) {
      const episode = episodes.get(Number(button.dataset.episode));
      if (!episode) continue;
      const view = episodePresentation(episode, history.get(episode.episode_number), { seasonAirDate: seasonAirDate() });
      button.disabled = view.upcoming;
      if (view.upcoming) delete button.dataset.action; else button.dataset.action = 'play';
      button.classList.toggle('is-upcoming', view.upcoming);
      button.classList.toggle('has-progress', view.started);
      button.setAttribute('aria-label', accessibleLabel(episode, view));
      button.querySelector('.episode-indicators').innerHTML = indicators(view, icon);
    }
  }
  async function refresh() {
    if (disposed || !select.value) return;
    historyController?.abort();
    const controller = historyController = new AbortController(), version = revision;
    try {
      const data = await api('episode-progress?' + new URLSearchParams({ id, season: select.value, profileId }), { signal: controller.signal, timeoutMs: 8000 });
      if (!current(version) || controller.signal.aborted) return;
      history = new Map(data.items.map(item => [item.episode, item]));
      notice.hidden = true; update();
    } catch {
      if (!current(version) || controller.signal.aborted) return;
      notice.textContent = 'Watch history is temporarily unavailable.'; notice.hidden = false;
    }
  }
  async function load() {
    const version = ++revision;
    metadataController?.abort(); historyController?.abort();
    metadata = null; history = new Map(); notice.hidden = true;
    if (!select.value) { grid.innerHTML = '<p class="muted">No episodes available yet.</p>'; return; }
    const controller = metadataController = new AbortController();
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
    const progress = refresh();
    try {
      const data = await api('episodes?' + new URLSearchParams({ id, season: select.value }), { signal: controller.signal, timeoutMs: 25000 });
      if (!current(version)) return;
      metadata = data;
      grid.innerHTML = (data.episodes || []).map(episode => episodeCard(episode, options(episode))).join('') || '<p class="muted">No episodes available for this season.</p>';
    } catch (error) {
      if (!current(version)) return;
      grid.innerHTML = `<div class="empty"><p>${esc(error.message)}</p><button type="button" class="btn" data-retry-episodes>Try again</button></div>`;
    } finally {
      if (current(version)) grid.setAttribute('aria-busy', 'false');
    }
    await progress;
  }
  const retry = event => { if (event.target.closest('[data-retry-episodes]')) load(); };
  select.addEventListener('change', load);
  grid.addEventListener('click', retry);
  const ready = load();
  return { ready, refresh, destroy() {
    disposed = true; metadataController?.abort(); historyController?.abort();
    select.removeEventListener('change', load); grid.removeEventListener('click', retry);
  } };
}
