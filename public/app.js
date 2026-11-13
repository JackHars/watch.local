import { createNavigation } from './navigation.mjs';
import { trackPlayback } from './watch-progress.mjs';
import { mobilePlaybackDevice, mobilePlaybackError, mobilePlayer } from './mobile-player.mjs';
import { profileAvatar, profilePicker, openProfileDialog, rememberedProfileId, rememberProfile } from './profiles.mjs';
import { homeCategories, featuredItems, mountHeroCarousel } from './home.mjs';
import { livePage, mountLivePage } from './live.mjs';
import { createUpdatePrompt } from './updates.mjs';
import { createRepairTerminal } from './update-repair.mjs';
import { watchlistPreference } from './preferences.mjs';
// Safari can mark a tapped select as focus-visible. Track how focus was
// reached without blurring controls, blocking selection, or changing the picker.
document.addEventListener('pointerdown',event=>{
  document.documentElement.dataset.input=['touch','pen'].includes(event.pointerType)?'touch':'pointer';
},{capture:true,passive:true});
document.addEventListener('keydown',event=>{
  if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&['Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))document.documentElement.dataset.input='keyboard';
},true);
const navigation = createNavigation();
const $ = (s, r = document) => r.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = { home:'m3 10 9-7 9 7v11h-6v-7H9v7H3Z',play:'m8 5 11 7-11 7Z',search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',left:'m15 6-6 6 6 6',right:'m9 6 6 6-6 6',up:'m6 15 6-6 6 6',down:'m6 9 6 6 6-6',close:'m6 6 12 12M6 18 18 6',plus:'M12 5v14M5 12h14',check:'m5 12 4 4L19 6',info:'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',tv:'M3 5h18v13H3ZM8 21h8',user:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a8 8 0 0 1 16 0v3',layers:'m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5',copy:'M9 8h11v13H9ZM5 16H3V3h11v2',eye:'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',logout:'M9 4H3v16h6M10 12h11m-5-5 5 5-5 5',refresh:'M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5',activity:'M2 12h4l3-8 6 16 3-8h4',film:'M3 3h18v18H3ZM7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4',bookmark:'M6 3h12v18l-6-4-6 4Z',clock:'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.info}"/></svg>`;
const state = { user:null, profile:null, profiles:[], lanAccess:false, name:'watch.local', route:0, page:1, query:'', settings:null, items:[], drag:null };
const repairTerminal = createRepairTerminal({ api });
const updatePrompt = createUpdatePrompt({ api, ready:()=>state.user?.role==='admin'&&Boolean(state.profile)&&!repairTerminal.active, busy:()=>Boolean(document.querySelector('dialog[open]')) });
let homeCarousel, stopSearch = () => {};
function stopHomeCarousel(){homeCarousel?.destroy();homeCarousel=null;}
const img = (path, size='w780') => path && /^\/[\w.\/-]+$/.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : '';
const image = (path, alt='', size='w780', eager=false) => path ? `<img src="${esc(img(path,size))}" alt="${esc(alt)}" loading="${eager?'eager':'lazy'}">` : '';
const title = item => item.title || item.name || 'Untitled';
const year = item => (item.release_date || item.first_air_date || '').slice(0,4);
const initials = user => (user.username||'U').slice(0,2).toUpperCase();
const names = {zlive:'ZLive',sports:'Live sports',strmfree:'Strmfree',cinejoy:'Cinejoy',atlantic:'Atlantic',tvids:'Tvids',zstream:'Zstream',vidrift:'Vidrift',vidsrc:'VidSrc'};
const subtitles = {cinejoy:'Cinejoy · four video mirrors',atlantic:'Athena, Aphrodite & Moscow',tvids:'Xpass · verified backup feeds',zstream:'Cinecat & P-Stream',vidrift:'7movies · Bigbang & Vexon',vidsrc:'IMDb-based video sources'};
async function api(path, options={}) {
  const response = await fetch('/ui/'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},body:options.body?JSON.stringify(options.body):undefined});
  const data = await response.json();
  if (!response.ok) { if(response.status===401 && path!=='login'){state.user=null;closePlayer();$('#dialog').close();renderLogin();} throw Error(data.error||'Unable to complete this request.'); }
  return data;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),3500);}
function errorBox(error){return `<div class="empty">${icon('info')}<h2>Something didn’t load</h2><p>${esc(error.message)}</p><button class="btn" data-action="reload">Try again</button></div>`;}
function setBusy(button,busy){button.disabled=busy;if(busy){button.dataset.label=button.innerHTML;button.textContent='Saving…';}else if(button.dataset.label)button.innerHTML=button.dataset.label;}
function nav(){
  const path=location.hash.slice(1)||'home';
  const page=path.startsWith('title/movie/')?'movies':path.startsWith('title/tv/')?'series':path.split('/')[0];
  const tabs=[['home','Discover','home'],['movies','Movies','film'],['series','Series','layers'],['live','Live','tv']];
  const link=(key,label,symbol)=>`<a href="#${key}" class="${page===key?'active':''}" ${page===key?'aria-current="page"':''}>${icon(symbol)}<span>${label}</span></a>`;
  return `<header class="topbar"><a class="logo" href="#home" aria-label="watch.local home"><img class="brand-mark" src="/brand.svg" alt="watch.local" width="422" height="72"></a><nav class="nav" aria-label="Main navigation">${tabs.map(tab=>link(...tab)).join('')}</nav><div class="nav-actions"><a href="#search" class="icon-btn search-shortcut" aria-label="Search">${icon('search')}</a><a href="#settings/${state.user.role==='admin'?'general':'connections'}" class="icon-btn" aria-label="Settings">${icon('settings')}</a><button class="icon-btn profile-switch" data-action="switch-profile" aria-label="Switch profile, ${esc(state.profile.name)}" title="${esc(state.profile.name)}">${profileAvatar(state.profile)}</button></div></header>
  <nav class="mobile-dock" aria-label="Mobile navigation"><div class="dock-tabs glass-surface" data-glass="dock-lens"><span class="glass-backdrop" aria-hidden="true"></span><span class="dock-selection" aria-hidden="true"></span>${tabs.map(([key,label,symbol])=>link(key,key==='home'?'Home':label,symbol)).join('')}</div><a href="#search" class="dock-search glass-surface ${page==='search'?'active':''}" data-glass="search-lens" aria-label="Search" ${page==='search'?'aria-current="page"':''}><span class="glass-backdrop" aria-hidden="true"></span>${icon('search')}</a></nav>`;
}
let navigationKey='', descriptionObserver;
function mountDescriptionToggle(){
  descriptionObserver?.disconnect();
  const description=$('.detail-hero .description'),button=$('[data-action=toggle-description]');
  if(!description||!button)return;
  const update=()=>{button.hidden=button.getAttribute('aria-expanded')!=='true'&&description.scrollHeight<=description.clientHeight+1;};
  descriptionObserver=new ResizeObserver(update);
  descriptionObserver.observe(description);
  update();
}

