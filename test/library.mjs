import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, libraryOptions } from '../api/library.mjs';
import { libraryHash, libraryRoute, libraryPage } from '../public/library.mjs';

const genres = [{id:18,name:'Drama'},{id:35,name:'Comedy'},{id:28,name:'Action'}];
const item = (id, extra={}) => ({id,title:'Title '+id,poster_path:'/poster.jpg',backdrop_path:'/art.jpg',genre_ids:[18],release_date:'2020-01-01',vote_average:8,vote_count:2000,popularity:10,...extra});
function fixture({local=[],lists={},watches={},details={},clock=()=>Date.parse('2026-11-14'),fail=()=>false}={}) {
  const calls=[];
  const library=createLibrary({now:clock,localCatalog:async()=>local,history:async(user,profile)=>{
    if(user!=='owner'||!Object.hasOwn(watches,profile))throw Object.assign(Error('Unknown profile'),{status:404});
    return watches[profile];
  },catalog:async(path)=>{
    calls.push(path);if(fail(path))throw Error('Offline');
    if(path.startsWith('/genre/'))return{genres};
    if(details[path])return details[path];
    const key=path.includes('/trending/')?'trending':path.endsWith('now_playing')||path.endsWith('on_the_air')?'new':path.split('/').at(-1);
    return{results:lists[key]||[]};
  }});
  return{calls,library:(input={},profile='guest')=>library('owner',profile,{type:'movie',view:'browse',...input}),raw:library};
}

test('genre and sort apply to the entire catalog before pagination; duplicate feeds enrich rather than repeat titles',async()=>{
  const local=Array.from({length:60},(_,index)=>item(index+1,{genre_ids:[index%2?35:18],popularity:index+1}));
  const {library}=fixture({local,lists:{popular:[item(1,{overview:'Refreshed',genre_ids:[]})]},watches:{guest:[]}});
  const first=await library({genre:18,sort:'popular'}),second=await library({genre:18,sort:'popular',page:2});
  assert.equal(first.total,30);assert.equal(first.pages,2);assert.equal(first.items.length,24);
  assert.deepEqual(first.items.map(i=>i.id),Array.from({length:24},(_,i)=>59-i*2));
  assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,30);
  assert.equal(second.items.find(i=>i.id===1).overview,'Refreshed');
  assert.equal(first.genres.find(g=>g.id===18).count,30);
  assert.deepEqual((await library({page:10})).items,[]);
  assert.equal((await library({sort:'title'})).items[1].title,'Title 2');
});

test('rating accounts for vote count, release sorting excludes future/adult/wrong-media entries, and collections stay distinct',async()=>{
  const reviewed=item(1,{vote_average:8.5,vote_count:10000}),niche=item(2,{vote_average:10,vote_count:2,release_date:'2025-01-01'});
  const {library}=fixture({local:[reviewed,niche,item(3,{adult:true}),item(4,{media_type:'tv'}),item(5,{release_date:'2030-01-01'}),item(6,{poster_path:null})],lists:{trending:[niche],new:[niche],top_rated:[reviewed]},watches:{guest:[]}});
  assert.deepEqual((await library({sort:'rating'})).items.map(i=>i.id),[1,2]);
  assert.deepEqual((await library({sort:'newest'})).items.map(i=>i.id),[2,1]);
  for(const collection of ['trending','new'])assert.deepEqual((await library({collection})).items.map(i=>i.id),[2]);
  assert.deepEqual((await library({collection:'top_rated'})).items.map(i=>i.id),[1]);
  assert.equal((await library({genre:35})).total,0);
});

