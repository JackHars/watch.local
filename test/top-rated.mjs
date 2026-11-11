import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankTopRated,collectTopRated} from '../api/top-rated.mjs';

const today='2026-11-11';
const film=(id,extra={})=>({id,title:`Film ${id}`,media_type:'movie',original_language:'en',genre_ids:[18],vote_average:8,vote_count:10000,popularity:20,poster_path:'/poster.jpg',release_date:'2020-01-01',...extra});
const show=(id,extra={})=>({...film(id),title:undefined,name:`Show ${id}`,media_type:'tv',first_air_date:'2020-01-01',...extra});

test('top-rated rows exclude animation, non-English titles, unreleased items and weak vote samples',()=>{
  const movies=[film(1),film(2,{genre_ids:[16,18],vote_average:9.8,vote_count:200000}),film(3,{original_language:'ja'}),film(4,{release_date:'2027-01-01'}),film(5,{vote_count:999}),film(6,{adult:true}),film(7,{genre_ids:[]}),film(8,{vote_average:6.9}),film(9,{release_date:''}),film(10,{vote_count:undefined}),film(11,{vote_average:11})];
  assert.deepEqual(rankTopRated(movies,'movie',today).map(i=>i.id),[1]);
  assert.deepEqual(rankTopRated([show(1,{vote_count:500}),show(2,{vote_count:499}),show(3,{genre_ids:[16]})],'tv',today).map(i=>i.id),[1]);
  assert.deepEqual(rankTopRated([film(12,{genre_ids:['16']}),film(13,{genre_ids:['unknown']})],'movie',today),[]);
  assert.equal(movies.length,11,'ranking must not modify its input');
});

test('audience confidence outweighs a small fan sample and popularity cannot overwhelm strong ratings',()=>{
  const established=film(1,{vote_average:8.5,vote_count:30000});
  const niche=film(2,{vote_average:9.5,vote_count:1000,popularity:1000000});
  const hype=film(3,{vote_average:7.1,vote_count:30000,popularity:1e100});
  assert.deepEqual(rankTopRated([hype,niche,established],'movie',today).map(i=>i.id),[1,2,3]);
  assert.deepEqual(rankTopRated([film(4,{popularity:1}),film(5,{popularity:100})],'movie',today).map(i=>i.id),[5,4],'popularity breaks otherwise comparable candidates');
  assert.deepEqual(rankTopRated([established,{...established,vote_count:31000}],'movie',today).map(i=>i.vote_count),[31000]);
  assert.deepEqual(rankTopRated([film(9),film(8)],'movie',today).map(i=>i.id),[8,9],'equal scores have deterministic ordering');
});

test('candidate collection combines rating and popularity pages, bounds work and ranks the whole pool once',async()=>{
  const seen=[];
  const data=await collectTopRated('movie',async(path,{page})=>{
    seen.push({path,page});
    return {results:[film(path.endsWith('/popular')?100+page:page,{vote_average:path.endsWith('/popular')?8.7:9,vote_count:path.endsWith('/popular')?40000:1000})],total_pages:500};
  },{today});
  assert.equal(seen.length,9);assert.equal(seen.filter(i=>i.path.endsWith('/top_rated')).length,6);
  assert.equal(data.complete,true);assert.equal(data.results.length,9);assert.equal(data.results[0].id,101,'popular candidates can outrank raw top-rated candidates');
});

test('partial source failures retain filtered candidates and cancellation stops further requests',async()=>{
  const data=await collectTopRated('movie',async path=>{
    if(path.endsWith('/popular'))throw Error('offline');
    return {results:[film(1),film(2,{genre_ids:[16]})],total_pages:1};
  },{today});
  assert.equal(data.complete,false);assert.deepEqual(data.results.map(i=>i.id),[1]);
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(collectTopRated('movie',async()=>{calls++;},{today,signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,0);
});
