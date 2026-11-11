import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('optional web listener separates routes while retaining IPTV links, access rules and browser playback',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-listeners-'));
  process.env.WATCHLOCAL_DATA_DIR=directory;
  const {settingsStore,createSettingsStore}=await import('../api/settings.mjs');
  const {listenServers}=await import('../listeners.mjs');
  const original=globalThis.fetch;
  let service,blocker;
  const stop=async()=>{service?.closeAllConnections();await service?.close();service=undefined;};
  try{
    await settingsStore.initialize();
    await settingsStore.configure({playback:{enabled:['zstream'],providerTimeout:5,totalTimeout:10}});
    const owner=settingsStore.user(settingsStore.get().ownerId);
    const auth=new URLSearchParams({username:owner.username,password:owner.password});
    globalThis.fetch=async(url,options)=>{
      const u=new URL(url);
      if(u.hostname==='127.0.0.1')return original(url,options);
      if(u.hostname==='api.zstream.mov')return new Response(JSON.stringify({streams:[{type:'hls',playlist:'https://fixture.test/master'}]}));
      if(u.hostname==='fixture.test' && u.pathname==='/master')return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n');
      if(u.hostname==='fixture.test' && u.pathname==='/seg.ts')return new Response(Buffer.alloc(188*4,0x47));
      return new Response('{}',{status:503});
    };
    const send=(base,path,body,headers={})=>fetch(base+path,{method:body?'PUT':'GET',headers:{origin:base,...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    await t.test('default uses one shared port',async t=>{
      t.after(stop);
      service=await listenServers({host:'127.0.0.1',port:0});
      const base=`http://127.0.0.1:${service.network.port}`;
      assert.equal(service.servers.length,1);assert.equal(service.network.webPort80,false);
      assert.equal((await fetch(base+'/')).status,200);
      assert.equal((await fetch(base+'/player_api.php?'+auth)).status,200);
      const settings=await send(base,'/ui/settings').then(r=>r.json());
      assert.equal(settings.config.server.webPort80,false);assert.equal(settings.running.webPort,settings.running.port);
      assert.equal((await send(base,'/ui/connections').then(r=>r.json())).server,base);
      const mapped=await new Promise((resolve,reject)=>{
        http.get(base+'/ui/connections',{headers:{host:'server.local:9000',origin:'http://server.local:9000'}},res=>{
          let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(JSON.parse(text)));
        }).on('error',reject);
      });
      assert.equal(mapped.server,'http://server.local:9000','shared mode retains the requested public port');
      await stop();
    });
    await t.test('enabled mode routes web and IPTV separately and preserves same-origin signed playback',async t=>{
      t.after(stop);
      await settingsStore.configure({server:{webPort80:true}});
      const restored=createSettingsStore(directory);await restored.initialize();
      service=await listenServers({host:'127.0.0.1',port:0,webPort80:restored.config().server.webPort80,webPort:0});
      const iptv=`http://127.0.0.1:${service.network.port}`,web=`http://127.0.0.1:${service.network.webPort}`;
      assert.notEqual(iptv,web);assert.equal(service.servers.length,2);
      const redirect=await fetch(iptv+'/',{redirect:'manual'});assert.equal(redirect.status,307);assert.equal(redirect.headers.get('location'),web+'/');
      assert.equal((await fetch(iptv+'/ui/settings')).status,404);assert.equal((await fetch(iptv+'/app.css')).status,404);
      assert.equal((await fetch(web+'/')).status,200);assert.equal((await fetch(web+'/app.css')).status,200);
      for(const path of ['/player_api.php','/get.php','/xmltv.php','/movie/'+owner.username+'/'+owner.password+'/550.m3u8'])assert.equal((await fetch(web+path)).status,404);
      assert.equal((await fetch(iptv+'/player_api.php')).status,401);
      const xtream=await fetch(iptv+'/player_api.php?'+auth).then(r=>r.json());assert.equal(xtream.user_info.auth,1);assert.equal(xtream.server_info.port,String(service.network.port));
      for(const base of [web,iptv])assert.equal((await fetch(base+'/health')).status,200);
      const running=(await send(web,'/ui/settings').then(r=>r.json())).running;
      assert.equal(running.port,service.network.port);assert.equal(running.webPort,service.network.webPort);assert.equal(running.webPort80,true);
      const connections=await send(web,'/ui/connections').then(r=>r.json());
      for(const key of ['server','playlist','sports','guide'])assert.equal(new URL(connections[key]).origin,iptv,key);
      await settingsStore.configure({server:{publicUrl:'http://iptv.example:9000'}});
      assert.equal((await send(web,'/ui/connections').then(r=>r.json())).server,'http://iptv.example:9000');
      assert.equal((await send(web,'/ui/settings',{server:{name:'Wrong origin'}},{origin:iptv})).status,403);
      const profileResponse=await fetch(web+'/ui/profiles',{method:'POST',headers:{origin:web,'content-type':'application/json'},body:JSON.stringify({name:'Listener fixture',color:'#527de0'})});
      assert.equal(profileResponse.status,201);const {profile}=await profileResponse.json();
      const playResponse=await fetch(web+'/ui/play',{method:'POST',headers:{origin:web,'content-type':'application/json'},body:JSON.stringify({type:'movie',id:550,profileId:profile.id})});
      assert.equal(playResponse.status,200);const play=await playResponse.json();assert.equal(new URL(play.url).origin,web);
      const media=await fetch(play.url);assert.equal(media.status,200);
      const segment=(await media.text()).split('\n').find(line=>line.startsWith('http'));
      assert.equal(new URL(segment).origin,web);assert.equal((await fetch(segment)).status,200);
      assert.equal((await fetch(web+'/iptv/subtitles/invalid/playlist.m3u8')).status,403);
      await settingsStore.configure({server:{publicUrl:'',requireLanLogin:true}});
      assert.equal((await send(web,'/ui/settings')).status,401);
      const signedIn=await fetch(web+'/ui/login',{method:'POST',headers:{origin:web,'content-type':'application/json'},body:JSON.stringify({username:owner.username,password:owner.password})});
      const cookie=signedIn.headers.get('set-cookie').split(';')[0];
      assert.equal((await send(web,'/ui/settings',undefined,{cookie})).status,200);
      const change=await send(web,'/ui/settings',{server:{webPort80:false,requireLanLogin:false}},{cookie});assert.equal(change.status,200);
      assert.equal(settingsStore.config().server.webPort80,false);assert.equal(service.network.webPort80,true,'network changes wait for a restart');
      const servers=[...service.servers];await stop();assert.ok(servers.every(server=>!server.listening));
      const disabled=createSettingsStore(directory);await disabled.initialize();
      service=await listenServers({host:'127.0.0.1',port:0,webPort80:disabled.config().server.webPort80,webPort:0});
      assert.equal(service.servers.length,1);assert.equal((await fetch(`http://127.0.0.1:${service.network.port}/`)).status,200);
      await stop();
    });
    await t.test('an occupied web port keeps the web panel and IPTV reachable on the main port',async t=>{
      t.after(stop);
      blocker=http.createServer((req,res)=>res.end('occupied'));blocker.listen(0,'127.0.0.1');await once(blocker,'listening');
      const port=blocker.address().port;
      await settingsStore.configure({server:{webPort80:true}});
      service=await listenServers({host:'127.0.0.1',port:0,webPort80:true,webPort:port});
      const base=`http://127.0.0.1:${service.network.port}`;
      assert.equal(service.servers.length,1);assert.equal((await fetch(base+'/')).status,200);
      assert.equal((await fetch(base+'/player_api.php?'+auth)).status,200);
      const settings=await send(base,'/ui/settings').then(r=>r.json());
      assert.equal(settings.config.server.webPort80,true);assert.equal(settings.running.webPort80,false);assert.match(settings.running.webError,/already in use/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/`).then(r=>r.text())),'occupied');
      await assert.rejects(listenServers({host:'127.0.0.1',port}),{code:'EADDRINUSE'});
      await stop();
    });
  }finally{
    globalThis.fetch=original;await stop();blocker?.closeAllConnections();if(blocker)await new Promise(resolve=>blocker.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
