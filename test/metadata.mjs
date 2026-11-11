import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetadataService, catalogSources } from '../api/metadata.mjs';
import { parseTrendingPanel, fetchPublicIMDb, trendingURL } from '../api/tmdb-public.mjs';

const sevenSources = ['https://7movies.ac', 'https://7movies.ws'];
const movie = { id: 550, title: 'Fight Club', release_date: '1999-10-15', imdb_id: 'tt0137523', poster_path: '/poster.jpg', genre_ids: [18], credits: { cast: [{ name: 'Actor' }] } };
const series = { id: 1396, name: 'Breaking Bad', seasons: [{ season_number: 2, episode_count: 1 }], credits: { cast: [] } };
const card = { id: 603, title: 'The Matrix', mediaType: 'movie', releaseDate: '1999-03-31', rating: 8.3, poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/backdrop.jpg', description: 'A computer hacker.' };
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

const panel = await readFile(new URL('./fixtures/trending-panel.html',import.meta.url),'utf8');
const html = text => new Response(text,{headers:{'content-type':'text/html'}});

test('curated top-rated pages share one ranked snapshot, survive restarts and retain complete results during partial failures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-top-rated-'));
  let time=Date.parse('2026-11-11T12:00:00Z'),phase=0,calls=0,restored;
  const candidates=Array.from({length:60},(_,index)=>({...movie,id:index+1,original_language:'en',genre_ids:[18],vote_count:5000+index*100,vote_average:8+index/100,popularity:index}));
  const options={directory,now:()=>time,sources:sevenSources.slice(0,1),getConfig:()=>({}),fetcher:async url=>{
    calls++;const u=new URL(url),path=u.searchParams.get('path'),page=Number(u.searchParams.get('page'));
    if(phase===2 || (phase===1 && page===4))return new Response('{}',{status:503});
    const popular=path==='/movie/popular';
    const results=candidates.slice((page-1)*20,page*20);
    if(phase===1 && page===1)results[0]={...results[0],id:999,vote_average:10,vote_count:100000};
    return response({results,total_pages:popular?1:phase===1?4:3,page});
  }};
  try{
    const service=createMetadataService(options);
    const [one,two]=await Promise.all([1,2].map(page=>service.request('/curated/movie/top_rated',{page})));
    const three=await service.request('/curated/movie/top_rated',{page:3});
    assert.equal(calls,4);assert.equal(one.total_pages,3);assert.equal(one.total_results,60);
    assert.equal(one.results.length,20);assert.equal(two.results.length,20);assert.equal(three.results.length,20);
    const ids=[...one.results,...two.results,...three.results].map(i=>i.id);
    assert.equal(new Set(ids).size,60);assert.equal(ids[0],60);
    assert.deepEqual((await service.request('/curated/movie/top_rated',{page:4})).results,[]);
    await service.flush();
    restored=createMetadataService(options);time+=1800000;
    assert.deepEqual((await restored.request('/curated/movie/top_rated',{page:2})).results.map(i=>i.id),two.results.map(i=>i.id));
    assert.equal(calls,4,'a warm ranking survives a server restart');
    time+=7200000;phase=1;
    assert.deepEqual((await restored.request('/curated/movie/top_rated')).results.map(i=>i.id),one.results.map(i=>i.id),'an incomplete refresh must not replace the complete ranking');
    time+=8*86400000;phase=2;
    await assert.rejects(restored.request('/curated/movie/top_rated'),{status:502});
  }finally{await restored?.flush();await rm(directory,{recursive:true,force:true});}
});

