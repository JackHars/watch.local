const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sports = new Set(['nba','nfl','nhl','mlb','cfb','soccer','mma','boxing','wwe','f1','cfl']);
const stadium = '<svg viewBox="0 0 240 140" aria-hidden="true"><rect x="20" y="20" width="200" height="100" rx="30"/><path d="M120 20v100M20 45h28v50H20M220 45h-28v50h28"/><circle cx="120" cy="70" r="24"/></svg>';

function eventTime(item) {
  if (item.kind === 'channel') return escape(item.program || [item.region, item.quality].filter(Boolean).join(' · ') || 'Live channel');
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
  if (item.kind === 'channel') return `<div class="live-channel-art" aria-hidden="true"><span class="channel-provider">ZLIVE</span><strong>${escape(item.title)}</strong><span class="channel-quality">${escape([item.region, item.quality].filter(Boolean).join(' · '))}</span></div>`;
  const teams = String(item.title || item.name || 'Live event').split(/\s+(?:vs\.?|v|@)\s+/i);
  const initials = name => [...name.trim().split(/\s+/).map(word=>Array.from(word)[0]||'')].slice(0,3).join('').toUpperCase();
  return `<div class="live-art-fallback" aria-hidden="true">${stadium}<div class="live-matchup">${teams.length===2?`<span>${escape(initials(teams[0]))}</span><small>VS</small><span>${escape(initials(teams[1]))}</span>`:`<span class="live-sport-mark">${escape(item.category_name||'SPORTS')}</span>`}</div></div>`;
}

function card(item, icon) {
  const live = item.status === 'LIVE', channel = item.kind === 'channel', status = live ? 'Live' : item.status === 'UPCOMING' ? 'Upcoming' : channel ? 'Channel' : 'Event';
  const sport = sports.has(item.sport) ? item.sport : 'other';
  const accent = /^#[\da-f]{6}$/i.test(item.accent) ? item.accent : '#648bd9';
  return `<article class="live-card ${channel?'channel-card':''}" data-sport="${sport}" data-stream-id="${item.stream_id}" style="--channel-accent:${accent}">
    <div class="live-artwork">${fallback(item)}${item.artwork?`<img class="live-image" src="${escape(item.artwork)}" alt="" width="1280" height="720" loading="lazy" decoding="async">`:''}<div class="live-art-labels"><span class="live-league">${escape(item.category_name)}</span><span class="live-status ${live?'is-live':''}">${live?'<span aria-hidden="true"></span>':''}${status}</span></div></div>
    <div class="live-card-body"><h2>${escape(item.title)}</h2><p class="live-time">${icon(channel?'tv':'clock')}${eventTime(item)}</p><button class="btn primary live-watch" data-action="play" data-type="live" data-provider="${escape(item.provider)}" data-id="${item.stream_id}" data-title="${escape(item.name)}" aria-label="Watch ${escape(item.title)}">${icon('play')}${live?'Watch live':channel?'Watch channel':'Watch event'}</button></div>
  </article>`;
}

export function livePage(items, icon) {
  return `<div class="page live-page"><div class="page-head live-heading"><div><h1>Live TV</h1><p>Your channels, live sports and upcoming events.</p></div><button class="btn ghost live-refresh" data-action="refresh-live" aria-label="Refresh live TV">${icon('refresh')}<span>Refresh</span></button></div>
    <div class="live-filters live-provider-filters" role="group" aria-label="Live TV providers">${[['all','All'],['zlive','TV channels'],['sports','Sports events']].map(([id,name])=>`<button type="button" data-live-provider="${id}" aria-pressed="${id==='all'}" aria-controls="live-grid">${name}</button>`).join('')}</div>
    <div class="live-browse-controls"><label class="live-search">${icon('search')}<input id="live-search" type="search" placeholder="Find a channel or event" aria-label="Find a channel or event" autocomplete="off"></label><select id="live-category" aria-label="Live TV category"><option value="all">All categories</option></select></div>
    <p class="live-count" role="status" aria-live="polite"></p><div class="live-grid" id="live-grid"></div></div>`;
}

export function mountLivePage(root, items, icon) {
  root.addEventListener('error',event=>{
    if (event.target.matches?.('.live-image')) event.target.remove();
  },true);
  // Cached failures can happen before the delegated listener is attached.
  root.querySelectorAll('.live-image').forEach(image=>{if(image.complete&&!image.naturalWidth)image.remove();});
  let provider='all';
  const search=root.querySelector('#live-search'), category=root.querySelector('#live-category');
  const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const available=()=>items.filter(item=>provider==='all'||item.provider===provider);
  function categories(){category.innerHTML='<option value="all">All categories</option>'+[...new Map(available().map(item=>[item.category_id,item.category_name])).entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('');}
  function render(){
    const terms=normalize(search.value).trim().split(/\s+/).filter(Boolean);
    const filtered=available().filter(item=>(category.value==='all'||item.category_id===category.value)&&terms.every(term=>normalize([item.title,item.category_name,item.program,item.region].join(' ')).includes(term))).sort((a,b)=>Number(b.kind==='channel')-Number(a.kind==='channel'));
    const channels=filtered.filter(item=>item.kind==='channel').length,events=filtered.length-channels;
    root.querySelector('.live-count').textContent=[channels?`${channels} channel${channels===1?'':'s'}`:'',events?`${events} event${events===1?'':'s'}`:''].filter(Boolean).join(' · ')||'No matches';
    root.querySelector('#live-grid').innerHTML=filtered.length?filtered.map(item=>card(item,icon)).join(''):`<div class="empty live-empty">${icon('tv')}<h2>${items.length?'No matches':'No channels or events available'}</h2><p>${items.length?'Try another search or category.':'Check your Live TV providers in Settings or refresh shortly.'}</p></div>`;
  }
  root.addEventListener('click',event=>{const button=event.target.closest('[data-live-provider]');if(!button)return;provider=button.dataset.liveProvider;root.querySelectorAll('[data-live-provider]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));categories();render();});
  search.addEventListener('input',render);category.addEventListener('change',render);categories();render();
}
