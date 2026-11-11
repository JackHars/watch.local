import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscovery, discoveryInterfaces, discoveryConfig, companionStatus } from '../api/discovery.mjs';
import { createSettingsStore } from '../api/settings.mjs';
import { createDiscoveryCompanion } from '../discovery-companion.mjs';
import { startDiscovery } from '../discovery-runtime.mjs';

const address = (address, family = 'IPv4', internal = false) => ({ address, family, internal });
const lan = () => ({ lo: [address('127.0.0.1','IPv4',true)], eth0: [address('192.168.1.20'),address('fe80::20','IPv6')],
  docker0: [address('172.17.0.1')], 'br-fixture': [address('172.18.0.1')], tun0: [address('10.0.0.2')] });
const target = { enabled: true, hostname: 'watch', name: 'watch.local', host: '0.0.0.0', port: 80 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], reports = [];
  const factory = options => {
    const call = { options, shutdowns: 0 }; calls.push(call);
    return {
      createService(options) {
        call.service = Object.assign(new EventEmitter(), { options, hostname: options.hostname + '.local.',
          getHostname() { return this.hostname; },
          advertise: () => new Promise((resolve,reject) => { call.resolve = resolve; call.reject = reject; }),
        }); return call.service;
      },
      async shutdown() { call.shutdowns++; call.reject?.(Error('cancelled')); },
    };
  };
  return { calls, reports, factory };
}

