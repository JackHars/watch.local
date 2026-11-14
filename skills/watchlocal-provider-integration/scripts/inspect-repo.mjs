#!/usr/bin/env node
// Read-only map of integration points. Does not import app modules, inspect
// runtime data, call APIs, modify files, or certify a provider implementation.
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const usage = 'Usage: node inspect-repo.mjs --repo /path/to/watch.local --mode vod|channels|sports [--id example]';
const argv = process.argv.slice(2), options = {};
if (argv.length === 1 && argv[0] === '--help') { console.log(usage); process.exit(0); }
for (let i=0; i<argv.length; i+=2) {
  if (!['--repo','--mode','--id'].includes(argv[i]) || !argv[i+1] || argv[i+1].startsWith('--') || options[argv[i]]) { console.error(usage); process.exit(2); }
  options[argv[i]] = argv[i+1];
}
if (!options['--repo'] || !['vod','channels','sports'].includes(options['--mode']) || options['--id'] && !/^[a-z][a-z0-9]{0,31}$/.test(options['--id'])) { console.error(usage); process.exit(2); }
const root = resolve(options['--repo']), mode = options['--mode'], id = options['--id'];
const common = [
 ['api/settings.mjs', 'export const defaultConfig', 'fresh-install defaults'],
 ['api/settings.mjs', 'function validateConfig', 'config validation'],
 ['api/settings.mjs', 'const added =', 'VOD migration preserves order/disables'],
 ['api/iptv.mjs', 'export function initializeIPTV', 'inject sources before startup'],
 ['api/iptv.mjs', 'async function serveMedia', 'signed relay and later failures'],
 ['api/iptv.mjs', 'export async function browserPlay', 'web playback shape and provider label'],
 ['public/app.js', 'const names =', 'display names'],
 ['public/app.js', "if(section==='providers')settingsShell", 'provider settings controls'],
 ['public/app.js', "if(section==='providers')config=", 'serialize provider settings'],
];
const byMode = {
 vod: [
  ['api/providers.mjs','export const PROVIDERS','provider ID registry'],
  ['api/providers.mjs','export function createProviderContext','bounded network I/O and HLS/audio validation'],
  ['api/providers.mjs','const adapters =','resolver registration'],
  ['api/providers.mjs','const order =','configured order, pinning and exclusions'],
  ['api/reelix.mjs','export function createReelixResolver','separate adapter example'],
  ['api/web.mjs',"path === '/ui/playback.m3u8'",'native tap and Accept: application/json inspection'],
  ['public/playback-recovery.mjs','export function createPlaybackRecovery','player-triggered provider exclusions'],
  ['test/providers.mjs','for (const provider of PROVIDERS','registry-driven fixture loop'],
 ],
 channels: [
  ['api/channel-provider.mjs','export function createChannelProvider','source contract, persisted IDs, EPG and relay'],
  ['api/timstreams.mjs','export function createTimstreamsSource','channel source example'],
  ['api/live.mjs','const providers =','live provider registry'],
  ['api/live.mjs','const providerFor =','numeric ID dispatch; check new range first'],
  ['api/live.mjs','async media(','media provider dispatch'],
  ['api/live.mjs','recover:','fallback after a selected feed fails'],
  ['api/channel-groups.mjs','export function groupChannels','one UI card per broadcaster/country'],
  ['api/channel-groups.mjs','export async function probeChannelStream','provider-specific validation'],
  ['api/channel-metadata.mjs','export function channelMetadata','category/country/logo identity'],
 ],
 sports: [
  ['api/strmfree.mjs','export function createStrmfreeSource','existing fallback example'],
  ['api/sports.mjs','export function createSportsProvider','primary plus ONE named fallback today'],
  ['api/sports.mjs',"const candidates = ['primary'",'candidate order must be extended for a third source'],
  ['api/sports.mjs','async media(','renewal, disabled sources and root switching'],
  ['api/sports.mjs','async recover(','currently primary-to-Strmfree only'],
  ['api/iptv.mjs',"resolvedLive?.sportsSource === 'primary'",'relay recovery guard also needs extension'],
  ['api/live.mjs','export function createLiveProvider','source construction, config and status'],
  ['api/strmfree.mjs','export function matchStrmfreeEvent','strict same-game matching example'],
 ],
};
const testFiles = {
 vod: ['test/reelix.mjs','test/providers.mjs','test/providers-http.mjs','test/vod-fallback-http.mjs','test/playback-recovery.mjs','test/settings.mjs'],
 channels: ['test/timstreams.mjs','test/timstreams-http.mjs','test/live-http.mjs','test/channel-metadata.mjs','test/settings.mjs'],
 sports: ['test/strmfree.mjs','test/sports.mjs','test/sports-fallback-http.mjs','test/settings.mjs'],
};
try {
  const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  if (pkg.name !== 'watchlocal') throw new Error('The supplied path is not the watchlocal checkout.');
  console.log(`Repository: ${root}\nMode: ${mode}\nNode: ${process.versions.node} (project requires ${pkg.engines?.node || 'check package.json'})`);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or newer for this project.');
  try {
    const status = execFileSync('git',['--no-optional-locks','-C',root,'status','--short'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    console.log(status ? 'Working tree has changes: inspect git status and preserve unrelated edits.' : 'Working tree clean.');
  } catch { console.log('Git status unavailable; confirm this is the intended checkout.'); }
  const registry = await readFile(join(root,'api/providers.mjs'),'utf8');
  const declaration = registry.match(/export const PROVIDERS = Object\.freeze\(\[([^\]]+)\]\)/);
  const ids = declaration ? [...declaration[1].matchAll(/'([a-z0-9]+)'/g)].map(m=>m[1]) : [];
  console.log('VOD IDs: '+(ids.join(', ') || 'registry format changed; inspect manually'));
  if (id) {
    let exists=false;try { await access(join(root,'api',id+'.mjs'));exists=true; } catch {}
    console.log(`Requested ID: ${id}; in VOD registry: ${ids.includes(id)}; adapter file exists: ${exists}`);
  }
  let missing=0;const texts=new Map();
  for (const [file,anchor,reason] of [...common,...byMode[mode]]) {
    let text=texts.get(file);
    if (text===undefined) { try { text=await readFile(join(root,file),'utf8'); } catch { text=''; } texts.set(file,text); }
    const position=text.indexOf(anchor);
    if(position<0){console.log(`REVIEW ${file}: ${reason} (anchor missing)`);missing++;}
    else console.log(`${file}:${text.slice(0,position).split('\n').length} — ${reason}`);
  }
  console.log('Relevant existing tests:');
  for (const file of testFiles[mode]) {
    try { await access(join(root,file));console.log('  '+file); } catch { console.log('  REVIEW missing '+file);missing++; }
  }
  console.log('Package scripts (register new files here):');
  for (const key of ['check','test',mode==='vod'?'test:providers':mode==='channels'?'test:live':'test:sports','check:private']) {
    const present=typeof pkg.scripts?.[key]==='string';
    console.log(`  ${key}: ${present?'present':'MISSING'}`);if(!present)missing++;
  }
  console.log('Inventory only: validate real behavior with the selected reference and tests.');
  if(missing){console.log(`${missing} expected anchors/files differ. Read current code before using this map.`);process.exitCode=2;}
} catch(error) { console.error(error.message);process.exitCode=2; }