test('completed watches personalize only that profile; all watched titles stay out of recommendation shelves',async()=>{
  const local=[item(1),item(2,{genre_ids:[35]}),item(3),item(4,{genre_ids:[35]})];
  const {library,calls,raw}=fixture({local,watches:{drama:[{type:'movie',id:1,position:7200,completed:true}],comedy:[{type:'movie',id:2,position:500}],guest:[]}});
  const [drama,comedy]=await Promise.all([library({view:'discover'},'drama'),library({view:'discover'},'comedy')]);
  assert.equal(drama.personalized,true);assert.equal(comedy.personalized,true);
  assert.equal(drama.rows[0].items[0].id,3);assert.equal(comedy.rows[0].items[0].id,4);
  assert.ok(!drama.rows[0].items.some(i=>i.id===1));assert.ok(!comedy.rows[0].items.some(i=>i.id===2));
  assert.equal((await library({view:'discover'})).personalized,false);
  assert.equal(calls.length,5,'feed snapshots shared without sharing recommendations');
  await assert.rejects(raw('another-user','drama',{type:'movie'}),{status:404});
  assert.equal(calls.length,5,'ownership checked before metadata work');
});

test('series discovery includes show collections and genres, and can seed recommendations from titles outside the catalog',async()=>{
  const local=[item(10,{title:undefined,name:'Series A',genre_ids:[35],release_date:undefined,first_air_date:'2024-01-01'}),item(11,{title:undefined,name:'Series B',genre_ids:[18]})];
  const {library,calls}=fixture({local,lists:{popular:local,trending:local,new:local,top_rated:local},watches:{guest:[{type:'tv',id:99,position:100}]},details:{'/tv/99':item(99,{genre_ids:[35]})}});
  const data=await library({type:'tv',view:'discover'});
  assert.equal(data.rows[0].items[0].title,'Series A');assert.equal(data.rows[0].items[0].type,'tv');
  assert.ok(data.rows.some(row=>row.label==='On TV this week'));
  assert.ok(data.rows.some(row=>row.genre===35));assert.ok(calls.includes('/tv/on_the_air'));
  assert.equal(data.spotlight.id,10);
});

test('feed outages retain previous collections and permit browsing the imported library on a cold start',async()=>{
  let time=Date.parse('2026-11-14'),offline=false;
  const {library}=fixture({local:[item(1)],lists:{trending:[item(2)]},watches:{guest:[]},clock:()=>time,fail:()=>offline});
  assert.equal((await library({collection:'trending'})).items[0].id,2);
  time+=6*60000;offline=true;
  const stale=await library({collection:'trending'});assert.equal(stale.partial,true);assert.equal(stale.items[0].id,2);
  const cold=fixture({local:[item(1)],watches:{guest:[]},fail:path=>!path.startsWith('/genre/')});
  assert.equal((await cold.library()).items[0].id,1);
  const empty=fixture({watches:{guest:[]},fail:()=>true});await assert.rejects(empty.library(),{status:502});
});

test('bad filters cannot silently select another library or sort',()=>{
  for(const invalid of [{type:'all'},{view:'unknown'},{collection:'bad'},{genre:-1},{genre:'bad'},{sort:'random'},{page:0},{page:'1.5'},{page:10001}])assert.throws(()=>libraryOptions({type:'movie',...invalid}),{status:400});
});

test('filter URLs restore browsing state and keep existing home shelf links working',()=>{
  const hash=libraryHash('tv',{view:'browse',genre:35,collection:'new',sort:'rating'});
  assert.deepEqual(libraryRoute('tv',hash),{type:'tv',view:'browse',genre:'35',collection:'new',sort:'rating'});
  assert.equal(libraryRoute('movie','#movies').view,'discover');
  assert.equal(libraryRoute('movie','#movies/now_playing').collection,'new');
  assert.equal(libraryRoute('tv','#series/on_the_air').collection,'new');
  assert.equal(libraryRoute('tv','#series/top_rated').collection,'top_rated');
  assert.equal(libraryHash('movie',{view:'browse',genre:'0'}),'#movies/browse');
});

test('discovery escapes metadata and shows only the current media type from My List',async()=>{
  const {library}=fixture({local:[item(1,{title:'<script>alert(1)</script>'})],watches:{guest:[]}});
  const data=await library({view:'discover'}),saved=[{id:5,type:'movie'},{id:6,type:'tv'}],seen=[];
  const html=libraryPage(data,{icon:()=>'',card:()=>'',rail:(label,items)=>{seen.push({label,items});return '';},saved});
  assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
  assert.deepEqual(seen.find(row=>row.label==='My List').items,[saved[0]]);
});
