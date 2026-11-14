const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const art = path => typeof path === 'string' && /^\/[\w.\/-]+$/.test(path) ? 'https://image.tmdb.org/t/p/w1280'+path : '';
const names = {recommended:'Recommended',popular:'Most popular',rating:'Best rated',newest:'Newest first',title:'A–Z'};
export function libraryHash(type, {view='discover',collection='all',genre=0,sort='recommended'} = {}) {
  const page = type === 'tv' ? 'series' : 'movies';
  if (view === 'discover') return '#'+page;
  const query = new URLSearchParams();
  if(collection!=='all')query.set('collection',collection);
  if(Number(genre)>0)query.set('genre',genre);
  if(sort!=='recommended')query.set('sort',sort);
  return '#'+page+'/browse'+(query.size?'?'+query:'');
}
export function libraryRoute(type, hash) {
  const [path,query=''] = hash.replace(/^#/,'').split('?'), sub=path.split('/')[1];
  const params = new URLSearchParams(query);
  const legacy = {now_playing:'new',on_the_air:'new',top_rated:'top_rated',trending:'trending'};
  return {type,view:sub||query?'browse':'discover',collection:params.get('collection')||legacy[sub]||'all',genre:params.get('genre')||0,sort:params.get('sort')||(sub==='popular'?'popular':'recommended')};
}
export function libraryPage(data, {icon, card, rail, saved=[]}) {
  const type=data.type, heading=type==='tv'?'Series':'Movies', discover=data.view==='discover';
  const collectionNames={all:'All titles',trending:'Trending',new:type==='tv'?'Current shows':'New releases',top_rated:'Top rated'};
  const options=(entries,current)=>Object.entries(entries).map(([value,label])=>`<option value="${value}" ${String(value)===String(current)?'selected':''}>${esc(label)}</option>`).join('');
  const link = changes => libraryHash(type,{...data,view:'browse',...changes});
  const filters=`<form class="library-filters" aria-label="Filter ${heading.toLowerCase()}"><label class="field library-genre"><span>Genre</span><select name="genre" aria-label="Genre"><option value="0">All genres</option>${data.genres.map(g=>`<option value="${g.id}" ${Number(data.genre)===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}</select></label><label class="field"><span>Collection</span><select name="collection" aria-label="Collection">${options(collectionNames,data.collection)}</select></label><label class="field"><span>Sort by</span><select name="sort" aria-label="Sort by">${options(names,data.sort)}</select></label></form>`;
  const header=`<div class="page-head library-heading"><div><h1>${heading}</h1><p>${type==='tv'?'Your next great series starts here.':'Find something worth settling in for.'}</p></div><nav class="library-view" aria-label="Library view"><a href="${libraryHash(type)}" ${discover?'aria-current="page"':''}>Discover</a><a href="${libraryHash(type,{view:'browse'})}" ${!discover?'aria-current="page"':''}>Browse all</a></nav></div>${discover?'':filters}`;
  const notice=data.partial?'<p class="library-notice" role="status">Some collections are temporarily unavailable. You can still browse the available library.</p>':'';
  if(!discover){
    const genre=data.genres.find(g=>g.id===Number(data.genre));
    const label=[genre?.name,collectionNames[data.collection]].filter(Boolean).join(' · ');
    return `<div class="page library-page">${header}${notice}<div class="library-results-heading"><div><h2>${esc(label)}</h2><p>${data.total.toLocaleString()} titles · ${esc(names[data.sort])}${data.sort==='rating'?' · Ratings weighted by vote count':''}</p></div>${data.genre||data.collection!=='all'||data.sort!=='recommended'?`<a class="text-link" href="${libraryHash(type,{view:'browse'})}">Clear filters</a>`:''}</div><div class="grid" id="library-grid">${data.items.map(item=>card(item,true)).join('')}</div>${data.total?'':`<div class="empty">${icon('search')}<h2>No titles in this selection</h2><p>Try another genre or collection.</p><a class="btn" href="${libraryHash(type,{view:'browse'})}">Browse all ${heading.toLowerCase()}</a></div>`}${data.pages>data.page?'<div class="load-more"><button type="button" class="btn ghost" data-library-more>Load more '+icon('down')+'</button></div>':''}</div>`;
  }
  const spot=data.spotlight;
  const spotlight=spot?`<a class="library-spotlight" href="#title/${type}/${spot.id}" aria-label="Explore ${esc(spot.title)}">${art(spot.backdrop_path)?`<img src="${esc(art(spot.backdrop_path))}" alt="" fetchpriority="high">`:''}<div class="library-spotlight-copy"><p class="library-eyebrow">${data.personalized?'Picked for your profile':'In the spotlight'}</p><h2>${esc(spot.title)}</h2><p class="library-spotlight-meta">${esc(spot.release_date?.slice(0,4))}${spot.vote_average?' · ★ '+spot.vote_average.toFixed(1):''}</p><p class="library-spotlight-description">${esc(spot.overview)}</p><span class="library-spotlight-link">Explore ${type==='tv'?'series':'movie'} ${icon('right')}</span></div></a>`:'';
  const genres=[...data.genres].filter(g=>g.count>0).sort((a,b)=>b.count-a.count||a.id-b.id).slice(0,6);
  const tiles=`<section class="library-genres" aria-labelledby="library-genres-title"><div class="library-results-heading"><h2 id="library-genres-title">Explore by genre</h2><a class="text-link" href="${libraryHash(type,{view:'browse'})}">All genres</a></div><div class="library-genre-grid">${genres.map((g,index)=>`<a class="library-genre-card genre-tone-${index}" href="${link({genre:g.id,collection:'all'})}">${art(g.backdrop_path)?`<img src="${esc(art(g.backdrop_path))}" alt="" loading="lazy">`:''}<span>${esc(g.name)}</span>${icon('right')}</a>`).join('')}</div></section>`;
  const myList=saved.filter(item=>item.type===type);
  return `<div class="page library-page">${header}${notice}${spotlight}${tiles}${myList.length?rail('My List',myList,{poster:true,subtitle:'Saved for your next watch.'}):''}${data.rows.map(row=>rail(esc(row.label),row.items,{poster:row.key==='top_rated'||Boolean(row.genre),subtitle:esc(row.subtitle),link:link({collection:['trending','new','top_rated'].includes(row.key)?row.key:'all',genre:row.genre||0,sort:'recommended'})})).join('')}</div>`;
}
export function mountLibraryPage(root, data, {api,profileId,card,onError}) {
  const controller=new AbortController(), form=root.querySelector('.library-filters');
  form?.addEventListener('submit',event=>event.preventDefault(),{signal:controller.signal});
  form?.addEventListener('change',()=>{location.hash=libraryHash(data.type,{view:'browse',...Object.fromEntries(new FormData(form))});},{signal:controller.signal});
  let page=data.page;const seen=new Set(data.items.map(item=>item.id));
  root.querySelector('[data-library-more]')?.addEventListener('click',async event=>{
    const button=event.currentTarget;if(button.disabled)return;button.disabled=true;button.textContent='Loading…';
    try{
      const query=new URLSearchParams({type:data.type,view:'browse',genre:data.genre,collection:data.collection,sort:data.sort,page:page+1,profileId});
      const next=await api('library?'+query,{signal:controller.signal});if(controller.signal.aborted)return;
      const items=next.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
      root.querySelector('#library-grid').insertAdjacentHTML('beforeend',items.map(item=>card(item,true)).join(''));page=next.page;
      if(page>=next.pages)button.closest('.load-more').hidden=true;
    }catch(error){if(!controller.signal.aborted)onError(error.message);}
    finally{if(!controller.signal.aborted){button.disabled=false;button.textContent='Load more';}}
  },{signal:controller.signal});
  return ()=>controller.abort();
}
