import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

test('LAN web access defaults on, respects network boundaries and explicit users, and can be locked immediately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-lan-'));
  process.env.WATCHLOCAL_DATA_DIR = directory;
  const { settingsStore, createSettingsStore } = await import('../api/settings.mjs');
  const { privateAddress, lanWebUser, sessionUser } = await import('../api/sessions.mjs');
  const { createServer } = await import('../server.mjs');
  let server;
  try {
    await settingsStore.initialize();
    const owner = settingsStore.user(settingsStore.get().ownerId);
    assert.equal(settingsStore.config().server.requireLanLogin, false);
    for (const ip of ['127.0.0.1', '10.0.0.2', '172.16.0.2', '172.31.255.254', '192.168.1.12', '169.254.1.2', '::1', '::ffff:192.168.1.12', 'fd12::1', 'fe80::1']) assert.ok(privateAddress(ip), ip);
    for (const ip of ['', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '100.64.0.1', '2001:4860::1', '192.168.1.999', 'fcgarbage']) assert.equal(privateAddress(ip), false, ip);
    const request = (overrides = {}) => ({url:'/ui/settings',socket:{remoteAddress:'192.168.1.12'},headers:{host:'192.168.1.110:8091'},...overrides});
    assert.equal(lanWebUser(request()).id, owner.id);
    for (const host of ['server:8091','server.local:8091','server.localdomain:8091','watch.lan','watch.lan:8091','WATCH.LAN.']) assert.equal(lanWebUser(request({headers:{host}})).id, owner.id);
    assert.equal(lanWebUser(request({socket:{remoteAddress:'8.8.8.8'}})), null);
    assert.equal(lanWebUser(request({socket:{remoteAddress:'8.8.8.8'},headers:{host:'watch.lan'}})), null);
    for(const host of ['evil.example','watch.lan.evil.example','watch.lanexample'])assert.equal(lanWebUser(request({headers:{host}})), null);
    for (const headers of [
      {host:'192.168.1.110:8091','x-forwarded-for':'192.168.1.12'},
      {host:'192.168.1.110:8091',forwarded:'for=192.168.1.12'},
      {host:'192.168.1.110:8091',origin:'https://evil.example'},
      {host:'192.168.1.110:8091','sec-fetch-site':'cross-site'},
    ]) assert.equal(lanWebUser(request({headers})), null);
    assert.equal(lanWebUser(request({url:'/resolve?tmdb=550'})), null);
    assert.equal(sessionUser(request({headers:{host:'192.168.1.110:8091',cookie:'watchlocal_session=stale'}})), null);
    server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    // Send a real Host header; fetch may replace it with the connection URL.
    const named = (headers = {}) => new Promise((resolve,reject) => {
      const req=httpRequest(base+'/ui/settings',{headers:{host:'watch.lan',origin:'http://watch.lan',...headers}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));
      });
      req.on('error',reject);req.end();
    });
    const http = (path, {method='GET',body,headers={}}={}) => fetch(base+path,{method,headers:{origin:base,...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    let response = await http('/ui/session'); let data = await response.json();
    assert.equal(data.user.id, owner.id); assert.equal(data.lanAccess,true);
    assert.equal((await http('/ui/settings')).status,200);
    const localDomain=await named();assert.equal(localDomain.status,200);assert.equal(localDomain.data.config.server.requireLanLogin,false);
    assert.equal((await named({'x-forwarded-for':'192.168.1.12'})).status,401);
    assert.equal((await named({origin:'https://evil.example'})).status,401);
    assert.equal((await named({host:'watch.lan.evil.example',origin:'http://watch.lan.evil.example'})).status,401);
    assert.equal((await http('/ui/connections')).status,200);
    assert.equal((await http('/resolve?tmdb=550')).status,401);
    assert.equal((await http('/player_api.php?username=invalid&password=invalid')).status,401);
    assert.equal((await http('/ui/settings',{method:'PUT',body:{server:{requireLanLogin:true}},headers:{origin:'https://evil.example'}})).status,403);
    const viewer = await settingsStore.upsertUser({username:'viewer',password:'viewerpass'},owner);
    response = await http('/ui/login',{method:'POST',body:{username:'viewer',password:'viewerpass'}});
    const cookie=response.headers.get('set-cookie').split(';')[0];
    assert.equal((await http('/ui/settings',{headers:{cookie}})).status,403);
    assert.equal((await http('/ui/session',{headers:{cookie}}).then(r=>r.json())).user.id,viewer.id);
    await settingsStore.upsertUser({enabled:false},owner,viewer.id);
    assert.equal((await http('/ui/settings',{headers:{cookie}})).status,401);
    assert.equal((await http('/ui/settings',{method:'PUT',body:{server:{requireLanLogin:'true'}}})).status,400);
    assert.equal((await http('/ui/settings',{method:'PUT',body:{server:{requireLanLogin:true}}})).status,200);
    assert.equal((await http('/ui/settings')).status,401);
    assert.equal((await named()).status,401,'enabling LAN login also locks local DNS names');
    data=await http('/ui/session').then(r=>r.json()); assert.equal(data.user,null); assert.equal(data.lanAccess,false);
    const reloaded=createSettingsStore(directory); await reloaded.initialize(); assert.equal(reloaded.config().server.requireLanLogin,true);
    response=await http('/ui/login',{method:'POST',body:{username:owner.username,password:owner.password}});
    const admin=response.headers.get('set-cookie').split(';')[0];
    assert.equal((await http('/ui/settings',{method:'PUT',headers:{cookie:admin},body:{server:{requireLanLogin:false}}})).status,200);
    assert.equal((await http('/ui/settings')).status,200);
    assert.equal((await named()).status,200);
    assert.equal((await http('/ui/settings',{headers:{'x-forwarded-for':'192.168.1.12'}})).status,401);
    assert.equal((await http('/manifest.webmanifest')).status,200);
  } finally {
    server?.closeAllConnections(); if(server) await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
