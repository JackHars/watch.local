const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sports = new Set(['nba','nfl','nhl','mlb','cfb','soccer','mma','boxing','wwe','f1','cfl']);
const stadium = '<svg viewBox="0 0 240 140" aria-hidden="true"><rect x="20" y="20" width="200" height="100" rx="30"/><path d="M120 20v100M20 45h28v50H20M220 45h-28v50h28"/><circle cx="120" cy="70" r="24"/></svg>';

function eventTime(item) {
  if (item.always_live) return 'Live coverage';
  const date = new Date(Number(item.starts_at) * 1000);
  if (!(item.starts_at > 0) || !Number.isFinite(date.getTime())) return 'Time to be announced';
  const today = new Date(), tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);
  const day = date.toDateString() === today.toDateString() ? 'Today'
    : date.toDateString() === tomorrow.toDateString() ? 'Tomorrow'
    : new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(date);
  const time = new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date);
  return `<time datetime="${date.toISOString()}">${escape(day)} · ${escape(time)}</time>`;
}

function fallback(item) {
  const teams = String(item.title || item.name || 'Live event').split(/\s+(?:vs\.?|v|@)\s+/i);
  const initials = name => [...name.trim().split(/\s+/).map(word=>Array.from(word)[0]||'')].slice(0,3).join('').toUpperCase();
  return `<div class="live-art-fallback" aria-hidden="true">${stadium}<div class="live-matchup">${teams.length===2?`<span>${escape(initials(teams[0]))}</span><small>VS</small><span>${escape(initials(teams[1]))}</span>`:`<span class="live-sport-mark">${escape(item.category_name||'SPORTS')}</span>`}</div></div>`;
}

function card(item, icon) {
  const live = item.status === 'LIVE', status = live ? 'Live' : item.status === 'UPCOMING' ? 'Upcoming' : 'Event';
  const sport = sports.has(item.sport) ? item.sport : 'other';
  return `<article class="live-card" data-sport="${sport}" data-stream-id="${item.stream_id}">
    <div class="live-artwork">${fallback(item)}${item.artwork?`<img class="live-image" src="${escape(item.artwork)}" alt="" width="1280" height="720" loading="lazy" decoding="async">`:''}<div class="live-art-labels"><span class="live-league">${escape(item.category_name)}</span><span class="live-status ${live?'is-live':''}">${live?'<span aria-hidden="true"></span>':''}${status}</span></div></div>
    <div class="live-card-body"><h2>${escape(item.title)}</h2><p class="live-time">${icon('clock')}${eventTime(item)}</p><button class="btn primary live-watch" data-action="play" data-type="live" data-id="${item.stream_id}" data-title="${escape(item.name)}" aria-label="Watch ${escape(item.title)}">${icon('play')}${live?'Watch live':'Watch event'}</button></div>
  </article>`;
}

export function livePage(items, icon) {
  const categories = [...new Map(items.map(item=>[item.sport,item.category_name])).entries()];
  return `<div class="page live-page"><div class="page-head live-heading"><div><h1>Live</h1><p>Live sports and upcoming events.</p></div><button class="btn ghost live-refresh" data-action="reload" aria-label="Refresh live events">${icon('refresh')}<span>Refresh</span></button></div>
    ${items.length?`${categories.length>1?`<div class="live-filters" role="group" aria-label="Filter events by sport"><button type="button" data-live-sport="all" aria-pressed="true" aria-controls="live-grid">All sports</button>${categories.map(([sport,name])=>`<button type="button" data-live-sport="${escape(sport)}" aria-pressed="false" aria-controls="live-grid">${escape(name)}</button>`).join('')}</div>`:''}<p class="live-count" role="status" aria-live="polite">${items.length} event${items.length===1?'':'s'}</p><div class="live-grid" id="live-grid">${items.map(item=>card(item,icon)).join('')}</div>`:`<div class="empty">${icon('tv')}<h2>No events scheduled</h2><p>Check back for the next game or broadcast.</p></div>`}</div>`;
}

export function mountLivePage(root, items, icon) {
  root.addEventListener('error',event=>{
    if (event.target.matches?.('.live-image')) event.target.remove();
  },true);
  // Cached failures can happen before the delegated listener is attached.
  root.querySelectorAll('.live-image').forEach(image=>{if(image.complete&&!image.naturalWidth)image.remove();});
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-live-sport]');if(!button)return;
    const sport=button.dataset.liveSport,filtered=sport==='all'?items:items.filter(item=>item.sport===sport);
    root.querySelectorAll('[data-live-sport]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));
    root.querySelector('#live-grid').innerHTML=filtered.map(item=>card(item,icon)).join('');
    root.querySelector('.live-count').textContent=`${filtered.length} event${filtered.length===1?'':'s'}${sport==='all'?'':' · '+button.textContent}`;
  });
}
