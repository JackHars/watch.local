// Run from the watch.local checkout root; fixtures never use the network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createExampleResolver} from '../assets/vod-adapter.mjs';
const {createProviderContext}=await import(pathToFileURL(resolve('api/providers.mjs')));
const input={tmdb:42,kind:'series',season:0,episode:3};
const segment=Buffer.alloc(188*4);for(let i=0;i<4;i++)segment[i*188]=0x47;
function context({badAudio=false,controller=new AbortController()}={}) {
 const calls=[];
 const fetchResource=async(url,options)=>{
  const u=new URL(url);calls.push(u.pathname);
  assert.equal(u.hostname,'fixture.test','unexpected external request');
  assert.equal(options.headers.referer,'https://player.test/','headers must survive media validation');
  if(u.pathname==='/bad')return new Response('<html>offline</html>');
  if(u.pathname==='/audio-master')return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1280x720,AUDIO="a"\nvideo.m3u8\n');
  if(u.pathname==='/audio.m3u8')return new Response('unavailable',{status:badAudio?404:500});
  if(['/video.m3u8','/good'].includes(u.pathname))return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');
  if(u.pathname==='/segment.ts')return new Response(segment);
  assert.fail('Unexpected fixture path '+u.pathname);
 };
 return{ctx:createProviderContext({signal:controller.signal,fetchResource}),calls};
}
const source=path=>({url:'https://fixture.test/'+path,headers:{referer:'https://player.test/'},tmdb:42,kind:'series',season:0,episode:3});

test('adapter validates media and falls through a broken first candidate without changing episode identity',async()=>{
 const {ctx,calls}=context();
 const adapter=createExampleResolver({loadSources:async(actual,actualContext)=>{assert.deepEqual(actual,input);assert.equal(actualContext,ctx);return[source('bad'),source('good')];}});
 const result=await adapter(input,ctx);assert.equal(result.master,'https://fixture.test/good');assert.ok(calls.includes('/segment.ts'));assert.equal(result.server,'example');
 assert.deepEqual(calls.slice(0,2),['/bad','/good']);
});
test('unavailable default audio rejects the whole candidate and tries the next',async()=>{
 const {ctx,calls}=context({badAudio:true});
 const result=await createExampleResolver({loadSources:async()=>[source('audio-master'),source('good')]})(input,ctx);
 assert.equal(result.master,'https://fixture.test/good');assert.ok(calls.includes('/audio.m3u8'));
});
test('wrong movie, season, episode or kind is never opened; duplicate candidates run once',async()=>{
 const {ctx,calls}=context();
 const candidates=[{...source('bad'),tmdb:43},{...source('bad'),season:1},{...source('bad'),episode:2},{...source('bad'),kind:'movie'},source('bad'),source('bad'),source('good')];
 const result=await createExampleResolver({loadSources:async()=>candidates})(input,ctx);assert.equal(result.master,'https://fixture.test/good');assert.equal(calls.filter(p=>p==='/bad').length,1);
});
test('exhaustion is bounded and the error does not reveal a signed candidate URL',async()=>{
 const calls=[];const adapter=createExampleResolver({loadSources:async()=>Array.from({length:20},(_,n)=>source('missing?signature=private-fixture-'+n))});
 await assert.rejects(adapter(input,{signal:new AbortController().signal,accept:async(url)=>{calls.push(url);throw Error(url);}}),error=>error.message==='example has no playable HLS source for this item');assert.equal(calls.length,8);
});
test('abort stops retries and an already-cancelled request never loads sources',async()=>{
 const controller=new AbortController();let loaded=0,attempted=0;
 const adapter=createExampleResolver({loadSources:async()=>{loaded++;return[source('bad'),source('good')];}});
 const ctx={signal:controller.signal,accept:async()=>{attempted++;controller.abort();throw Error('Cancelled');}};
 await assert.rejects(adapter(input,ctx),{name:'AbortError'});assert.equal(attempted,1);
 await assert.rejects(adapter(input,ctx),{name:'AbortError'});assert.equal(loaded,1);
});
test('invalid and empty source lists fail without claiming success',async()=>{
 for(const value of [null,{},[],[null,{},source('bad')]]){
  const {ctx}=context();await assert.rejects(createExampleResolver({loadSources:async()=>value})(input,ctx));
 }
});

test('source-list errors are sanitized and a missing loader fails clearly',async()=>{
 assert.throws(()=>createExampleResolver(),/loadSources must be implemented/);
 const {ctx}=context();
 const adapter=createExampleResolver({loadSources:async()=>{throw Error('https://fixture.test/?signature=private-fixture');}});
 await assert.rejects(adapter(input,ctx),error=>error.message==='example could not load its source list');
});
