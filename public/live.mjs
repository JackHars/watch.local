import { liveCategories, liveTopics, liveCategory, topicsFor, countryName, filterLiveItems, sortLiveItems } from './live-model.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sports = new Set(['nba','nfl','nhl','mlb','cfb','soccer','mma','boxing','wwe','f1','cfl']);
const stadium = '<svg viewBox="0 0 240 140" aria-hidden="true"><rect x="20" y="20" width="200" height="100" rx="30"/><path d="M120 20v100M20 45h28v50H20M220 45h-28v50h28"/><circle cx="120" cy="70" r="24"/></svg>';
const defaults = { view: 'browse', category: 'all', country: 'all', topic: 'all', query: '', order: 'name' };
let remembered = { ...defaults };
const topicIcons = { globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z', music:'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3h3m12 1a3 3 0 1 1-3-3h3', smile:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 9h.01M16 9h.01M8 14s1 3 4 3 4-3 4-3', flag:'M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0' };
const categoryIcon = (name, icon) => topicIcons[name] ? `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${topicIcons[name]}"/></svg>` : icon(name);
const countText = items => {
  const channels = items.filter(item => item.kind === 'channel').length, events = items.length - channels;
  return [channels ? `${channels} channel${channels === 1 ? '' : 's'}` : '', events ? `${events} event${events === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'No matches';
};

function eventTime(item) {
  if (item.always_live) return 'Live coverage';
  const date = new Date(Number(item.starts_at) * 1000);
  if (!(item.starts_at > 0) || !Number.isFinite(date.getTime())) return 'Time to be announced';
  const today = new Date(), tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const day = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : new Intl.DateTimeFormat(undefined, { weekday:'short', month:'short', day:'numeric' }).format(date);
  return `<time datetime="${date.toISOString()}">${escape(day)} · ${escape(new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(date))}</time>`;
}

function eventCard(item, icon) {
  const live = item.status === 'LIVE', teams = String(item.title || item.name || 'Live event').split(/\s+(?:vs\.?|v|@)\s+/i);
  const initials = name => [...name.trim().split(/\s+/).map(word => Array.from(word)[0] || '')].slice(0, 3).join('').toUpperCase();
  const fallback = `<div class="live-art-fallback" aria-hidden="true">${stadium}<div class="live-matchup">${teams.length === 2 ? `<span>${escape(initials(teams[0]))}</span><small>VS</small><span>${escape(initials(teams[1]))}</span>` : `<span class="live-sport-mark">${escape(item.category_name || 'SPORTS')}</span>`}</div></div>`;
  return `<article class="live-card event-card" data-sport="${sports.has(item.sport) ? item.sport : 'other'}" data-stream-id="${item.stream_id}">
    <div class="live-artwork">${fallback}${item.artwork ? `<img class="live-image" src="${escape(item.artwork)}" alt="" width="1280" height="720" loading="lazy" decoding="async">` : ''}<div class="live-art-labels"><span class="live-league">${escape(item.category_name)}</span><span class="live-status ${live ? 'is-live' : ''}">${live ? '<span aria-hidden="true"></span>Live' : item.status === 'UPCOMING' ? 'Upcoming' : 'Event'}</span></div></div>
    <div class="live-card-body"><h3>${escape(item.title)}</h3><p class="live-time">${icon('clock')}${eventTime(item)}</p><button class="btn primary live-watch" data-action="play" data-type="live" data-provider="sports" data-id="${item.stream_id}" data-title="${escape(item.name)}" aria-label="Watch ${escape(item.title)}">${icon('play')}${live ? 'Watch live' : 'Watch event'}</button></div></article>`;
}

function channelCard(item, icon) {
  const progress = item.program && item.ends_at > item.starts_at ? Math.max(0, Math.min(100, (Date.now() / 1000 - item.starts_at) / (item.ends_at - item.starts_at) * 100)) : null;
  const accent = /^#[\da-f]{6}$/i.test(item.accent) ? item.accent : '#527de0';
  return `<button type="button" class="channel-tile" data-stream-id="${item.stream_id}" data-action="play" data-type="live" data-provider="${escape(item.provider)}" data-id="${item.stream_id}" data-title="${escape(item.name)}" aria-label="Watch ${escape(item.title)}${item.program ? ' — ' + escape(item.program) : ''}" style="--channel-accent:${accent}">
    <span class="channel-art"><span class="channel-art-pattern" aria-hidden="true"></span><span class="channel-wordmark" aria-hidden="true">${escape(item.title)}</span>${item.artwork ? `<img class="channel-logo ${item.white_logo ? 'white-ink' : ''} ${item.logo_plate ? 'logo-plate' : ''}" src="${escape(item.artwork)}" alt="" loading="lazy" decoding="async" width="320" height="180">` : ''}<span class="channel-play" aria-hidden="true">${icon('play')}</span>${item.quality ? `<span class="channel-definition">${escape(item.quality)}</span>` : ''}</span>
    <span class="channel-copy"><strong class="channel-title">${escape(item.title)}</strong><span class="channel-region">${escape(item.region || countryName(item.country))}</span><span class="channel-program ${item.program ? 'has-program' : ''}">${item.program ? '<span class="on-air-dot" aria-hidden="true"></span>' : ''}${escape(item.program || item.category_name || 'Live TV')}</span>${progress !== null ? `<span class="channel-progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></span>` : ''}</span></button>`;
}

export function livePage(items, icon) {
  return `<div class="page live-page"><div class="page-head live-heading"><div><h1>Live TV</h1><p>Find your channel. Find your next favourite.</p></div><button class="btn ghost live-refresh" data-action="refresh-live" aria-label="Refresh live TV">${icon('refresh')}<span>Refresh</span></button></div>
    <div class="live-toolbar"><div class="live-view-switch" role="group" aria-label="Browse live TV">${[['browse','Discover'],['channels','All channels'],['events','Live sports']].map(([id, name]) => `<button type="button" data-live-view="${id}" aria-pressed="false">${name}</button>`).join('')}</div><label class="live-search">${icon('search')}<input id="live-search" type="search" placeholder="Search channels, shows or sports" aria-label="Search live TV" autocomplete="off"></label></div>
    <div class="live-categories" role="group" aria-label="Categories"></div>
    <div class="live-mobile-filters"><select id="live-category" aria-label="Category"></select><button type="button" class="live-filter-toggle" aria-expanded="false" aria-controls="live-refinements">${icon('settings')}<span>Filters</span><small></small></button></div>
    <div class="live-refinements" id="live-refinements"><label><span>Country</span><select id="live-country" aria-label="Channel country"><option value="all">All countries</option></select></label><label class="live-topic-field" hidden><span>Sport</span><select id="live-topic" aria-label="Sport"><option value="all">All sports</option></select></label><label><span>Sort</span><select id="live-order" aria-label="Sort channels"><option value="name">A–Z</option><option value="live">Live now first</option></select></label><button type="button" class="live-reset text-link" data-live-reset hidden>Clear filters</button></div>
    <div class="live-results-heading"><h2 id="live-results-title">Browse channels</h2><p class="live-count" role="status" aria-live="polite"></p></div><div id="live-results"></div></div>`;
}

export function mountLivePage(root, items, icon) {
  const filters = { ...remembered }; let limit = 24;
  const search = root.querySelector('#live-search'), country = root.querySelector('#live-country'), topic = root.querySelector('#live-topic'), order = root.querySelector('#live-order'), categorySelect = root.querySelector('#live-category'), filterToggle = root.querySelector('.live-filter-toggle');
  const countries = [...new Set(items.filter(i => i.kind === 'channel').map(i => i.country || 'INT'))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  country.innerHTML += countries.map(code => `<option value="${escape(code)}">${escape(countryName(code))}</option>`).join('');
  if (!countries.includes(filters.country)) filters.country = 'all';
  search.value = filters.query; country.value = filters.country; order.value = filters.order;
  const kind = () => filters.view === 'channels' ? 'channel' : filters.view === 'events' ? 'event' : 'all';
  const available = overrides => filterLiveItems(items, { ...filters, kind: kind(), ...overrides });
  const cards = (rows, rail = false) => `<div class="${rail ? 'channel-rail' : 'channel-grid'}">${rows.map(i => channelCard(i, icon)).join('')}</div>`;
  function images() {
    root.querySelectorAll('.channel-logo').forEach(img => {
      if (img.complete && img.naturalWidth) img.closest('.channel-art').classList.add('has-logo');
    });
  }
  root.addEventListener('load', event => { if (event.target.matches?.('.channel-logo')) event.target.closest('.channel-art').classList.add('has-logo'); }, true);
  root.addEventListener('error', event => { if (event.target.matches?.('.channel-logo,.live-image')) { event.target.closest('.channel-art')?.classList.remove('has-logo'); event.target.remove(); } }, true);
  function render() {
    root.querySelectorAll('[data-live-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.liveView === filters.view)));
    const facetItems = available({ category: 'all', topic: 'all' });
    const categories = liveCategories.filter(c => items.some(i => liveCategory(i) === c.id && (kind() === 'all' || i.kind === kind())));
    const categoryOptions = [{ id:'all', name:'All categories', icon:'layers' }, ...categories];
    root.querySelector('.live-categories').innerHTML = categoryOptions.map(c => {
      const count = facetItems.filter(i => c.id === 'all' || liveCategory(i) === c.id).length;
      return `<button type="button" data-live-category="${c.id}" aria-pressed="${c.id === filters.category}" ${!count && c.id !== filters.category ? 'disabled' : ''}>${categoryIcon(c.icon, icon)}<span>${escape(c.name)}</span><small>${count}</small></button>`;
    }).join('');
    categorySelect.innerHTML = categoryOptions.map(c => {
      const count = facetItems.filter(i => c.id === 'all' || liveCategory(i) === c.id).length;
      return `<option value="${c.id}" ${!count && c.id !== filters.category ? 'disabled' : ''}>${escape(c.name)} · ${count}</option>`;
    }).join('');
    categorySelect.value = filters.category;
    const sportsItems = available({ topic: 'all' });
    const topics = [...new Set(sportsItems.flatMap(topicsFor))].filter(t => liveTopics[t]).sort((a,b) => liveTopics[a].localeCompare(liveTopics[b]));
    if (!topics.includes(filters.topic)) filters.topic = 'all';
    topic.innerHTML = '<option value="all">All sports</option>' + topics.map(t => `<option value="${t}">${liveTopics[t]}</option>`).join(''); topic.value = filters.topic;
    root.querySelector('.live-topic-field').hidden = !['sports','motorsports'].includes(filters.category) && filters.view !== 'events' || !topics.length;
    country.closest('label').hidden = filters.view === 'events';
    const active = filters.category !== 'all' || filters.country !== 'all' || filters.topic !== 'all' || filters.query.trim();
    root.querySelector('[data-live-reset]').hidden = !active;
    const refinementCount = Number(filters.country !== 'all') + Number(filters.topic !== 'all') + Number(filters.order !== 'name');
    filterToggle.querySelector('small').textContent = refinementCount || '';
    const filtered = sortLiveItems(available(), filters.order), channels = filtered.filter(i => i.kind === 'channel'), events = filtered.filter(i => i.kind !== 'channel');
    root.querySelector('.live-count').textContent = countText(filtered);
    const overview = filters.view === 'browse' && !active;
    root.querySelector('#live-results-title').textContent = filters.query.trim() ? 'Search results' : filters.category !== 'all' ? liveCategories.find(c => c.id === filters.category)?.name || 'Channels' : filters.view === 'events' ? 'Live & upcoming' : filters.view === 'channels' ? 'All channels' : 'On your TV';
    const result = root.querySelector('#live-results');
    if (!filtered.length) result.innerHTML = `<div class="empty live-empty">${icon('tv')}<h3>No matches</h3><p>${items.length ? 'Try another channel, country or category.' : 'Check your Live TV providers in Settings or refresh shortly.'}</p>${active ? '<button type="button" class="btn" data-live-reset>Clear filters</button>' : ''}</div>`;
    else if (overview) {
      const eventSection = (events.length ? `<section class="live-section"><div class="live-section-head"><div><h2>Live & upcoming</h2><p>The game starts here.</p></div><button type="button" class="text-link" data-live-view="events">See all ${events.length} ${icon('right')}</button></div><div class="live-grid">${events.slice(0, 3).map(i => eventCard(i, icon)).join('')}</div></section>` : '');
      const sections = categories.map(category => {
        const group = channels.filter(i => liveCategory(i) === category.id); if (!group.length) return '';
        return `<section class="live-section"><div class="live-section-head"><div><h2>${category.name}</h2><p>${category.description}</p></div><button type="button" class="text-link" data-live-category="${category.id}" data-live-show-all>See all ${group.length} ${icon('right')}</button></div>${cards(group.slice(0, 8), true)}</section>`;
      });
      sections.splice(2, 0, eventSection);
      result.innerHTML = sections.join('');
    } else {
      // Show every matching feed, including backups, without mounting hundreds
      // of image cards at once on a phone. All results remain reachable.
      const shown = filtered.slice(0, limit), shownChannels = shown.filter(i => i.kind === 'channel'), shownEvents = shown.filter(i => i.kind !== 'channel');
      result.innerHTML = (shownChannels.length ? cards(shownChannels) : '') + (shownEvents.length ? `<div class="live-grid live-event-results">${shownEvents.map(i => eventCard(i, icon)).join('')}</div>` : '') + (filtered.length > limit ? `<div class="live-more"><p>Showing ${Math.min(limit,filtered.length)} of ${filtered.length}</p><button type="button" class="btn" data-live-more>Show more</button></div>` : '');
    }
    images();
    remembered = { ...filters };
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-live-view],[data-live-category],[data-live-reset],[data-live-more]'); if (!button) return;
    if (button.hasAttribute('data-live-more')) { limit += 24; render(); return; }
    if (button.hasAttribute('data-live-reset')) Object.assign(filters, defaults, { view: filters.view });
    else if (button.dataset.liveView) { filters.view = button.dataset.liveView; filters.category = 'all'; filters.topic = 'all'; if (filters.view === 'events') filters.country = 'all'; }
    else { filters.category = button.dataset.liveCategory; filters.topic = 'all'; if (button.hasAttribute('data-live-show-all')) filters.view = 'channels'; }
    search.value = filters.query; country.value = filters.country; order.value = filters.order; limit = 24; render();
    if (button.hasAttribute('data-live-show-all')) root.querySelector('.live-toolbar').scrollIntoView({ block:'start', behavior:'instant' });
  });
  search.addEventListener('input', () => { filters.query = search.value; limit = 24; render(); });
  categorySelect.addEventListener('change', () => { filters.category = categorySelect.value; filters.topic = 'all'; limit = 24; render(); });
  filterToggle.addEventListener('click', () => {
    const expanded = filterToggle.getAttribute('aria-expanded') !== 'true';
    filterToggle.setAttribute('aria-expanded', String(expanded));
    root.classList.toggle('filters-open', expanded);
  });
  for (const [element, key] of [[country,'country'],[topic,'topic'],[order,'order']]) element.addEventListener('change', () => { filters[key] = element.value; limit = 24; render(); });
  render();
}