test('public trending preserves the homepage ranking, identities and artwork without credentials or Atlantic', async () => {
  const parsed = parseTrendingPanel(panel);
  assert.deepEqual(parsed.map(i=>[i.id,i.media_type]),[[550,'movie'],[1396,'tv']]);
  assert.equal(parsed[0].title,'Fight Club & Friends');
  assert.equal(parsed[0].poster_path,'/poster.jpg');assert.equal(parsed[0].release_date,'1999-10-15');
  assert.throws(()=>parseTrendingPanel('<html>Temporary maintenance</html>'),{status:502});
  const directory = await mkdtemp(join(tmpdir(),'watchlocal-public-trending-'));
  let time=Date.now(),offline=false,panelCalls=0;
  try {
    const legacy=JSON.stringify(['/trending/movie/day',[]]);
    await writeFile(join(directory,'metadata-cache.json'),JSON.stringify({version:1,entries:[[legacy,{at:time,data:{results:[{id:999,title:'Old popular substitution'}]}}]]}));
    const options={directory,now:()=>time,getConfig:()=>({tmdbCredential:'private-never-forwarded',tmdbFallback:false}),fallback:()=>assert.fail('No API key needed'),fetcher:async(url,options)=>{
      assert.ok(!JSON.stringify([url,options.headers]).includes('private-never-forwarded'));
      assert.equal(options.headers.authorization,undefined);assert.equal(options.headers.cookie,undefined);
      const u=new URL(url);assert.notEqual(u.hostname,'db.hls.lol');
      if(url===trendingURL){panelCalls++;return offline?html('<html>Maintenance</html>'):html(panel);}
      assert.equal(u.hostname,'7movies.ac');
      return response(u.searchParams.get('path')==='/movie/550'?{...movie,backdrop_path:'/movie-backdrop.jpg'}:{...series,backdrop_path:'/series-backdrop.jpg'});
    }};
    const service=createMetadataService(options);
    const [all,movies,shows]=await Promise.all(['all','movie','tv'].map(type=>service.request(`/trending/${type}/day`)));
    assert.equal(panelCalls,1);assert.equal(all.results.length,2);assert.equal(movies.results.length,1);assert.equal(shows.results.length,1);
    assert.equal(all.results[0].backdrop_path,'/movie-backdrop.jpg');assert.equal(shows.results[0].backdrop_path,'/series-backdrop.jpg');
    assert.deepEqual(all.results.map(i=>i.id),[550,1396]);assert.equal(all.total_pages,1);
    assert.deepEqual((await service.request('/trending/movie/day',{page:2})).results,[]);
    all.results[0].title='Mutated';assert.equal((await service.request('/trending/all/day')).results[0].title,movie.title);
    await service.flush();
    time+=3600000;offline=true;
    const restored=createMetadataService(options);
    assert.equal((await restored.request('/trending/all/day')).results.length,2);
    assert.equal((await restored.request('/trending/tv/day')).results[0].id,1396);
    assert.equal(panelCalls,2,'failed panels are cooled down rather than fetched again for each row');
    time+=8*86400000;
    await assert.rejects(restored.request('/trending/all/day'),{status:502});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('public trending retains its titles if detail enrichment fails and honors cancellation', async () => {
  const service=createMetadataService({getConfig:()=>({}),fetcher:async url=>url===trendingURL?html(panel):response({error:'unavailable'})});
  const data=await service.request('/trending/all/day');
  assert.equal(data.results[0].title,'Fight Club & Friends');assert.equal(data.results[0].poster_path,'/poster.jpg');
  const controller=new AbortController();let requests=0;
  const aborted=createMetadataService({getConfig:()=>({}),fetcher:async(url,options)=>{requests++;controller.abort();options.signal.throwIfAborted();}});
  await assert.rejects(aborted.request('/trending/all/day',{},controller.signal),{name:'AbortError'});
  assert.equal(requests,1);
});

test('provider catalog covers pagination, search, details, IMDb mapping, artwork and episode IDs without TMDB', async () => {
  const seen = [];
  const service = createMetadataService({ sources: sevenSources, getConfig: () => ({}), fallback: () => assert.fail('TMDB must not be called'), fetcher: async (url, options) => {
    const u = new URL(url); seen.push(u);
    assert.equal(options.headers.authorization, undefined); assert.equal(u.searchParams.has('api_key'), false);
    const path = u.searchParams.get('path');
    if (u.pathname === '/api/search') return response({ results: [card, { ...card, id: 711, mediaType: 'tv', title: 'Threat Matrix' }] });
    if (u.pathname === '/api/discover') { assert.equal(u.searchParams.get('year'), '1999'); return response({ items: [card], page: 2, totalPages: 37, totalResults: 720 }); }
    if (u.pathname === '/api/tv/1396/season/2') return response({ episodes: [{ id: 972873, episode_number: 1, name: 'Seven Thirty-Seven', runtime: 48 }] });
    if (path === '/movie/popular') return response({ page: Number(u.searchParams.get('page')), results: [movie], total_pages: 500 });
    if (path === '/movie/550') return response(movie);
    if (path === '/tv/1396') return response(series);
    if (path === '/movie/550/images') return response({ posters: [{ file_path: '/poster.jpg' }], backdrops: [] });
    assert.fail('Unexpected request: ' + url);
  } });
  assert.equal((await service.request('/movie/popular', { page: 2 })).page, 2);
  const found = await service.request('/search/multi', { query: 'matrix' });
  assert.equal(found.results[0].poster_path, '/matrix.jpg'); assert.equal(found.results[0].overview, card.description);
  assert.equal(found.results[1].name, 'Threat Matrix'); assert.equal(found.total_pages, 1);
  assert.equal((await service.request('/search/movie', { query: 'matrix' })).results.length, 1);
  assert.equal((await service.request('/search/multi', { query: 'matrix', page: 2 })).results.length, 0);
  assert.equal((await service.request('/discover/movie', { page: 2, 'primary_release_date.gte': '1999-01-01', 'primary_release_date.lte': '1999-12-31' })).total_pages, 37);
  assert.equal((await service.request('/movie/550', { append_to_response: 'credits' })).credits.cast[0].name, 'Actor');
  assert.equal((await service.request('/movie/550/external_ids')).imdb_id, 'tt0137523');
  assert.equal((await service.request('/movie/550/images')).posters[0].file_path, '/poster.jpg');
  assert.equal((await service.request('/tv/1396')).seasons[0].season_number, 2);
  const season = await service.request('/tv/1396/season/2');
  assert.deepEqual([season.episodes[0].id, season.episodes[0].season_number, season.episodes[0].episode_number], [972873, 2, 1]);
  assert.equal((await service.request('/genre/movie/list')).genres.find(g => g.id === 18).name, 'Drama');
  assert.ok(seen.every(u => u.hostname === '7movies.ac'));
  await assert.rejects(service.request('/configuration'), { status: 400 });
});

test('a failed primary uses its mirror; invalid metadata is not cached and empty search is a valid result', async () => {
  let calls = 0, primaryBroken = true, fallbacks = 0;
  const service = createMetadataService({ sources: sevenSources, getConfig: () => ({ tmdbFallback: true, tmdbCredential: 'private-fixture-token' }), fallback: () => { fallbacks++; return movie; }, fetcher: async url => {
    calls++;
    const u = new URL(url);
    if (u.pathname === '/api/search') return response({ results: [] });
    if (u.hostname === '7movies.ac' && primaryBroken) return response({ results: [] });
    return response(movie);
  } });
  assert.equal((await service.request('/movie/550')).title, 'Fight Club'); assert.equal(calls, 2); assert.equal(fallbacks, 0);
  primaryBroken = false;
  assert.equal((await service.request('/search/multi', { query: 'no such title' })).results.length, 0); assert.equal(fallbacks, 0);
});

test('TMDB is opt-in, only follows source failures, never receives or leaks another credential, and disabling takes effect immediately', async () => {
  const config = { tmdbCredential: 'private-fixture-token', tmdbFallback: false }, calls = [];
  const service = createMetadataService({ sources: sevenSources, getConfig: () => config, fetcher: async (url, options) => {
    calls.push('upstream'); assert.ok(!JSON.stringify([url, options.headers]).includes(config.tmdbCredential));
    return response({ error: 'missing metadata' });
  }, fallback: async (path, extra, options) => { calls.push('tmdb'); assert.equal(options.credential, config.tmdbCredential); return movie; } });
  await assert.rejects(service.request('/movie/550'), { status: 502 }); assert.deepEqual(calls, ['upstream','upstream']);
  config.tmdbFallback = true;
  assert.equal((await service.request('/movie/550')).id, 550); assert.deepEqual(calls.slice(-3), ['upstream','upstream','tmdb']);
  const oldCalls = calls.length; config.tmdbFallback = false;
  await assert.rejects(service.request('/movie/550'), { status: 502 }); assert.deepEqual(calls.slice(oldCalls), ['upstream','upstream']);
  config.tmdbFallback = true; config.tmdbCredential = 'changed-private-token';
  await service.request('/movie/550'); assert.equal(calls.at(-1), 'tmdb', 'replacement credentials cannot use the old fallback cache');
});

test('missing series IMDb IDs can use the optional fallback, while an unavailable fallback remains a recoverable provider failure', async () => {
  let enabled = false;
  const service = createMetadataService({ sources: sevenSources, getConfig: () => ({ tmdbFallback: enabled, tmdbCredential: 'fixture-token' }), fetcher: async () => response(series), fallback: async path => { assert.equal(path, '/tv/1396/external_ids'); return { imdb_id: 'tt0903747' }; } });
  await assert.rejects(service.request('/tv/1396/external_ids'), /IMDb information is unavailable/);
  enabled = true; assert.equal((await service.request('/tv/1396/external_ids')).imdb_id, 'tt0903747');
  const failed = createMetadataService({ sources: sevenSources, getConfig: () => ({ tmdbFallback: true, tmdbCredential: 'fixture-token' }), fetcher: async () => response(series), fallback: async () => { throw Error('offline'); } });
  await assert.rejects(failed.request('/tv/1396/external_ids'), { status: 502 });
});

test('typed TMDB search fallback keeps the same result format as upstream search', async () => {
  const service = createMetadataService({ sources: sevenSources, getConfig: () => ({ tmdbFallback: true, tmdbCredential: 'fixture-token' }), fetcher: async () => new Response('{}', { status: 503 }), fallback: async () => ({ results: [movie], page: 1, total_pages: 1 }) });
  assert.equal((await service.request('/search/movie', { query: 'fight club' })).results[0].media_type, 'movie');
});

test('metadata survives restarts and temporary outages, coalesces reads, and expires after seven days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-metadata-'));
  let time = Date.now(), calls = 0;
  try {
    const service = createMetadataService({ sources: sevenSources, directory, now: () => time, getConfig: () => ({}), fetcher: async () => { calls++; return response(movie); } });
    const [a,b] = await Promise.all([service.request('/movie/550'), service.request('/movie/550')]);
    assert.equal(calls, 1); a.title = 'mutated'; assert.equal(b.title, 'Fight Club');
    await service.flush();
    const saved = JSON.parse(await readFile(join(directory,'metadata-cache.json'),'utf8')); assert.ok(saved.entries.length);
    time += 7 * 3600000;
    const restored = createMetadataService({ sources: sevenSources, directory, now: () => time, getConfig: () => ({}), fetcher: async () => { throw Error('offline'); } });
    assert.equal((await restored.request('/movie/550')).title, 'Fight Club');
    time += 8 * 86400000; await assert.rejects(restored.request('/movie/550'), { status: 502 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('requests honor cancellation without falling through to another source', async () => {
  const controller = new AbortController(), seen = [];
  const service = createMetadataService({ sources: sevenSources, getConfig: () => ({ tmdbFallback: true, tmdbCredential: 'fixture-token' }), fallback: () => assert.fail('aborted requests cannot fall back'), fetcher: async (url, options) => {
    seen.push(url); controller.abort(); options.signal.throwIfAborted();
  } });
  await assert.rejects(service.request('/movie/550', {}, controller.signal), { name: 'AbortError' }); assert.equal(seen.length, 1);
});

test('list rate limits are retried later without blocking episodes or local categories', async () => {
  const seen = []; let time = Date.now();
  const service = createMetadataService({ sources: sevenSources, now: () => time, getConfig: () => ({}), fetcher: async url => {
    const u = new URL(url); seen.push(u.pathname);
    if (u.pathname === '/api/tmdb') return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    return response({ episodes: [{ id: 123, episode_number: 1, name: 'Episode' }] });
  } });
  await assert.rejects(service.request('/movie/popular'), e => e.retryAfterMs === 2000);
  assert.equal(seen.length, 2);
  await assert.rejects(service.request('/movie/top_rated'), { status: 502 }); assert.equal(seen.length, 2);
  assert.equal((await service.request('/tv/1396/season/2')).episodes[0].season_number, 2);
  assert.ok((await service.request('/genre/movie/list')).genres.length);
  time += 2001;
  await assert.rejects(service.request('/movie/popular'), { status: 502 }); assert.equal(seen.length, 5);
});

test('catalog metadata uses the 7Movies mirror and optional TMDB fallback, never Atlantic', async () => {
  for(const mirrorWorks of [true,false]){
    const seen=[];
    const service=createMetadataService({getConfig:()=>({tmdbFallback:true,tmdbCredential:'private-fixture-token'}),fetcher:async url=>{
      const host=new URL(url).hostname;seen.push(host);
      return host==='7movies.ws'&&mirrorWorks?response(movie):new Response('{}',{status:503});
    },fallback:async()=>{seen.push('tmdb');return movie;}});
    assert.equal((await service.request('/movie/550')).id,550);
    assert.deepEqual(seen,mirrorWorks?['7movies.ac','7movies.ws']:['7movies.ac','7movies.ws','tmdb']);
  }
});

test('missing IMDb mapping uses public TMDB structured data and rejects a different title', async()=>{
  assert.deepEqual(catalogSources,['https://7movies.ac','https://7movies.ws']);
  const seen=[];
  const structured=id=>'<script type="application/ld+json">'+JSON.stringify({'@type':'TVSeries',url:`https://www.themoviedb.org/tv/${id}-show`,sameAs:['https://www.imdb.com/title/tt0903747']})+'</script>';
  const service=createMetadataService({getConfig:()=>({}),fetcher:async url=>{
    const u=new URL(url);seen.push(u.hostname);
    return u.hostname==='www.themoviedb.org'?html(structured(1396)):response(series);
  }});
  assert.equal((await service.request('/tv/1396/external_ids')).imdb_id,'tt0903747');
  assert.deepEqual(seen,['7movies.ac','7movies.ws','www.themoviedb.org']);
  await assert.rejects(fetchPublicIMDb('tv',1396,{fetcher:async()=>html(structured(999))}),{status:502});
  await assert.rejects(fetchPublicIMDb('tv',1396,{fetcher:async()=>html(structured(1396).replace('www.imdb.com','evil.test'))}),{status:502});
});
