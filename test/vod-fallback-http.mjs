import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('browser/native episode playback rejects broken audio and accepts excluded-provider recovery without repeating the failed source', async () => {
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-vod-fallback-'));process.env.WATCHLOCAL_DATA_DIR=directory;
  const {settingsStore}=await import('../api/settings.mjs');
  const {watchProgressStore}=await import('../api/watch-progress.mjs');
  const {initializeIPTV}=await import('../api/iptv.mjs');
  const {createServer}=await import('../server.mjs');
  const original=globalThis.fetch;let server,brokenAudio=true,zstreamCalls=0,backupCalls=0;
  const video=Buffer.alloc(752,0x47),leaf='#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
  try{
    globalThis.fetch=async(url,options)=>{
      const u=new URL(url);if(u.hostname==='127.0.0.1')return original(url,options);
      if(u.hostname==='api.zstream.mov'){zstreamCalls++;const input=JSON.parse(options.body);assert.equal(input.tmdb_id,'320507');assert.equal(input.season,1);return Response.json({streams:[{type:'hls',playlist:`https://primary.test/${input.episode}/master.m3u8`}]});}
      if(u.hostname==='7movies.ac'){backupCalls++;const input=JSON.parse(options.body);assert.equal(input.episode,3);return Response.json({token:'fixture-token'});}
      if(u.hostname==='embed.vidrift.net')return Response.json({meta:{bigbangUrl:'https://backup.test/master.m3u8'}});
      if(u.hostname==='primary.test'){
        if(u.pathname.endsWith('master.m3u8'))return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,NAME="English",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="a"\nvideo.m3u8\n');
        if(u.pathname.endsWith('audio.m3u8')&&u.pathname.startsWith('/3/')&&brokenAudio)return new Response('Missing episode audio',{status:404});
        if(u.pathname.endsWith('.m3u8'))return new Response(leaf);
        return new Response(video);
      }
      if(u.hostname==='backup.test')return new Response(u.pathname.endsWith('.m3u8')?leaf:video);
      return new Response('Unavailable fixture',{status:404});
    };
    await initializeIPTV({sportsDirectory:directory,zliveSource:{list:async()=>[]},timstreamsSource:{list:async()=>[]}});
    await settingsStore.configure({playback:{enabled:['zstream','vidrift']}});
    const owner=settingsStore.get().ownerId,profile=await watchProgressStore.createProfile(owner,{name:'Viewer',color:'#527de0'});
    server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
    const input={profileId:profile.id,type:'tv',id:320507,season:1,episode:3,fresh:true};
    const play=data=>fetch(base+'/ui/play',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({...input,...data})});
    for(const episode of [2,3,4]){
      const response=await play({episode});assert.equal(response.status,200);const stream=await response.json();
      assert.equal(stream.provider,episode===3?'vidrift':'zstream');
      if(episode===3)assert.deepEqual(stream.attemptedProviders,['zstream','vidrift']);
    }
    brokenAudio=false;
    const native=base+'/ui/playback.m3u8?'+new URLSearchParams({...input,fresh:'1',requestId:'a'.repeat(32)});
    const redirect=await original(native,{redirect:'manual'});assert.equal(redirect.status,302);
    const before=zstreamCalls,info=await original(native,{headers:{Accept:'application/json'}}).then(r=>r.json());
    assert.equal(info.provider,'zstream');assert.deepEqual(info.attemptedProviders,['zstream']);assert.equal(zstreamCalls,before,'Native error inspection must reuse this tap’s selected source');
    brokenAudio=true;
    const root=await fetch(redirect.headers.get('location')).then(r=>r.text());const audio=root.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/)[1];
    assert.equal((await fetch(audio)).status,502,'The audio can fail after resolution');
    const recovered=await play({exclude:info.attemptedProviders});assert.equal(recovered.status,200);const stream=await recovered.json();
    assert.equal(stream.provider,'vidrift');assert.equal(zstreamCalls,before,'Recovery must not reselect a source the player already rejected');
    assert.match(await fetch(stream.url).then(r=>r.text()),/^#EXTM3U/);
    assert.equal((await play({exclude:'zstream'})).status,400);
    assert.equal((await original(native+'&exclude=unknown',{redirect:'manual'})).status,400);
    await settingsStore.configure({playback:{enabled:['zstream']}});const backups=backupCalls;
    const exhausted=await play({exclude:['zstream']});assert.equal(exhausted.status,502);assert.match((await exhausted.json()).error,/No other enabled provider/);assert.equal(backupCalls,backups);
  }finally{globalThis.fetch=original;server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
