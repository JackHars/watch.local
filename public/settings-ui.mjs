const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const groups = [
  { label: 'Watching', items: [
    { id: 'playback', icon: 'play', label: 'Playback', description: 'Video quality, source caching, and wait limits.', keywords: 'resolution timeout buffering streams' },
    { id: 'providers', icon: 'layers', label: 'Movie & series providers', description: 'Choose sources and their fallback order.', keywords: 'priority enable disable reorder' },
    { id: 'live', icon: 'tv', label: 'Live TV & sports', description: 'Channel sources and sports fallbacks.', keywords: 'zlive timstreams strmfree broadcasts' },
    { id: 'library', icon: 'film', label: 'IPTV catalog', description: 'Library size, refresh schedule, and indexing.', keywords: 'movies series channels playlist pages' },
    { id: 'metadata', icon: 'info', label: 'Artwork & title info', description: 'Catalog information and your TMDB credential.', keywords: 'metadata api key token upcoming seasons episodes' },
  ] },
  { label: 'Connections & accounts', items: [
    { id: 'connections', icon: 'tv', label: 'IPTV connections', description: 'Server URL, player credentials, and playlists.', keywords: 'xtream codes m3u xmltv guide password', viewer: true },
    { id: 'users', icon: 'user', label: 'Users & permissions', description: 'Add users and manage server access.', keywords: 'admin viewer accounts logins expiry' },
    { id: 'account', icon: 'user', label: 'My account', description: 'Your username, password, and sign-in.', keywords: 'login logout sign out', viewer: true },
  ] },
  { label: 'Server', items: [
    { id: 'general', icon: 'settings', label: 'Network & access', description: 'Local address, ports, discovery, and LAN login.', keywords: 'general server name hostname mdns port 80 ip address' },
    { id: 'updates', icon: 'refresh', label: 'Updates', description: 'Automatic updates, restart, and updater repair.', keywords: 'github version install upgrade' },
    { id: 'activity', icon: 'activity', label: 'Activity', description: 'Recent requests and troubleshooting.', keywords: 'logs errors status diagnostics' },
  ] },
];

export function settingsGroups(role) {
  return groups.map(group => ({ ...group, items: group.items.filter(item => role === 'admin' || item.viewer) })).filter(group => group.items.length);
}

export function settingsNavigation(section, role, icon) {
  const available = settingsGroups(role);
  const link = item => `<a href="#settings/${item.id}" ${section === item.id ? 'class="active" aria-current="page"' : ''}>${icon(item.icon)}<span>${item.label}</span></a>`;
  const sidebar = `<nav class="settings-sidebar" aria-label="Settings"><a class="settings-overview-link ${section === 'overview' ? 'active' : ''}" href="#settings" ${section === 'overview' ? 'aria-current="page"' : ''}>${icon('settings')}All settings</a>${available.map(group => `<div class="settings-nav-group"><h3>${group.label}</h3>${group.items.map(link).join('')}</div>`).join('')}<a class="settings-return" href="#home">${icon('left')}Back to watching</a></nav>`;
  const mobile = section === 'overview' ? '' : `<nav class="settings-mobile-nav" aria-label="Settings"><a href="#settings">${icon('left')}Settings</a><label class="settings-jump"><span class="sr-only">Settings section</span><select id="settings-section">${available.map(group => `<optgroup label="${group.label}">${group.items.map(item => `<option value="${item.id}" ${item.id === section ? 'selected' : ''}>${item.label}</option>`).join('')}</optgroup>`).join('')}</select></label></nav>`;
  return sidebar + mobile;
}

export function settingsOverview(role, icon) {
  return `<label class="settings-search">${icon('search')}<span class="sr-only">Search settings</span><input id="settings-search" type="search" placeholder="Find a setting" autocomplete="off"></label><div class="settings-directory">${settingsGroups(role).map(group => `<section class="settings-group"><h3>${group.label}</h3><div class="settings-group-links">${group.items.map(item => `<a class="settings-entry" href="#settings/${item.id}" data-settings-search="${escape(`${group.label} ${item.label} ${item.description} ${item.keywords}`.toLowerCase())}"><span class="settings-entry-icon">${icon(item.icon)}</span><span class="settings-entry-copy"><strong>${item.label}</strong><small>${item.description}</small></span>${icon('right')}</a>`).join('')}</div></section>`).join('')}</div><p class="settings-no-results" id="settings-no-results" role="status" hidden>No matching settings. Try “login”, “quality”, or “updates”.</p>`;
}

export function mountSettingsNavigation(root) {
  const jump = root.querySelector('#settings-section');
  if (jump) jump.onchange = () => { location.hash = `settings/${jump.value}`; };
  const search = root.querySelector('#settings-search');
  if (search) search.oninput = () => {
    const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let matches = 0;
    for (const group of root.querySelectorAll('.settings-group')) {
      let groupMatches = 0;
      for (const entry of group.querySelectorAll('[data-settings-search]')) {
        entry.hidden = !terms.every(term => entry.dataset.settingsSearch.includes(term));
        if (!entry.hidden) groupMatches++;
      }
      group.hidden = groupMatches === 0;
      matches += groupMatches;
    }
    root.querySelector('#settings-no-results').hidden = matches > 0;
  };
}

// Each page saves only the controls it owns. Reordering providers must never
// reset live sources or playback preferences on the other settings pages.
export function settingsPatch(section, values, playback) {
  switch (section) {
    case 'updates': return { updates: { enabled: values.enabled === 'on', intervalMinutes: Number(values.intervalMinutes) } };
    case 'metadata': return { metadata: { tmdbFallback: values.tmdbFallback === 'on' } };
    case 'general': return { server: { ...values, port: Number(values.port), webPort80: values.webPort80 === 'on', requireLanLogin: values.requireLanLogin === 'on', mdns: values.mdns === 'on' } };
    case 'library': return { catalog: { pages: Number(values.pages), refreshHours: Number(values.refreshHours) } };
    case 'providers': return { playback: { order: [...playback.order], enabled: [...playback.enabled] } };
    case 'live': return { live: { timstreams: values.liveTimstreams === 'on', zlive: values.liveZlive === 'on', sports: values.liveSports === 'on', strmfree: values.liveStrmfree === 'on' } };
    case 'playback': return { playback: { quality: values.quality, providerTimeout: Number(values.providerTimeout), totalTimeout: Number(values.totalTimeout), cacheSeconds: Number(values.cacheSeconds) } };
    default: throw Error('Unknown settings section.');
  }
}
