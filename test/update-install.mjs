import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installUpdater, parseOptions } from '../scripts/install-updater.mjs';
import { command, writeJSON } from '../scripts/update-runner.mjs';
import { readRevision } from '../api/runtime-version.mjs';

test('runtime revisions work with loose refs, packed refs, detached HEAD, linked worktrees and source archives', async t => {
  const root=await mkdtemp(join(tmpdir(),'watchlocal-version-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),git=join(repo,'.git'),a='a'.repeat(40),b='b'.repeat(40);
  await mkdir(join(git,'refs/heads'),{recursive:true});await writeFile(join(git,'HEAD'),'ref: refs/heads/main\n');await writeFile(join(git,'refs/heads/main'),a+'\n');
  assert.equal(await readRevision(repo),a);
  await mkdir(join(repo,'api'));await writeFile(join(repo,'api/runtime-version.mjs'),await readFile(new URL('../api/runtime-version.mjs',import.meta.url)));
  const loaded=await import(pathToFileURL(join(repo,'api/runtime-version.mjs')));
  await writeFile(join(git,'refs/heads/main'),b+'\n');assert.equal(loaded.runningRevision,a);assert.equal(await loaded.readRevision(),b);
  await rm(join(git,'refs/heads/main'));await writeFile(join(git,'packed-refs'),`# packed refs\n${b} refs/heads/main\n`);assert.equal(await readRevision(repo),b);
  await writeFile(join(git,'HEAD'),a+'\n');assert.equal(await readRevision(repo),a);
  const worktree=join(root,'worktree'),privateGit=join(git,'worktrees/worktree');
  await mkdir(privateGit,{recursive:true});await mkdir(worktree);await writeFile(join(worktree,'.git'),`gitdir: ${privateGit}\n`);
  await writeFile(join(privateGit,'HEAD'),'ref: refs/heads/main\n');await writeFile(join(privateGit,'commondir'),'../..\n');assert.equal(await readRevision(worktree),b);
  assert.equal(await readRevision(root),null);await writeFile(join(privateGit,'HEAD'),'ref: refs/../../outside\n');assert.equal(await readRevision(worktree),null);
});

test('installer accepts explicit user/system managers and never silently mixes them', () => {
  assert.deepEqual(parseOptions(['--system-service','watchlocal.service','--enable']),{'system-service':'watchlocal.service',enable:true});
  assert.deepEqual(parseOptions(['--service','watchlocal.service']),{service:'watchlocal.service'});
  for(const args of [[],['--system-service'],['--system-service','watchlocal.service','--service','other.service'],['--arbitrary','command']])assert.throws(()=>parseOptions(args));
});

async function installation(t) {
  const root=await mkdtemp(join(tmpdir(),'watchlocal-install-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),data=join(repo,'data'),home=join(root,'home'),systemRoot=join(root,'system');
  await mkdir(data,{recursive:true});await mkdir(home);await mkdir(join(systemRoot,'usr/bin'),{recursive:true});
  await writeFile(join(systemRoot,'usr/bin/systemctl'),'fixture');
  await command('git',['init','--initial-branch=main',repo]);
  await writeFile(join(repo,'.gitignore'),'data/\nnode_modules/\n');
  await command('git',['-C',repo,'add','.']);await command('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Fixture']);
  await command('git',['-C',repo,'remote','add','origin','https://github.com/example/watch.local.git']);
  await writeJSON(join(data,'iptv.json'),{credential:'private-fixture-value',config:{server:{port:8091,webPort80:true},updates:{enabled:false,intervalMinutes:10}}});
  const calls=[];let load='loaded',workingDirectory=repo;
  async function run(file,args,settings){
    calls.push([file,args]);
    if(file==='runuser')return run(args[3],args.slice(4),settings);
    if(file==='getent')return `piuser:x:${process.getuid()}:${process.getgid()}:Fixture:${home}:/bin/bash`;
    if(file.endsWith('systemctl'))return args.includes('show')?`LoadState=${load}\nUser=piuser\nWorkingDirectory=${workingDirectory}`:'';
    if(file==='loginctl')return 'yes';
    if(file==='sudo'){assert.equal(args[1],'-l');return '';}
    if(file==='visudo'){const policy=await readFile(args[1],'utf8');assert.match(policy,/NOPASSWD:/);assert.doesNotMatch(policy,/ALL\s*$/);return '';}
    if(file==='env'){assert.ok(args.includes('systemctl'));return '';}
    assert.ok(['git','flock','test','mkdir'].includes(file),file);
    return command(file,args,settings);
  }
  return {repo,data,home,systemRoot,calls,run,load:value=>{load=value},working:value=>{workingDirectory=value}};
}

test('system-service repair installs an independent boot timer as the app user, with narrowly scoped restart permission', async t => {
  const f=await installation(t);
  const config=await installUpdater({'system-service':'watchlocal.service',repo:f.repo,enable:true},{run:f.run,uid:0,systemRoot:f.systemRoot,log:()=>{}});
  assert.equal(config.serviceScope,'system');assert.equal(config.service,'watchlocal.service');assert.deepEqual(config.healthUrls,['http://127.0.0.1:8091/health','http://127.0.0.1:80/health']);
  const unit=await readFile(join(f.systemRoot,'etc/systemd/system/watchlocal-update.service'),'utf8');
  assert.match(unit,/User=piuser/);assert.match(unit,/Type=oneshot/);assert.match(unit,/TimeoutStartSec=20min/);assert.ok(unit.includes(config.state));
  assert.match(await readFile(join(f.systemRoot,'etc/systemd/system/watchlocal-update.timer'),'utf8'),/OnBootSec=30s[\s\S]*WantedBy=timers.target/);
  const policy=await readFile(join(f.systemRoot,'etc/sudoers.d/watchlocal-updater'),'utf8');
  assert.equal(policy,`piuser ALL=(root) NOPASSWD: ${config.systemctl} stop watchlocal.service, ${config.systemctl} start watchlocal.service\n`);
  assert.equal((await stat(join(f.systemRoot,'etc/sudoers.d/watchlocal-updater'))).mode & 0o777,0o440);
  const stored=JSON.parse(await readFile(join(f.data,'iptv.json')));assert.equal(stored.credential,'private-fixture-value');assert.equal(stored.config.updates.enabled,true);assert.equal(stored.config.updates.intervalMinutes,10);
  const actions=f.calls.filter(([file])=>file===config.systemctl).map(([,args])=>args);
  assert.ok(actions.some(a=>a.join(' ')==='stop watchlocal.service'));assert.ok(actions.some(a=>a.join(' ')==='start watchlocal.service'));
  assert.ok(actions.some(a=>a.join(' ')==='enable --now watchlocal-update.timer'));assert.ok(actions.every(a=>!a.includes('--user')));
});

test('user-service installs keep the user manager and never write a sudo policy', async t => {
  const f=await installation(t);
  const config=await installUpdater({service:'watchlocal.service',repo:f.repo},{run:f.run,uid:1000,home:f.home,env:{},systemRoot:f.systemRoot,log:()=>{}});
  assert.equal(config.serviceScope,'user');
  assert.match(await readFile(join(f.home,'.config/systemd/user/watchlocal-update.timer'),'utf8'),/OnStartupSec=30s/);
  assert.ok(f.calls.some(([file,args])=>file==='systemctl'&&args.join(' ')==='--user enable --now watchlocal-update.timer'));
  assert.ok(!f.calls.some(([file])=>file==='visudo'||file==='sudo'));
  assert.equal(JSON.parse(await readFile(join(f.data,'iptv.json'))).config.updates.enabled,false);
});

test('installation rejects a wrong or missing service before writing updater configuration', async t => {
  const f=await installation(t);f.load('not-found');
  const deps={run:f.run,uid:0,systemRoot:f.systemRoot,log:()=>{}};
  await assert.rejects(installUpdater({'system-service':'watchlocal.service',repo:f.repo},deps),/not found/);
  f.load('loaded');f.working(f.home);
  await assert.rejects(installUpdater({'system-service':'watchlocal.service',repo:f.repo},deps),/different checkout/);
  await assert.rejects(stat(join(f.systemRoot,'etc/systemd/system/watchlocal-update.service')),{code:'ENOENT'});
});

test('repair cancels an update that never got past preparation, while preserving a transaction that changed files', async t => {
  const f=await installation(t),state=join(f.home,'.local/state/watchlocal-updater');
  const journal=join(state,'transaction.json');
  await writeJSON(journal,{previous:'a'.repeat(40),target:'b'.repeat(40),phase:'backed_up'});
  const options={'system-service':'watchlocal.service',repo:f.repo,enable:true},deps={run:f.run,uid:0,systemRoot:f.systemRoot,log:()=>{}};
  await assert.rejects(installUpdater(options,deps),/Preserve its backup/);assert.equal(JSON.parse(await readFile(journal)).phase,'backed_up');
  await writeJSON(journal,{previous:'a'.repeat(40),target:'b'.repeat(40),phase:'prepared'});
  await installUpdater(options,deps);await assert.rejects(stat(journal),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(join(f.data,'iptv.json'))).credential,'private-fixture-value');
  assert.equal(JSON.parse(await readFile(join(f.data,'updates/request.json'))).action,'check');
});