function shell(content){
  stopHomeCarousel();
  updatePrompt.check();
  const key=JSON.stringify([location.hash,state.user.id,state.user.role,state.user.username,state.name,state.profile.id]);
  if(navigationKey===key&&$('.topbar')&&$('#main')){$('#main').innerHTML=content;mountDescriptionToggle();return;}
  navigationKey=key;
  $('#app').innerHTML=nav()+`<main id="main" tabindex="-1">${content}</main>`;
  navigation.mount();
  mountDescriptionToggle();
}
function card(item,poster=false){const t=title(item),type=item.type||'movie';return `<a class="media-card" href="#title/${type}/${item.id}" aria-label="View ${esc(t)}"><div class="card-image">${image(poster?item.poster_path:item.backdrop_path||item.poster_path,t,poster?'w500':'w780')}<span class="card-play">${icon('play')}</span></div><div class="card-caption"><strong>${esc(t)}</strong><small>${type==='tv'?'Series':'Movie'}${year(item)?' · '+esc(year(item)):''}${item.vote_average?' · '+Number(item.vote_average).toFixed(1):''}</small></div></a>`;}
function rail(label,items,{poster=false,subtitle='',link=''}={}){return `<section class="rail-section"><div class="section-head"><div><h2>${label}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div><div class="rail-controls">${link?`<a class="text-link" href="${link}">See all</a>`:''}<button class="icon-btn" data-action="rail" data-direction="-1" aria-label="Scroll ${label} left">${icon('left')}</button><button class="icon-btn" data-action="rail" data-direction="1" aria-label="Scroll ${label} right">${icon('right')}</button></div></div><div class="rail ${poster?'poster':''}">${items.map(i=>card(i,poster)).join('')}</div></section>`;}
function continueWatchingRail(items){
  if(!items.length)return '';
  const cards=items.map(item=>{
    const remaining=Math.max(1,Math.ceil((item.duration-item.position)/60));
    const episode=item.type==='tv'?`S${item.season} · E${item.episode} · `:'';
    const percent=item.duration>0?Math.max(0,Math.min(100,item.position/item.duration*100)):0;
    const label=item.nextEpisode?'Up next':'Resume';
    const caption=episode+(item.nextEpisode?(item.episodeTitle||'Next episode'):remaining+' min left');
    return `<button class="media-card continue-card" data-action="play" data-type="${item.type}" data-id="${item.id}" ${item.type==='tv'?`data-season="${item.season}" data-episode="${item.episode}"`:''} data-title="${esc(item.title)}" aria-label="${label} ${esc(item.title)}, ${esc(caption)}"><div class="card-image">${image(item.backdrop_path||item.poster_path,item.title)}<span class="resume-badge">${icon('play')}${label}</span>${item.nextEpisode?'':`<span class="watch-progress" aria-hidden="true"><span style="width:${percent}%"></span></span>`}</div><div class="card-caption"><strong>${esc(item.title)}</strong><small>${esc(caption)}</small></div></button>`;
  }).join('');
  return `<section class="rail-section continue-watching" aria-labelledby="continue-watching-title"><div class="section-head"><div><h2 id="continue-watching-title">Continue Watching</h2><p>Pick up where you left off.</p></div><div class="rail-controls"><button class="icon-btn" data-action="rail" data-direction="-1" aria-label="Scroll Continue Watching left">${icon('left')}</button><button class="icon-btn" data-action="rail" data-direction="1" aria-label="Scroll Continue Watching right">${icon('right')}</button></div></div><div class="rail">${cards}</div></section>`;
}
async function refreshContinueWatching(){
  const slot=$('#continue-watching-slot'),version=state.route,userId=state.user?.id,profileId=state.profile?.id;
  if(!slot||!userId||!profileId||$('#player').open)return;
  try{const data=await api('progress?profileId='+profileId);if(version===state.route&&userId===state.user?.id&&profileId===state.profile?.id&&slot.isConnected&&!$('#player').open)slot.innerHTML=continueWatchingRail(data.items);}catch{/* Keep the last known row while offline. */}
}
function hero(item,detail=false,{featured=false,eager=true}={}){
  const type=item.type||'movie',art=img(item.backdrop_path||item.poster_path,'original');
  return `<section class="hero ${detail?'detail-hero':''}">${art?`<img class="hero-art" ${eager?'src':'data-src'}="${esc(art)}" alt="" decoding="async" ${eager?'fetchpriority="high"':''}>`:''}<div class="hero-copy">${featured?'<p class="hero-eyebrow">Trending Now</p>':''}<h1>${esc(title(item))}</h1><div class="meta"><span>${esc(year(item))}</span>${item.vote_average?`<span>★ ${Number(item.vote_average).toFixed(1)}</span>`:''}${item.runtime?`<span>${Math.floor(item.runtime/60)}h ${item.runtime%60}m</span>`:''}<span>${esc(item.genres?.slice(0,2).map(g=>g.name).join(' · ')|| (type==='tv'?'Series':'Movie'))}</span>${featured?'':'<span class="badge">HLS</span>'}</div><p class="description" ${detail?'id="hero-description"':''}>${esc(item.overview||'Explore this title and find a stream from your connected providers.')}</p>${detail?'<button type="button" class="description-toggle" data-action="toggle-description" aria-expanded="false" aria-controls="hero-description" hidden>Read more</button>':''}<div class="actions"><button class="btn primary" data-action="${type==='tv'?'episodes':'play'}" data-type="${type}" data-id="${item.id}" data-title="${esc(title(item))}">${icon('play')}${type==='tv'?'Browse episodes':'Play movie'}</button>${detail?`<button class="btn" data-action="save" data-id="${item.id}" data-type="${type}">${icon(saved(item)?'check':'plus')}${saved(item)?'In My List':'Add to My List'}</button>`:`<a class="btn" href="#title/${type}/${item.id}">${icon('info')}More info</a>`}</div></div>${featured?'':`<div class="hero-note">${icon('tv')}Watch here. Or in your favorite IPTV player.</div>`}</section>`;
}
function featuredCarousel(items){
  return `<section class="featured-carousel" aria-label="Trending now" aria-roledescription="carousel" data-index="0"><div class="featured-viewport"><div class="featured-track">${items.map((item,index)=>`<div class="featured-slide" data-slide role="group" aria-roledescription="slide" aria-label="${index+1} of ${items.length}: ${esc(title(item))}" aria-hidden="${index!==0}" ${index?'inert':''}>${hero(item,false,{featured:true,eager:index===0})}</div>`).join('')}</div></div>${items.length>1?`<div class="featured-controls"><button class="icon-btn carousel-arrow" data-carousel-step="-1" aria-label="Previous featured title">${icon('left')}</button><div class="featured-dots">${items.map((item,index)=>`<button data-carousel-index="${index}" aria-label="Show ${esc(title(item))}" ${index===0?'aria-current="true"':''}><span></span></button>`).join('')}</div><button class="icon-btn carousel-arrow" data-carousel-step="1" aria-label="Next featured title">${icon('right')}</button><button class="icon-btn carousel-toggle" data-carousel-toggle aria-label="Pause slideshow" aria-pressed="false"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button></div>`:''}</section>`;
}
function listKey(){return `watchlocal.list.${state.user.id}.${state.profile.id}`;}
function storedList(){return watchlistPreference(state.user.id,state.profile.id,state.profile.migrated||state.profiles[0]?.id===state.profile.id);}
function saved(item){return storedList().some(i=>i.id===item.id && i.type===item.type);}
function saveTitle(){const item=state.detail,list=storedList(),index=list.findIndex(i=>i.id===item.id&&i.type===item.type);if(index>=0)list.splice(index,1);else list.unshift(item);localStorage.setItem(listKey(),JSON.stringify(list.slice(0,100)));const button=$('[data-action=save]');button.innerHTML=icon(index>=0?'plus':'check')+(index>=0?'Add to My List':'In My List');toast(index>=0?'Removed from My List':'Added to My List');}
function renderLogin(){stopSearch();stopHomeCarousel();state.route++;state.settings=null;state.profile=null;state.profiles=[];viewPositions.clear();visibleRoute='';$('#app').innerHTML=`<main class="login-page" id="main"><div class="login-card"><img class="brand-mark" src="/brand.svg" alt="watch.local" width="422" height="72"><h1>Welcome to ${esc(state.name)}.</h1><p>Your next watch is waiting.</p><form id="login-form"><label class="field"><span>Username</span><input name="username" autocomplete="username" required autofocus></label><label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><p class="error" role="alert" id="login-error"></p><button class="btn primary" type="submit">Sign in ${icon('right')}</button></form><p class="hint">Use the account you created in the terminal,<br>or an account added by your administrator.</p></div></main>`;$('#login-form').onsubmit=async event=>{event.preventDefault();const button=$('button',event.target);setBusy(button,true);try{const data=await api('login',{method:'POST',body:Object.fromEntries(new FormData(event.target))});state.user=data.user;route();}catch(e){$('#login-error').textContent=e.message;}finally{setBusy(button,false);}};}
function tmdbForm(configured=false){return `<p class="tmdb-copy">A TMDB account is optional. Add your own credential if you want an additional fallback when upstream information is unavailable. <a class="text-link" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Get a TMDB credential ${icon('right')}</a></p><form id="tmdb-form"><label class="field"><span>${configured?'Replace API key or Read Access Token':'API key or Read Access Token'}</span><span class="field-row"><input id="tmdb-credential" name="credential" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="4096" required placeholder="Paste your TMDB credential"><button class="icon-btn" type="button" data-action="reveal" data-target="tmdb-credential" aria-label="Show TMDB credential">${icon('eye')}</button></span><small>${configured?'Leave the saved credential as it is, or enter a replacement.':'After saving, you can enable TMDB fallback above.'} Your credential stays on this server and is sent only to TMDB.</small></label><p class="error" id="tmdb-error" role="alert"></p><div class="actions"><button class="btn blue" type="submit">Verify and ${configured?'replace':'save'}</button>${configured?'<button class="btn ghost" type="button" data-action="remove-tmdb">Remove credential</button>':''}</div></form>`;}
function bindTMDBForm(){const form=$('#tmdb-form');if(!form)return;form.onsubmit=async event=>{event.preventDefault();const button=$('[type=submit]',form);setBusy(button,true);button.textContent='Checking with TMDB…';$('#tmdb-error').textContent='';try{await api('tmdb',{method:'PUT',body:{credential:form.elements.credential.value}});form.reset();toast('TMDB credential saved');route();}catch(error){const message=$('#tmdb-error');if(message)message.textContent=error.message;setBusy(button,false);}};}
function focusSearch(){
  window.scrollTo(0,0);
  $('#search')?.focus({preventScroll:true});
}
function openSearch(){
  if(!state.user||!state.profile)return;
  if(location.hash==='#search'&&$('#search'))return focusSearch();
  // Render and focus within the original click/keypress. A later hashchange
  // loses the user gesture iOS needs to bring up the software keyboard.
  if(location.hash!=='#search')history.pushState(null,'','#search');
  route({restoreScroll:false});
}
function renderSearch(version){
  shell(`<div class="page search-page"><div class="page-head"><div><h1>Search</h1><p>Find movies and shows.</p></div></div><form id="search-form" role="search"><label class="search-field">${icon('search')}<input id="search" type="search" placeholder="Movies, shows, and more" aria-label="Search titles" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" maxlength="200"></label></form><p id="search-status" class="muted" role="status" aria-live="polite"></p><div id="results"></div></div>`);
  const input=$('#search'),results=$('#results'),status=$('#search-status');
  let timer,controller,sequence=0;
  const empty=()=>`<div class="empty">${icon('search')}<h2>What are you in the mood for?</h2><p>Search by title to explore the catalog.</p></div>`;
  results.innerHTML=empty();
  function update(immediate=false){
    clearTimeout(timer);controller?.abort();
    const query=input.value.trim(),seq=++sequence;
    if(query.length<2){status.textContent='';results.removeAttribute('aria-busy');results.innerHTML=query?'<div class="empty"><p>Enter at least two characters.</p></div>':empty();return;}
    status.textContent='Searching…';results.setAttribute('aria-busy','true');
    results.innerHTML='<div class="empty"><div class="spinner" aria-hidden="true"></div></div>';
    const run=async()=>{
      if(version!==state.route)return;
      controller=new AbortController();
      try{
        const data=await api('browse?q='+encodeURIComponent(query),{signal:controller.signal});
        if(version!==state.route||seq!==sequence)return;
        status.textContent=data.items.length?`${data.items.length} ${data.items.length===1?'result':'results'} · Most relevant first`:'';
        results.innerHTML=data.items.length?`<div class="grid">${data.items.map(item=>card(item,true)).join('')}</div>`:'<div class="empty"><h2>No matching titles</h2><p>Try a different title or a shorter search.</p></div>';
      }catch(error){if(version===state.route&&seq===sequence&&error.name!=='AbortError'){status.textContent='';results.innerHTML=errorBox(error);}}
      finally{if(version===state.route&&seq===sequence)results.removeAttribute('aria-busy');}
    };
    if(immediate)run();else timer=setTimeout(run,250);
  }
  input.addEventListener('input',event=>{if(!event.isComposing)update();});
  input.addEventListener('compositionstart',()=>{clearTimeout(timer);controller?.abort();++sequence;});
  input.addEventListener('compositionend',()=>update());
  $('#search-form').addEventListener('submit',event=>{event.preventDefault();update(true);});
  stopSearch=()=>{clearTimeout(timer);++sequence;controller?.abort();};
  focusSearch();
}
history.scrollRestoration='manual';
const viewPositions=new Map();let visibleRoute='';
async function profilesPage(){
  stopHomeCarousel();
  const version=++state.route,userId=state.user?.id,rememberedId=rememberedProfileId(userId);
  state.profile=null;state.detail=null;navigationKey='';window.scrollTo(0,0);
  $('#app').innerHTML=rememberedId?'<div class="boot"><div class="spinner"></div><p>Opening your library…</p></div>':profilePicker([],{loading:true});
  try{
    const data=await api('profiles');if(version!==state.route||userId!==state.user?.id)return;
    state.profiles=data.profiles;
    const profile=state.profiles.find(profile=>profile.id===rememberedId);
    if(profile){state.profile=profile;return renderRoute();}
    if(rememberedId)rememberProfile(userId,null);
    $('#app').innerHTML=profilePicker(state.profiles);
  }
  catch(error){if(version===state.route&&userId===state.user?.id)$('#app').innerHTML=profilePicker([],{error:error.message});}
}
function addProfile(){
  const version=state.route,userId=state.user?.id;
  openProfileDialog($('#dialog'),{
    save:async input=>(await api('profiles',{method:'POST',body:input})).profile,
    created:async profile=>{if(version!==state.route||userId!==state.user?.id||state.profile)return;await profilesPage();$(`[data-profile-id="${profile.id}"]`)?.focus();},
  });
}
async function route({restoreScroll=true}={}){
  const next=location.hash||'#home',changed=next!==visibleRoute;
  if(changed&&visibleRoute&&state.profile){viewPositions.set(visibleRoute,{top:window.scrollY,rails:Object.fromEntries([...document.querySelectorAll('.rail')].map(rail=>[rail.closest('section')?.querySelector('h2')?.textContent,rail.scrollLeft]))});if(viewPositions.size>100)viewPositions.delete(viewPositions.keys().next().value);}
  visibleRoute=next;const pending=renderRoute(),version=state.route;await pending;
  const saved=restoreScroll&&changed&&viewPositions.get(next);
  if(saved&&version===state.route&&state.user&&state.profile){window.scrollTo(0,saved.top);document.querySelectorAll('.rail').forEach(rail=>rail.scrollLeft=saved.rails[rail.closest('section')?.querySelector('h2')?.textContent]||0);}
}
async function renderRoute(){stopSearch();if(!state.user)return renderLogin();if(!state.profile)return profilesPage();const version=++state.route;const [page,sub,id]=(location.hash.slice(1)||'home').split('/');state.page=1;window.scrollTo(0,0);
  if(page==='settings'){shell('<div class="page"><div class="empty"><div class="spinner"></div></div></div>');try{await settingsPage(sub||'general',version);}catch(e){if(version===state.route)shell(`<div class="page">${errorBox(e)}</div>`);}return;}
  if(page==='search'){renderSearch(version);return;}
  shell(`<div class="page"><div class="page-head"><h1>${page==='live'?'Live, right now.':page==='movies'?'Movies':page==='series'?'Series':'Your next watch.'}</h1></div><div class="grid">${Array.from({length:10},()=>'<div class="skeleton poster"></div>').join('')}</div></div>`);
  try{
    if(page==='title'){
      const data=await api(`title?type=${sub}&id=${id}`);if(version!==state.route)return;state.detail={...data,type:sub};shell(hero(state.detail,true)+`<div class="detail-body"><section class="detail-about"><div><h2>About ${esc(title(data))}</h2><p>${esc(data.overview)}</p></div><dl class="details-meta"><div><dt>Cast</dt><dd>${esc(data.credits?.cast?.slice(0,4).map(i=>i.name).join(', ')||'Not available')}</dd></div><div><dt>Genres</dt><dd>${esc(data.genres?.map(i=>i.name).join(', ')||'Not available')}</dd></div><div><dt>Language</dt><dd>${esc(data.original_language?.toUpperCase())}</dd></div><div><dt>Release</dt><dd>${esc(data.release_date||data.first_air_date||'Not announced')}</dd></div></dl></section>${sub==='tv'?`<section id="episodes"><div class="page-head"><h2>Episodes</h2><label class="field"><span class="sr-only">Season</span><select id="season">${(data.seasons||[]).filter(s=>s.episode_count>0).map(s=>`<option value="${s.season_number}" ${s.season_number===1?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label></div><div id="episode-grid" class="grid landscape"></div></section>`:''}</div>`);if(sub==='tv'){const load=async()=>{const grid=$('#episode-grid');grid.innerHTML='<div class="empty"><div class="spinner"></div></div>';try{const season=$('#season').value;const d=await api(`episodes?id=${id}&season=${season}`);if(version!==state.route||$('#season').value!==season)return;grid.innerHTML=(d.episodes||[]).map(e=>`<button class="episode" data-action="play" data-type="tv" data-id="${id}" data-season="${season}" data-episode="${e.episode_number}" data-title="${esc(title(data)+' · S'+season+' E'+e.episode_number)}">${image(e.still_path||data.backdrop_path,'','w500')}<strong>${e.episode_number}. ${esc(e.name)}</strong><p>${esc(e.overview||'Episode details are not available.')}</p></button>`).join('')||'<p class="muted">No episodes available for this season.</p>';}catch(e){if(version===state.route)grid.innerHTML=errorBox(e);}};$('#season').onchange=load;await load();}return;
    }
    if(page==='live'){const data=await api('live');if(version!==state.route)return;shell(livePage(data.items,icon));mountLivePage($('.live-page'),data.items,icon);return;}
    if(['movies','series'].includes(page)){
      const type=page==='series'?'tv':'movie',category=homeCategories.find(row=>row.type===type&&row.board===sub);
      const board=category?.board||'popular',label=category?.label||(type==='tv'?'Popular Shows':'Popular Movies');
      const data=await api(`browse?type=${type}&board=${board}`);if(version!==state.route)return;state.items=data.items;
      shell(`<div class="page"><div class="page-head"><div><h1>${esc(label)}</h1><p>${esc(category?.subtitle||'Explore popular titles from the catalog.')}</p></div></div><div class="grid" id="catalog-grid">${data.items.map(i=>card(i,true)).join('')}</div>${data.pages>1?`<div class="load-more"><button class="btn ghost" data-action="more" data-type="${type}" data-board="${board}">Load more ${icon('down')}</button></div>`:''}</div>`);return;
    }
    const results=await Promise.allSettled([
      api('browse?type=all&board=trending'),api('progress?profileId='+state.profile.id),
      ...homeCategories.map(row=>api(`browse?type=${row.type}&board=${row.board}`)),
    ]);if(version!==state.route)return;
    const [trending,watching,...rows]=results.map(result=>result.status==='fulfilled'?result.value.items:[]);
    const features=featuredItems(trending.length?trending:[...rows[1],...rows[2]]),list=storedList();
    const fallback=rows.flat().find(item=>item.backdrop_path)||list[0]||watching[0];
    if(!features.length&&!fallback)throw results[0].reason||Error('The catalog is temporarily unavailable.');
    shell((features.length?featuredCarousel(features):hero(fallback))+`<div class="browse-content"><div id="continue-watching-slot">${continueWatchingRail(watching)}</div>${list.length?rail('My List',list,{subtitle:'Saved for your next watch.'}):''}${homeCategories.map((row,index)=>rows[index].length?rail(row.label,rows[index],{poster:row.poster,subtitle:row.subtitle,link:`#${row.type==='tv'?'series':'movies'}/${row.board}`}):'').join('')}</div>`);
    if(features.length)homeCarousel=mountHeroCarousel($('.featured-carousel'));

  }catch(e){if(version===state.route&&state.user)shell(`<div class="page">${errorBox(e)}</div>`);}
}
function field(label,name,value,{type='text',hint='',placeholder='',min='',max='',required=false}={}){return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${placeholder?`placeholder="${esc(placeholder)}"`:''} ${min!==''?`min="${min}"`:''} ${max!==''?`max="${max}"`:''} ${required?'required':''} ${type==='password'?`autocomplete="${name==='currentPassword'?'current-password':'new-password'}"`:''}>${hint?`<small>${hint}</small>`:''}</label>`;}
function selectField(label,name,value,options){return `<label class="field"><span>${label}</span><select name="${name}">${options.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('')}</select></label>`;}
function toggle(label,checked,attrs=''){return `<label class="switch"><input type="checkbox" aria-label="${esc(label)}" ${checked?'checked':''} ${attrs}><span></span></label>`;}
function settingsShell(section,content){const links=state.user.role==='admin'?[['general','settings','General'],['updates','refresh','Updates'],['metadata','film','Metadata'],['connections','tv','IPTV connections'],['providers','layers','Providers'],['users','user','Users'],['library','film','Library'],['activity','activity','Activity'],['account','user','My account']]:[['connections','tv','IPTV connections'],['account','user','My account']];shell(`<div class="page"><div class="settings-shell"><aside class="settings-nav"><h1>Settings</h1>${links.map(([key,i,label])=>`<a href="#settings/${key}" class="${section===key?'active':''}" ${section===key?'aria-current="page"':''}>${icon(i)}${label}</a>`).join('')}<div class="settings-bottom"><a href="#home">${icon('left')}Back to watching</a><button class="text-link" data-action="logout">${state.lanAccess?'Switch account':'Sign out'}</button></div></aside><section class="settings-main">${content}</section></div></div>`);}
const settingsHeader=(title,subtitle)=>`<header><h2>${title}</h2><p>${subtitle}</p></header>`;
const saveBar=(hint='Changes apply immediately.')=>`<div class="settings-actions"><small>${hint}</small><button class="btn blue" type="submit">Save changes</button></div><p class="error" id="form-error" role="alert"></p>`;
async function settingsPage(section,version){
  if(section==='tmdb'){section='metadata';history.replaceState(null,'','#settings/metadata');}
  if(state.user.role==='admin')state.settings=await api('settings');else if(!['connections','account'].includes(section))section='connections';if(version!==state.route)return;
  const data=state.settings,config=data?.config;
  if(section==='updates'){
    settingsShell(section,settingsHeader('Updates','Keep watch.local up to date automatically.')+`<form id="config-form"><div class="panel"><div class="setting-row"><div><strong>Automatic updates</strong><p>Install new commits from main after GitHub checks pass. Updates briefly restart the server.</p></div>${toggle('Automatic updates',config.updates.enabled,'name="enabled"')}</div><div class="panel-pad">${field('Check every (minutes)','intervalMinutes',config.updates.intervalMinutes,{type:'number',min:5,max:1440,required:true,hint:'Choose 5–1440 minutes. Five minutes is the default.'})}</div></div>${saveBar('Your profiles, watch history, and server settings are preserved.')}</form><div class="panel panel-pad"><div id="update-status" role="status" aria-live="polite"><p class="muted">Loading update status…</p></div><div class="actions"><button class="btn ghost small" id="check-updates" type="button">${icon('refresh')}Check now</button><button class="btn ghost small" id="repair-updates" type="button">Repair automatic updates</button></div></div>`);
    $('#repair-updates').onclick=()=>repairTerminal.open();
    $('#check-updates').onclick=async()=>{const button=$('#check-updates');setBusy(button,true);try{await api('updates/check',{method:'POST',body:{}});toast('Update check queued. It will start within a minute.');}catch(error){toast(error.message);}finally{setBusy(button,false);await updateUpdateStatus();}};
    await updateUpdateStatus();
  }
  if(section==='metadata'){
    settingsShell(section,settingsHeader('Metadata','Artwork, title details, and episode lists.')+`<div class="panel panel-pad"><h3 class="panel-title">Public catalogs · no API key</h3><p class="tmdb-copy">Trending comes directly from TMDB’s public Today list. Other categories, search, movie details, and seasons use 7Movies and its mirror. No account or API key is required. Information is cached on this server to keep browsing fast and help through temporary outages.</p></div><form id="config-form"><div class="panel"><div class="setting-row"><div><strong>Use TMDB as a fallback</strong><p>Try TMDB when upstream providers cannot return the information.${config.metadata.configured?'':' Save a credential below to enable this.'}</p></div>${toggle('Use TMDB as a fallback',config.metadata.tmdbFallback,`name="tmdbFallback" ${config.metadata.configured?'':'disabled'}`)}</div></div>${saveBar('Upstream providers are always tried first.')}</form><div class="panel panel-pad"><h3 class="panel-title">Optional TMDB credential${config.metadata.configured?' · Saved':''}</h3>${tmdbForm(config.metadata.configured)}</div>`);
    bindTMDBForm();
  }
  if(section==='connections'){
    settingsShell(section,settingsHeader('IPTV connections','Connect an IPTV player on your network.')+`<div class="panel panel-pad">${state.user.role==='admin'?`<label class="field"><span>Connection details for</span><select id="connection-user">${data.users.map(u=>`<option value="${u.id}" ${u.id===state.user.id?'selected':''}>${esc(u.username)}${u.enabled?'':' (disabled)'}</option>`).join('')}</select></label>`:''}<div id="connection-fields"><div class="spinner"></div></div></div><div class="notice">${icon('info')}<div>In your IPTV app, choose <strong>Xtream Codes</strong> and enter the server URL, username, and password. Use the M3U link if your app asks for a playlist, and the XMLTV link for its guide. Select HLS / m3u8 for playback.</div></div>`);
    const load=async()=>{const id=$('#connection-user')?.value||state.user.id;try{const d=await api('connections?user='+encodeURIComponent(id));if(version!==state.route||($('#connection-user')?.value||state.user.id)!==id)return;$('#connection-fields').innerHTML=[['Server URL','server',false],['Username','username',false],['Password','password',true],['M3U playlist','playlist',true],['Live TV playlist','sports',true],['XMLTV guide','guide',true]].map(([label,k,secret])=>`<label class="field"><span>${label}</span><span class="field-row"><input id="conn-${k}" type="${secret?'password':'text'}" value="${esc(d[k])}" readonly ${secret?'autocomplete="off"':''}>${secret?`<button class="icon-btn" data-action="reveal" data-target="conn-${k}" aria-label="Show ${label}">${icon('eye')}</button>`:''}<button class="icon-btn" data-action="copy" data-target="conn-${k}" aria-label="Copy ${label}">${icon('copy')}</button></span></label>`).join('');}catch(e){if(version===state.route&&$('#connection-fields'))$('#connection-fields').innerHTML=errorBox(e);}};if($('#connection-user'))$('#connection-user').onchange=load;await load();return;
  }
  if(section==='general'){
    const iptvAddress=new URL(location.origin);iptvAddress.port=String(data.running.port);
    settingsShell(section,settingsHeader('General','Make this server your own.')+`<form id="config-form"><div class="panel panel-pad"><h3 class="panel-title">Server identity</h3>${field('Server name','name',config.server.name,{required:true})}${field('Advertised IPTV URL','publicUrl',config.server.publicUrl,{placeholder:iptvAddress.origin,hint:'Leave blank to use this server’s IPTV address. This changes IPTV links; it does not open ports or create a tunnel.'})}</div><div class="panel panel-pad"><h3 class="panel-title">Network</h3><div class="form-grid">${field('Listen address','host',config.server.host,{required:true,hint:'0.0.0.0 allows devices on your network.'})}${field('IPTV port','port',config.server.port,{type:'number',min:1,max:65535,required:true})}</div><div class="notice">${icon('info')}<span>Restart the server after changing the listen address, IPTV port, or port 80 option. Environment variables take priority over the listen address and IPTV port. Currently running: web on port ${data.running.webPort}, IPTV on port ${data.running.port}.</span></div>${data.running.webError?`<p class="error" role="alert">${esc(data.running.webError)}</p>`:''}</div><div class="panel"><div class="setting-row"><div><strong>Web interface on port 80</strong><p>Open the website without a port number. IPTV stays on its own port. Off by default; applies after a server restart. Docker installs must also publish port 80.</p></div>${toggle('Web interface on port 80',config.server.webPort80,'name="webPort80"')}</div><div class="setting-row"><div><strong>Require login on LAN</strong><p>Off: devices on your home network open the web panel as the owner. Turn on to require an account. IPTV players always need their credentials.</p></div>${toggle('Require login on LAN',config.server.requireLanLogin,'name="requireLanLogin"')}</div></div><div class="panel"><div class="setting-row"><div><strong>Local discovery</strong><p>Find this server at a .local address on your home network. No router setup needed. On by default.</p></div>${toggle('Local discovery',config.server.mdns,'name="mdns"')}</div><div class="panel-pad">${field('Local name','mdnsHostname',config.server.mdnsHostname,{required:true,maxlength:63,hint:'Enter a name such as watch. The .local ending is added automatically.'})}<div id="discovery-status" class="discovery-status" role="status" aria-live="polite"></div></div></div>${saveBar('Network changes require a restart. Other settings apply immediately.')}</form>`);
  }
  if(section==='providers')settingsShell(section,settingsHeader('Providers','Your preferred sources. In your preferred order.')+`<form id="config-form"><div class="panel panel-pad"><h3 class="panel-title">Live TV</h3><div class="setting-row"><div><strong>ZLive channels</strong><p>TV channels with entertainment, kids, sports and Formula 1.${data.live?.zlive?.channels?" "+data.live.zlive.channels+" channels indexed.":""}</p></div>${toggle("ZLive channels",config.live.zlive,'name="liveZlive"')}</div><div class="setting-row"><div><strong>Live sports events</strong><p>Scheduled games and upcoming broadcasts.</p></div>${toggle("Live sports events",config.live.sports,'name="liveSports"')}</div><div class="setting-row"><div><strong>Strmfree sports fallback</strong><p>Try another broadcast of the same game if the primary sports source fails. Enabled by default.</p></div>${toggle("Strmfree sports fallback",config.live.strmfree,'name="liveStrmfree"')}</div></div><h3 class="panel-title">Movies and series</h3><div class="panel" id="provider-list">${providerRows(config.playback)}</div><div class="notice">${icon('layers')}<span>Playback tries enabled providers from top to bottom. Drag to reorder, or use the arrow buttons. At least one provider must stay enabled.</span></div><div class="panel panel-pad"><h3 class="panel-title">Playback behavior</h3><div class="form-grid">${field('Time per provider (seconds)','providerTimeout',config.playback.providerTimeout,{type:'number',min:5,max:90,required:true})}${field('Overall wait limit (seconds)','totalTimeout',config.playback.totalTimeout,{type:'number',min:10,max:360,required:true})}${field('Remember sources (seconds)','cacheSeconds',config.playback.cacheSeconds,{type:'number',min:0,max:1800,hint:'Use 0 to resolve a new source every time.'})}${selectField('Video quality','quality',config.playback.quality,[['highest','Highest available'],['adaptive','Adaptive · player chooses']])}</div></div>${saveBar('Applies to new playback requests.')}</form>`);
  if(section==='library')settingsShell(section,settingsHeader('Library','Manage the catalog your IPTV players receive.')+`<div class="stat-grid"><div class="stat"><strong>${data.catalog.movies.toLocaleString()}</strong><span>Movies indexed</span></div><div class="stat"><strong>${data.catalog.series.toLocaleString()}</strong><span>Series indexed</span></div><div class="stat"><strong>${config.playback.enabled.length}</strong><span>Providers enabled</span></div></div><form id="config-form"><div class="panel panel-pad"><div class="form-grid">${field('Catalog pages','pages',config.catalog.pages,{type:'number',min:1,max:2000,hint:'Larger catalogs take longer to build.'})}${field('Refresh interval (hours)','refreshHours',config.catalog.refreshHours,{type:'number',min:1,max:168})}</div>${saveBar()}</div></form><div class="panel"><div class="setting-row"><div><strong>${data.catalog.refreshing?'Catalog refresh in progress':'Refresh catalog'}</strong><p>${data.catalog.updatedAt?'Last updated '+new Date(data.catalog.updatedAt).toLocaleString():'The catalog hasn’t been built yet.'}</p></div><button class="btn ghost small" data-action="refresh-catalog" ${data.catalog.refreshing?'disabled':''}>${icon('refresh')}Refresh now</button></div></div>`);
  if(section==='users')settingsShell(section,settingsHeader('Users','Separate logins for every person or player.')+`<div class="page-head"><span class="muted">${data.users.length} account${data.users.length===1?'':'s'}</span><button class="btn blue small" data-action="add-user">${icon('plus')}Add user</button></div><div class="panel">${data.users.map(u=>{const active=u.enabled&&(!u.expiresAt||Date.parse(u.expiresAt)>Date.now());return `<div class="user-row"><div class="avatar">${esc(initials(u))}</div><div class="user-info"><strong>${esc(u.username)} ${u.id===data.ownerId?'<span class="badge">OWNER</span>':''}</strong><small>${u.role==='admin'?'Administrator':'Viewer'}${u.expiresAt?' · Expires '+new Date(u.expiresAt).toLocaleDateString():''}</small></div><span class="status ${active?'':'off'}">${active?'Active':u.enabled?'Expired':'Disabled'}</span><div class="user-actions"><button class="btn ghost small" data-action="edit-user" data-id="${u.id}">Edit</button>${u.id!==data.ownerId&&u.id!==state.user.id?`<button class="icon-btn" data-action="delete-user" data-id="${u.id}" aria-label="Delete ${esc(u.username)}">${icon('close')}</button>`:''}</div></div>`;}).join('')}</div><div class="notice">${icon('user')}<span>Viewers can watch and use their own IPTV connections. Administrators can also manage this server and its users. Disabling a user or changing their password invalidates existing sessions and media links.</span></div>`);
  if(section==='account')settingsShell(section,settingsHeader('My account','Update your username and password.')+`<form id="account-form"><div class="panel panel-pad">${field('Username','username',state.user.username,{required:true})}${field('Current password','currentPassword','',{type:'password',required:true})}${field('New password','password','',{type:'password',hint:'Leave blank to keep your password. Use 8–128 characters without spaces.'})}${field('Confirm new password','confirmation','',{type:'password'})}</div>${saveBar('Update your IPTV apps if you change these details.')}</form><div class="settings-actions"><button class="btn ghost" data-action="logout">${icon('logout')}${state.lanAccess?'Switch account':'Sign out'}</button></div>`);
  if(section==='activity'){settingsShell(section,settingsHeader('Activity','Incoming requests to this server.')+`<div class="page-head"><span class="muted">Latest 200 requests · Credentials hidden</span><button class="btn ghost small" data-action="reload">${icon('refresh')}Refresh</button></div><div class="panel logs" id="activity"><div class="empty"><div class="spinner"></div></div></div>`);const d=await api('activity');if(version!==state.route)return;$('#activity').innerHTML=d.items.map(e=>`<div class="log-row"><span class="muted">${new Date(e.at).toLocaleTimeString([],{hour12:false})}</span><span class="${Number(e.status)>=400?'error':'success'}">${esc(e.status)}</span><span class="log-path" title="${esc(e.target)}">${esc(e.method)} ${esc(e.target)}</span><span class="muted">${e.durationMs}ms</span></div>`).join('')||'<div class="empty">No requests yet.</div>';}
  if(section==='general')updateDiscoveryStatus();
  const form=$('#config-form');if(form)form.onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form)),button=$('[type=submit]',form);setBusy(button,true);$('#form-error').textContent='';try{let config;if(section==='updates')config={updates:{enabled:form.elements.enabled.checked,intervalMinutes:Number(values.intervalMinutes)}};if(section==='metadata')config={metadata:{tmdbFallback:form.elements.tmdbFallback.checked}};if(section==='general')config={server:{...values,port:Number(values.port),webPort80:form.elements.webPort80.checked,requireLanLogin:form.elements.requireLanLogin.checked,mdns:form.elements.mdns.checked}};if(section==='library')config={catalog:{pages:Number(values.pages),refreshHours:Number(values.refreshHours)}};if(section==='providers')config={live:{zlive:form.elements.liveZlive.checked,sports:form.elements.liveSports.checked,strmfree:form.elements.liveStrmfree.checked},playback:{...state.settings.config.playback,quality:values.quality,providerTimeout:Number(values.providerTimeout),totalTimeout:Number(values.totalTimeout),cacheSeconds:Number(values.cacheSeconds)}};const d=await api('settings',{method:'PUT',body:config});state.settings.config=d.config;state.name=d.config.server.name;toast('Settings saved');if(section==='updates')await updateUpdateStatus();if(section==='general'){const session=await api('session');state.user=session.user;state.lanAccess=session.lanAccess;if(!state.user)return renderLogin();await updateDiscoveryStatus();}}catch(e){$('#form-error').textContent=e.message;}finally{setBusy(button,false);}};
  const account=$('#account-form');if(account)account.onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(account)),button=$('[type=submit]',account);$('#form-error').textContent='';if(data.password!==data.confirmation){$('#form-error').textContent='New passwords do not match.';return;}setBusy(button,true);try{const d=await api('account',{method:'PUT',body:data});state.user=d.user;toast('Account updated');route();}catch(e){$('#form-error').textContent=e.message;setBusy(button,false);}};
  bindProviders();
}
let updateStatusTimer,updateStatusRequest=0;
async function updateUpdateStatus(){
  clearTimeout(updateStatusTimer);
  const slot=$('#update-status'),version=state.route,request=++updateStatusRequest;if(!slot)return;
  if(repairTerminal.active){updateStatusTimer=setTimeout(updateUpdateStatus,5000);return;}
  try{
    const status=await api('updates');if(request!==updateStatusRequest||version!==state.route||!slot.isConnected)return;
    const date=value=>value?new Date(value).toLocaleString():'Not yet';
    slot.innerHTML=`<h3 class="panel-title">${esc(status.message)}</h3><dl class="details-meta"><div><dt>Running commit</dt><dd>${esc(status.running?.slice(0,7)||'—')}</dd></div><div><dt>Installed commit</dt><dd>${esc(status.current?.slice(0,7)||'—')}</dd></div><div><dt>Latest on main</dt><dd>${esc(status.latest?.slice(0,7)||'—')}</dd></div><div><dt>Last checked</dt><dd>${esc(date(status.lastChecked))}</dd></div><div><dt>Last updated</dt><dd>${esc(date(status.lastUpdated))}</dd></div></dl>${status.canRestart?'<div class="actions"><button class="btn primary small" id="restart-update" type="button">Restart now</button></div>':''}${!status.available?'<p class="dialog-copy">Starting the app at boot does not install its updater. <a class="text-link" href="https://github.com/JackHars/watch.local#automatic-updates" target="_blank" rel="noopener noreferrer">Install or repair the update service</a></p>':''}`;
    $('#check-updates').disabled=!status.available||['checking','preparing','installing','restarting','rolling_back','recovery_needed'].includes(status.state);
    if($('#restart-update'))$('#restart-update').onclick=()=>updatePrompt.consider(status,true);
    updatePrompt.consider(status);
  }catch{if(request===updateStatusRequest&&slot.isConnected)slot.innerHTML='<p class="muted">Reconnecting to the server…</p>';}
  if(request===updateStatusRequest&&version===state.route&&slot.isConnected)updateStatusTimer=setTimeout(updateUpdateStatus,5000);
}
let discoveryStatusTimer,discoveryStatusRequest=0;
async function updateDiscoveryStatus(){
  clearTimeout(discoveryStatusTimer);
  const slot=$('#discovery-status'),version=state.route,request=++discoveryStatusRequest;if(!slot)return;
  try{
    const data=await api('settings');if(request!==discoveryStatusRequest||version!==state.route||!slot.isConnected)return;
    const status=data.running?.discovery;
    const address=status?.state==='advertising'?status.url:'';
    slot.innerHTML=address?`<a class="text-link discovery-address" href="${esc(address)}">${esc(address)}</a><p>${esc(status.message)}</p>`:`<p>${esc(status?.message||(data.config.server.mdns?'Starting local discovery…':'Local discovery is turned off.'))}</p>`;
  }catch{if(request===discoveryStatusRequest&&slot.isConnected)slot.textContent='Discovery status is temporarily unavailable.';}
  if(request===discoveryStatusRequest&&version===state.route&&slot.isConnected)discoveryStatusTimer=setTimeout(updateDiscoveryStatus,3000);
}
function providerRows(p){return p.order.map((id,index)=>`<div class="provider-row ${p.enabled.includes(id)?'':'off'}" draggable="true" data-provider="${id}"><span class="provider-order">${String(index+1).padStart(2,'0')}</span><span class="provider-icon">${names[id][0]}</span><div class="provider-info"><strong>${names[id]}</strong><p>${subtitles[id]}</p></div><div class="provider-move"><button type="button" class="icon-btn" data-action="move-provider" data-id="${id}" data-direction="-1" aria-label="Move ${names[id]} up" ${index===0?'disabled':''}>${icon('up')}</button><button type="button" class="icon-btn" data-action="move-provider" data-id="${id}" data-direction="1" aria-label="Move ${names[id]} down" ${index===p.order.length-1?'disabled':''}>${icon('down')}</button></div>${toggle('Enable '+names[id],p.enabled.includes(id),`data-provider-toggle="${id}"`)}</div>`).join('');}
function bindProviders(){const list=$('#provider-list');if(!list)return;list.onchange=e=>{const id=e.target.dataset.providerToggle;if(!id)return;const p=state.settings.config.playback;p.enabled=e.target.checked?[...new Set([...p.enabled,id])]:p.enabled.filter(i=>i!==id);e.target.closest('.provider-row').classList.toggle('off',!e.target.checked);};list.ondragstart=e=>{const row=e.target.closest('[data-provider]');if(!row)return;state.drag=row.dataset.provider;e.dataTransfer.setData('text/plain',state.drag);row.classList.add('dragging');};list.ondragend=e=>e.target.classList.remove('dragging');list.ondragover=e=>e.preventDefault();list.ondrop=e=>{e.preventDefault();const target=e.target.closest('[data-provider]')?.dataset.provider;if(!target||!state.drag)return;const p=state.settings.config.playback;const at=p.order.indexOf(target);p.order=p.order.filter(i=>i!==state.drag);p.order.splice(at,0,state.drag);list.innerHTML=providerRows(p);state.drag=null;};}
function userDialog(id){const prior=state.settings.users.find(u=>u.id===id),owner=id===state.settings.ownerId;const dialog=$('#dialog');dialog.innerHTML=`<header><h2>${prior?'Edit user':'Add user'}</h2><button class="icon-btn" data-action="close-dialog" aria-label="Close">${icon('close')}</button></header><form id="user-form">${field('Username','username',prior?.username||'',{required:true})}<label class="field"><span>${prior?'New password':'Password'}</span><span class="field-row"><input name="password" id="user-password" type="password" autocomplete="new-password" ${prior?'':'required'} minlength="8" maxlength="128"><button class="icon-btn" type="button" data-action="reveal" data-target="user-password" aria-label="Show password">${icon('eye')}</button></span><small>${prior?'Leave blank to keep the existing password.':'Use 8–128 characters without spaces.'}</small></label><div class="form-grid">${selectField('Role','role',prior?.role||'viewer',[['viewer','Viewer'],['admin','Administrator']])}${field('Expires on (optional)','expiresAt',prior?.expiresAt?.slice(0,10)||'',{type:'date'})}</div><div class="setting-row"><strong>Account enabled</strong>${toggle('Account enabled',prior?.enabled??true,'name="enabled"')}</div>${owner?'<p class="muted">The owner must remain an active administrator.</p>':''}<p class="error" id="user-error" role="alert"></p><div class="actions"><button class="btn ghost" type="button" data-action="close-dialog">Cancel</button><button class="btn blue" type="submit">${prior?'Save user':'Create user'}</button></div></form>`;if(owner){$('[name=role]',dialog).value='admin';$('[name=role]',dialog).disabled=true;$('[name=expiresAt]',dialog).disabled=true;$('[name=enabled]',dialog).disabled=true;}dialog.showModal();$('#user-form').onsubmit=async e=>{e.preventDefault();const form=e.target,values=Object.fromEntries(new FormData(form));values.enabled=owner||$('[name=enabled]',form).checked;values.role=owner?'admin':values.role;values.expiresAt=values.expiresAt?new Date(values.expiresAt+'T23:59:59').toISOString():null;const button=$('[type=submit]',form);setBusy(button,true);try{const d=await api('users'+(id?'/'+id:''),{method:id?'PUT':'POST',body:values});if(d.user.id===state.user.id)state.user=d.user;dialog.close();toast(prior?'User updated':'User created');route();}catch(error){$('#user-error').textContent=error.message;setBusy(button,false);}};}
function deleteDialog(id){const user=state.settings.users.find(u=>u.id===id),dialog=$('#dialog');dialog.innerHTML=`<header><h2>Delete ${esc(user.username)}?</h2></header><p class="dialog-copy">This account will lose access to the web player and IPTV service. Its active sessions and media links will stop working.</p><p class="error" id="delete-error"></p><div class="actions"><button class="btn ghost" data-action="close-dialog">Cancel</button><button class="btn danger" id="confirm-delete">Delete user</button></div>`;dialog.showModal();$('#confirm-delete').onclick=async()=>{try{await api('users/'+id,{method:'DELETE'});dialog.close();toast('User deleted');route();}catch(e){$('#delete-error').textContent=e.message;}};}
async function copyValue(id){const input=document.getElementById(id);try{if(navigator.clipboard&&isSecureContext)await navigator.clipboard.writeText(input.value);else{const area=document.createElement('textarea');area.value=input.value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw Error();}toast('Copied to clipboard');}catch{toast('Could not copy. Reveal the field and copy it manually.');}}
let hls,playController,lastPlayback,playbackProgress,mobileSession;
function closePlayer(refresh=true){const saved=playbackProgress?.stop()||Promise.resolve();playbackProgress=null;mobileSession?.stop();mobileSession=null;playController?.abort();hls?.destroy();hls=null;const video=$('video',$('#player'));if(video){video.pause();video.removeAttribute('src');video.load();}$('#player').close();$('#player').innerHTML='';if(refresh)saved.then(refreshContinueWatching);return saved;}
function nativeHls(video,provider){
  // Chromium advertises native HLS but fails to decode some ZLive TS feeds.
  // Use the existing transmuxer there; Apple keeps its native fullscreen path.
  return video.canPlayType('application/vnd.apple.mpegurl')&&(provider!=='zlive'||typeof video.webkitEnterFullscreen==='function'||!window.Hls?.isSupported());
}
function attachHls(video,url,onReady,fail){
  const engine=hls=new Hls({maxBufferLength:30,manifestLoadingTimeOut:180000});
  engine.loadSource(url);engine.attachMedia(video);
  engine.on(Hls.Events.MANIFEST_PARSED,onReady);
  engine.on(Hls.Events.ERROR,(_,event)=>{if(event.fatal)fail('The stream stopped. Try again to request a fresh source.');});
  engine.on(Hls.Events.AUDIO_TRACKS_UPDATED,()=>{const select=$('#audio-track');select.hidden=engine.audioTracks.length<2;select.innerHTML=engine.audioTracks.map((t,i)=>`<option value="${i}">${esc(t.name||t.lang||'Audio '+(i+1))}</option>`).join('');select.onchange=()=>engine.audioTrack=Number(select.value);});
  engine.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,()=>{const select=$('#subtitle-track');select.hidden=!engine.subtitleTracks.length;select.innerHTML='<option value="-1">Subtitles off</option>'+engine.subtitleTracks.map((t,i)=>`<option value="${i}">${esc(t.name||t.lang||'Subtitle '+(i+1))}</option>`).join('');select.onchange=()=>engine.subtitleTrack=Number(select.value);});
}
function playOnMobile(data,identity,player,saved,controller,fresh){
  const vod=['movie','tv'].includes(data.type),query=new URLSearchParams(Object.entries(identity).filter(([,value])=>value!==null));
  $('.player-loading',player).outerHTML=`<video controls preload="auto" aria-label="Video player"></video><div class="player-tools"><span class="player-status" role="status">Opening fullscreen player…</span><select id="audio-track" aria-label="Audio track" hidden></select><select id="subtitle-track" aria-label="Subtitles" hidden></select><button class="btn primary small" data-action="open-fullscreen">${icon('play')}Open fullscreen</button>${vod?'<button class="btn ghost small" data-action="restart-play">Start over</button>':''}<button class="btn ghost small" data-action="retry-play">Try again</button></div>`;
  const video=$('video',player),status=$('.player-status',player);
  const fail=message=>{if(controller.signal.aborted)return;status.textContent=message;status.classList.add('error');$('[data-action="open-fullscreen"]',player).style.display='none';mobileSession?.stop();};
  if(vod){
    const item={...identity,title:data.title||'Now playing',poster_path:data.poster_path,backdrop_path:data.backdrop_path};
    const progress=saved.then(()=>api('progress?'+query,{signal:controller.signal})).then(history=>{
      if(history.progress)Object.assign(item,{title:history.progress.title,poster_path:history.progress.poster_path,backdrop_path:history.progress.backdrop_path});
      return history.progress;
    });
    playbackProgress=trackPlayback(video,{item,progress,onError:toast});
    api(`title?type=${data.type}&id=${data.id}`,{signal:controller.signal}).then(metadata=>{if(!controller.signal.aborted)Object.assign(item,{title:title(metadata),poster_path:metadata.poster_path,backdrop_path:metadata.backdrop_path});}).catch(()=>{});
  }
  mobileSession=mobilePlayer(video,{onExit:()=>{if(!controller.signal.aborted)closePlayer();},onBlocked:()=>{status.textContent='Tap Open fullscreen to begin.';}});
  video.addEventListener('playing',()=>{status.classList.remove('error');status.textContent='Playing';});
  video.addEventListener('error',async()=>{if(controller.signal.aborted)return;mobileSession?.stop();status.textContent='Checking stream availability…';fail(await mobilePlaybackError(source,{signal:controller.signal}));});
  if(fresh)query.set('fresh','1');
  query.set('requestId',[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join(''));
  const source='/ui/playback.m3u8?'+query;
  // Do not await progress or stream resolution here: playback must start in this tap.
  if(nativeHls(video,data.provider))mobileSession.start(source);
  else if(window.Hls?.isSupported()){
    attachHls(video,source,()=>video.play().catch(()=>{if(!controller.signal.aborted)status.textContent='Tap Open fullscreen to begin.';}),fail);
    mobileSession.start();
  }else fail('This browser does not support HLS playback.');
}
async function play(data,fresh=false){if(!state.profile)return profilesPage();const profileId=state.profile.id;lastPlayback={...data};const saved=closePlayer(false);const player=$('#player');player.innerHTML=`<header><h2>${esc(data.title||'Now playing')}</h2><button class="icon-btn" data-action="close-player" aria-label="Close player">${icon('close')}</button></header><div class="player-loading"><div class="spinner"></div><p>Finding the best available stream…</p><small>Trying your providers in order.</small></div>`;player.showModal();const controller=new AbortController();playController=controller;
  const identity={profileId,type:data.type,id:Number(data.id),season:data.season===undefined?null:Number(data.season),episode:data.episode===undefined?null:Number(data.episode)};
  if(mobilePlaybackDevice())return playOnMobile(data,identity,player,saved,controller,fresh);
  try{
    await saved;if(controller.signal.aborted)return;
    const vod=['movie','tv'].includes(data.type),query=new URLSearchParams(Object.entries(identity).filter(([,value])=>value!==null));
    const details=vod?api(`title?type=${data.type}&id=${data.id}`,{signal:controller.signal}).catch(()=>null):Promise.resolve(null);
    const [out,history]=await Promise.all([
      api('play',{method:'POST',body:{...identity,fresh},signal:controller.signal}),
      vod?api('progress?'+query,{signal:controller.signal}).catch(()=>null):null,
    ]);if(controller.signal.aborted)return;
    $('.player-loading',player).outerHTML=`<video controls playsinline autoplay aria-label="Video player"></video><div class="player-tools"><span class="player-status" role="status">Starting playback…</span><select id="audio-track" aria-label="Audio track" hidden></select><select id="subtitle-track" aria-label="Subtitles" hidden></select>${vod?'<button class="btn ghost small" data-action="restart-play">Start over</button>':''}<button class="btn ghost small" data-action="retry-play">Try again</button></div>`;
    const video=$('video',player),status=$('.player-status',player);const fail=message=>{status.textContent=message;status.classList.add('error');};
    if(vod&&history){const metadata=history.progress||data,item={...identity,title:title(metadata),backdrop_path:metadata.backdrop_path,poster_path:metadata.poster_path};playbackProgress=trackPlayback(video,{item,progress:history.progress,onError:toast});details.then(metadata=>{if(metadata&&!controller.signal.aborted)Object.assign(item,{title:title(metadata),backdrop_path:metadata.backdrop_path,poster_path:metadata.poster_path});});}
    else if(vod)toast('Your saved place could not be loaded. Try again to resume.');
    video.addEventListener('playing',()=>{status.classList.remove('error');status.textContent=`Playing from ${names[out.provider]||out.provider}`;});video.addEventListener('error',()=>fail('This browser could not play the video. Try again or use your IPTV app.'));
    if(nativeHls(video,out.provider)){video.src=out.url;video.play().catch(()=>{status.textContent='Press play to begin.';});}
    else if(window.Hls?.isSupported())attachHls(video,out.url,()=>video.play().catch(()=>{status.textContent='Press play to begin.';}),fail);
    else fail('HLS playback is not supported in this browser. Use the IPTV connection details in Settings.');
  }catch(e){if(controller.signal.aborted||!$('.player-loading',player))return;$('.player-loading',player).innerHTML=`${icon('info')}<h2>Playback unavailable</h2><p>${esc(e.message)}</p><button class="btn" data-action="retry-play">Try again</button>`;}
}
$('#player').addEventListener('cancel',e=>{e.preventDefault();closePlayer();});
document.addEventListener('click',async e=>{if(e.target.closest('a[href="#search"]')&&!e.defaultPrevented&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey&&e.button===0){e.preventDefault();openSearch();return;}if(e.target.closest('.skip')){e.preventDefault();$('#main')?.focus();return;}const button=e.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
  try{
    if(action==='toggle-description'){
      const expanded=button.getAttribute('aria-expanded')!=='true';
      button.setAttribute('aria-expanded',String(expanded));
      button.textContent=expanded?'Show less':'Read more';
      button.closest('.hero').classList.toggle('description-expanded',expanded);
      return;
    }
    if(action==='reload')return route();
    if(action==='refresh-live'){setBusy(button,true);try{await api('live/refresh',{method:'POST',body:{}});return route();}finally{setBusy(button,false);}}
    if(action==='add-profile')return addProfile();
    if(action==='select-profile'){const profile=state.profiles.find(profile=>profile.id===button.dataset.profileId);if(!profile)return;state.profile=profile;rememberProfile(state.user.id,profile.id);viewPositions.clear();visibleRoute='';return route();}
    if(action==='switch-profile'){const saved=closePlayer(false);rememberProfile(state.user.id,null);state.profile=null;state.route++;viewPositions.clear();visibleRoute='';history.replaceState(null,'','#home');await saved;return route();}
    if(action==='remove-tmdb'){button.disabled=true;await api('tmdb',{method:'DELETE'});toast('TMDB credential removed and fallback disabled');return route();}
    if(action==='rail'){const rail=$('.rail',button.closest('section'));rail.scrollBy({left:rail.clientWidth*.75*Number(button.dataset.direction),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
    if(action==='episodes'){if(location.hash.startsWith('#title'))$('#episodes')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});else location.hash=`title/tv/${button.dataset.id}`;}
    if(action==='play')await play(button.dataset);
    if(action==='retry-play')await play(lastPlayback,true);
    if(action==='open-fullscreen')mobileSession?.start();
    if(action==='restart-play'){const video=$('video',$('#player'));if(playbackProgress)playbackProgress.restart();else if(video)video.currentTime=0;video?.play().catch(()=>{});}
    if(action==='close-player')closePlayer();
    if(action==='save')saveTitle();
    if(action==='logout'){await closePlayer(false);await api('logout',{method:'POST',body:{}});rememberProfile(state.user.id,null);state.user=null;$('#dialog').close();renderLogin();}
    if(action==='close-dialog')$('#dialog').close();
    if(action==='add-user')userDialog();if(action==='edit-user')userDialog(button.dataset.id);if(action==='delete-user')deleteDialog(button.dataset.id);
    if(action==='reveal'){const input=document.getElementById(button.dataset.target);input.type=input.type==='password'?'text':'password';button.setAttribute('aria-label',input.type==='password'?'Show value':'Hide value');}
    if(action==='copy')await copyValue(button.dataset.target);
    if(action==='move-provider'){const p=state.settings.config.playback,index=p.order.indexOf(button.dataset.id),next=index+Number(button.dataset.direction);if(next<0||next>=p.order.length)return;[p.order[index],p.order[next]]=[p.order[next],p.order[index]];$('#provider-list').innerHTML=providerRows(p);$(`[data-id="${button.dataset.id}"][data-direction="${button.dataset.direction}"]`)?.focus();}
    if(action==='refresh-catalog'){button.disabled=true;await api('refresh',{method:'POST',body:{}});toast('Catalog refresh started');route();}
    if(action==='more'){button.disabled=true;const page=state.page+1,version=state.route;const data=await api(`browse?type=${button.dataset.type}&board=${button.dataset.board||'popular'}&page=${page}`);if(version!==state.route)return;state.page=page;$('#catalog-grid').insertAdjacentHTML('beforeend',data.items.map(i=>card(i,true)).join(''));button.disabled=false;if(page>=data.pages)button.closest('.load-more').hidden=true;}
  }catch(error){toast(error.message);button.disabled=false;}
});
window.addEventListener('hashchange',route);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshContinueWatching();});
window.addEventListener('focus',refreshContinueWatching);
window.addEventListener('keydown',event=>{if(event.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&!$('#player').open&&!$('#dialog').open){event.preventDefault();openSearch();}});
try{let session=await api('session');if(!session.user&&session.lanAccess){await api('logout',{method:'POST',body:{}});session=await api('session');}state.user=session.user;state.lanAccess=session.lanAccess;state.name=session.name;route();}catch(e){$('#app').innerHTML=`<main class="login-page">${errorBox(e)}</main>`;}