test('local discovery defaults on, migrates and persists a validated local name without exposing credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-mdns-settings-'));
  try {
    const store=createSettingsStore(directory);await store.initialize();
    assert.equal(store.config().server.mdns,true);assert.equal(store.config().server.mdnsHostname,'watch');
    const old=store.get();delete old.config.server.mdns;delete old.config.server.mdnsHostname;
    await writeFile(join(directory,'iptv.json'),JSON.stringify(old));
    const migrated=createSettingsStore(directory);await migrated.initialize();assert.equal(migrated.config().server.mdns,true);
    for(const mdnsHostname of ['bad.local','-bad','bad-','bad name','a'.repeat(64),'<script>',null])await assert.rejects(migrated.configure({server:{mdnsHostname}}),{status:400});
    await assert.rejects(migrated.configure({server:{mdns:'true'}}),{status:400});
    await migrated.configure({server:{mdns:false,mdnsHostname:' Living-Room '}});
    const restored=createSettingsStore(directory);await restored.initialize();assert.equal(restored.config().server.mdns,false);assert.equal(restored.config().server.mdnsHostname,'living-room');
    const config=discoveryConfig(restored.config().server,{host:'0.0.0.0',port:8091,webPort:80});
    assert.equal(config.port,80);assert.ok(!JSON.stringify(config).includes(restored.get().password));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('only reachable LAN interfaces are advertised, respecting IPv4, IPv6 and specific binds',()=>{
  assert.deepEqual(discoveryInterfaces('0.0.0.0',lan()),[{name:'eth0',addresses:['192.168.1.20']}]);
  assert.equal(discoveryInterfaces('::',lan())[0].addresses.length,2);
  assert.deepEqual(discoveryInterfaces('192.168.1.20',lan()),[{name:'eth0',addresses:['192.168.1.20']}]);
  for(const host of ['127.0.0.1','::1','localhost','10.1.1.2'])assert.deepEqual(discoveryInterfaces(host,lan()),[]);
});

test('advertises the actual web port, reports conflict names, reacts to address changes and sends goodbye on disable',async()=>{
  const f=fixture();let interfaces=lan();const discovery=createDiscovery({responderFactory:f.factory,interfaces:()=>interfaces,onStatus:s=>f.reports.push(s)});
  try{
    await discovery.configure(target);assert.equal(discovery.status().state,'starting');
    const call=f.calls[0];assert.deepEqual(call.options.interface,['eth0']);assert.equal(call.service.options.port,80);assert.deepEqual(call.service.options.txt,{path:'/'});
    call.resolve();await settle();assert.equal(discovery.status().url,'http://watch.local');
    call.service.hostname='watch-(2).local.';call.service.emit('hostname-change','watch-(2)');
    assert.equal(discovery.status().url,'http://watch-(2).local');assert.match(discovery.status().message,/already in use/);
    await discovery.configure({...target,port:8091});assert.equal(call.shutdowns,1);f.calls[1].resolve();await settle();assert.equal(discovery.status().url,'http://watch.local:8091');
    interfaces={...lan(),eth0:[address('192.168.1.21')]};await discovery.refresh();assert.equal(f.calls[1].shutdowns,1);assert.equal(f.calls.length,3);
    f.calls[2].resolve();await settle();await discovery.configure({...target,enabled:false});assert.equal(f.calls[2].shutdowns,1);assert.equal(discovery.status().state,'disabled');assert.equal(discovery.status().url,'');
  }finally{await discovery.close();}
  assert.ok(f.calls.every(c=>c.shutdowns===1));
});

test('discovery failure and offline interfaces leave HTTP usable and recover on retry; pending probes cancel cleanly',async()=>{
  const f=fixture();let interfaces={};const discovery=createDiscovery({responderFactory:f.factory,interfaces:()=>interfaces});
  await discovery.configure(target);assert.equal(f.calls.length,0);assert.equal(discovery.status().state,'unavailable');
  interfaces=lan();await discovery.refresh();f.calls[0].reject(Error('EADDRINUSE'));await settle();assert.equal(discovery.status().state,'unavailable');
  await discovery.refresh();assert.equal(f.calls[0].shutdowns,1);assert.equal(f.calls.length,2);
  await discovery.configure({...target,hostname:'living-room'});assert.equal(f.calls[1].shutdowns,1);
  f.calls[1].resolve();await settle();assert.notEqual(discovery.status().state,'advertising','cancelled probe cannot report success');
  f.calls[2].resolve();await settle();assert.equal(discovery.status().hostname,'living-room.local');
  await discovery.close();assert.equal(f.calls[2].shutdowns,1);
});

test('the renamed service fits DNS label limits for every valid local name length',async()=>{
  const f=fixture(), discovery=createDiscovery({responderFactory:f.factory,interfaces:lan});
  try {
    for(const length of [5,49,50,63]){
      const hostname='a'.repeat(length);await discovery.configure({...target,hostname});
      const call=f.calls.at(-1);assert.ok(Buffer.byteLength(call.service.options.name)<=63);
      assert.equal(call.service.options.hostname,hostname);call.resolve();await settle();
      assert.equal(discovery.status().hostname,hostname+'.local');
    }
  }finally{await discovery.close();}
});

test('companion reports must be fresh, match the current settings, and cannot supply arbitrary links',()=>{
  const now=Date.now(),record={at:now,target:JSON.stringify(target),status:{state:'advertising',hostname:'watch.local',url:'https://evil.example'}};
  assert.equal(companionStatus(record,target,now).url,'http://watch.local');
  for(const changed of [{at:now-21000},{at:now+2000},{target:'old settings'},{status:{state:'advertising',hostname:'evil.example'}}])assert.equal(companionStatus({...record,...changed},target,now),null);
});

test('Docker companion tracks actual web settings, withdraws on app failure and resumes after recovery',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-mdns-companion-'));const statusFile=join(directory,'status.json');
  let health={ok:true,application:'watchlocal',discovery:target},fail=false,status={state:'starting'},closed=0;const requests=[];
  const companion=createDiscoveryCompanion({endpoint:'http://127.0.0.1:8091/health',statusFile,log:()=>{},
    fetchHealth:async()=>{if(fail)throw Error('offline');return Response.json(health);},
    publisherFactory:({onStatus})=>({async configure(t){requests.push(t);status=t.enabled?{state:'advertising',hostname:t.hostname+'.local',url:'http://'+t.hostname+'.local'}:{state:'disabled',hostname:'',url:''};onStatus(status);},status:()=>status,async close(){closed++;}}),
  });
  try{
    await companion.refresh();assert.deepEqual(requests.at(-1),target);let record=JSON.parse(await readFile(statusFile));assert.equal(companionStatus(record,target).url,'http://watch.local');
    health={...health,discovery:{...target,enabled:false}};await companion.refresh();assert.equal(requests.at(-1).enabled,false);
    fail=true;await companion.refresh();assert.equal(requests.at(-1).enabled,false);assert.equal(companionStatus(JSON.parse(await readFile(statusFile)),target),null);
    fail=false;health={...health,discovery:{...target,port:8091}};await companion.refresh();assert.equal(requests.at(-1).port,8091);
    health.application='another-service';await companion.refresh();assert.equal(requests.at(-1).enabled,false);
    assert.throws(()=>createDiscoveryCompanion({endpoint:'https://example.com/health'}),/local watch.local/);
  }finally{await companion.close();assert.equal(closed,1);await rm(directory,{recursive:true,force:true});}
});

test('runtime exposes only verified companion status and applies disable/name changes without restarting',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'watchlocal-mdns-runtime-')),statusFile=join(directory,'status.json');
  const store=createSettingsStore(directory);await store.initialize();const network={host:'0.0.0.0',webPort:80};
  const runtime=startDiscovery({settings:store,network,mode:'external',statusFile});
  try{
    await runtime.refresh();assert.equal(network.discovery?.state,'unavailable');
    const config=discoveryConfig(store.config().server,network);
    await writeFile(statusFile,JSON.stringify({at:Date.now(),target:JSON.stringify(config),status:{state:'advertising',hostname:'watch.local'}}));
    await store.configure({server:{mdns:true}});await runtime.refresh();assert.equal(network.discovery?.url,'http://watch.local');
    await store.configure({server:{mdnsHostname:'living-room'}});await runtime.refresh();assert.notEqual(network.discovery?.state,'advertising');
    await store.configure({server:{mdns:false}});await runtime.refresh();assert.equal(network.discovery?.state,'disabled');
  }finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
});
