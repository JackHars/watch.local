import { readFile } from 'node:fs/promises';
import { settingsStore, dataDirectory, publicUser, problem } from './settings.mjs';
import { join } from 'node:path';
import { createUpdateControl } from './updates.mjs';
import { createUpdateRepair } from './update-repair.mjs';
import { requireSession, sessionUser, requestOrigin, sameOrigin, lanWebUser, login, signOut, issueSession } from './sessions.mjs';
import { initializeIPTV, browserPlay, browserLive, browserCatalog, catalogStatus, refreshCatalog, refreshLive, liveStatus } from './iptv.mjs';
import { saveTMDBCredential } from './tmdb.mjs';
import { getCatalogData } from './platform.mjs';
import { watchProgressStore } from './watch-progress.mjs';
import { createContinueWatching } from './continue-watching.mjs';
import { createLibrary } from './library.mjs';
import { sportsArtworkOrigins } from './sports.mjs';

const activity = [], started = Date.now();
const updates = createUpdateControl(join(dataDirectory, 'updates'));
const repair = createUpdateRepair(join(dataDirectory, 'updates/repair'), { account: id => settingsStore.user(id) });
const nativeStreams = new Map();
const continueWatching = createContinueWatching({ store: watchProgressStore, catalog: getCatalogData });
const library = createLibrary({ catalog: getCatalogData, localCatalog: browserCatalog, history: (user, profile) => watchProgressStore.list(user, profile, { includeCompleted: true }) });
export function recordActivity(event) { if (event.target === '/ui/activity') return; activity.push({ ...event, at: new Date().toISOString() }); if (activity.length > 200) activity.shift(); }
const json = (res, status, data) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw problem(415, 'Send JSON.');
  let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text) > 32768) throw problem(413, 'Request too large.'); }
  try { const data = JSON.parse(text); if (!data || Array.isArray(data) || typeof data !== 'object') throw Error(); return data; } catch { throw problem(400, 'Invalid JSON.'); }
}
function connections(req, user) {
  const address = new URL(requestOrigin(req));
  if (req.watchlocalNetwork?.webPort80) address.port = String(req.watchlocalNetwork.port);
  const base = settingsStore.config().server.publicUrl || address.origin;
  const q = new URLSearchParams({ username: user.username, password: user.password });
  return { server: base, username: user.username, password: user.password, playlist: `${base}/get.php?${q}&type=m3u_plus&output=m3u8`, sports: `${base}/get.php?${q}&type=m3u_plus&output=m3u8&content=live`, guide: `${base}/xmltv.php?${q}`, format: 'HLS / m3u8' };
}
const files = new Map([
  ...[180,192,512].map(size => [`/icon-${size}.png`, [`../public/icon-${size}.png`, 'image/png']]),
  ['/manifest.webmanifest', ['../public/manifest.webmanifest','application/manifest+json']],
  ['/', ['../public/index.html','text/html; charset=utf-8']],
  ['/navigation.mjs', ['../public/navigation.mjs','text/javascript']],
  ['/watch-progress.mjs', ['../public/watch-progress.mjs','text/javascript']],
  ['/mobile-player.mjs', ['../public/mobile-player.mjs','text/javascript']],
  ['/profiles.mjs', ['../public/profiles.mjs','text/javascript']],
  ['/boot.js', ['../public/boot.js','text/javascript']],
  ['/request.mjs', ['../public/request.mjs','text/javascript']],
  ['/playback-recovery.mjs', ['../public/playback-recovery.mjs','text/javascript']],
  ['/preferences.mjs', ['../public/preferences.mjs','text/javascript']],
  ['/home.mjs', ['../public/home.mjs','text/javascript']],
  ['/library.mjs', ['../public/library.mjs','text/javascript']],
  ['/live.mjs', ['../public/live.mjs','text/javascript']],
  ['/live-model.mjs', ['../public/live-model.mjs','text/javascript']],
  ['/updates.mjs', ['../public/updates.mjs','text/javascript']],
  ['/update-repair.mjs', ['../public/update-repair.mjs','text/javascript']],
  ['/app.css', ['../public/app.css','text/css']], ['/app.js', ['../public/app.js','text/javascript']],
  ['/vendor/hls.js', ['../node_modules/hls.js/dist/hls.min.js','text/javascript']],
  ['/favicon.svg', ['../public/favicon.svg','image/svg+xml']],
  ['/brand.svg', ['../public/brand.svg','image/svg+xml']],
]);
export async function handleWeb(req, res) {
  const url = new URL(req.url, 'http://local'), path = url.pathname;
  if (files.has(path) && ['GET','HEAD'].includes(req.method)) {
    const [file, type] = files.get(path);
    try {
      const data = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': `default-src 'self'; img-src 'self' https://image.tmdb.org ${sportsArtworkOrigins.join(' ')} data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'` });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { json(res, 500, { error: 'Web files are missing. Run npm ci and try again.' }); }
    return true;
  }
  if (!path.startsWith('/ui/')) return false;
  try {
    await initializeIPTV();
    if (req.method !== 'GET') sameOrigin(req);
    if (path === '/ui/login' && req.method === 'POST') { const data = await body(req); return json(res, 200, { user: publicUser(login(req, res, data.username, data.password)), setupRequired: false }), true; }
    if (path === '/ui/logout' && req.method === 'POST') { signOut(req,res); return json(res,200,{ok:true}),true; }
    if (path === '/ui/session' && req.method === 'GET') { const user = sessionUser(req); return json(res,200,{ user: user ? publicUser(user) : null, name: settingsStore.config().server.name, lanAccess: Boolean(lanWebUser(req)), setupRequired: false }),true; }
    const repairSession = /^\/ui\/updates\/repair\/([a-f0-9]{32})(\/password)?$/.exec(path);
    if (repairSession) {
      sameOrigin(req);
      const [, id, password] = repairSession, token = req.headers['x-watchlocal-repair'];
      // The read-only, per-job capability survives the app restart; it grants
      // neither an admin login nor permission to start another operation.
      if (req.method === 'GET' && !password) { json(res,200,await repair.status(id,token)); return true; }
      const admin = requireSession(req,true);
      if (req.method === 'POST' && password) { json(res,200,await repair.password(id,token,await body(req),admin)); return true; }
      if (req.method === 'DELETE' && !password) { json(res,200,await repair.cancel(id,token,admin)); return true; }
      throw problem(405,'Unsupported repair action.');
    }
    const user = requireSession(req);
    if (path === '/ui/profiles' && req.method === 'GET') {
      json(res, 200, { profiles: await watchProgressStore.profiles(user.id) }); return true;
    }
    if (path === '/ui/profiles' && req.method === 'POST') {
      json(res, 201, { profile: await watchProgressStore.createProfile(user.id, await body(req)) }); return true;
    }
    if (path === '/ui/progress' && req.method === 'GET') {
      const profileId = url.searchParams.get('profileId');
      json(res, 200, url.searchParams.has('id')
        ? { progress: await watchProgressStore.get(user.id, profileId, Object.fromEntries(url.searchParams)) }
        : { items: await continueWatching(user.id, profileId) });
      return true;
    }
    if (path === '/ui/progress' && req.method === 'POST') {
      const input = await body(req);
      json(res, 200, { progress: await watchProgressStore.save(user.id, input.profileId, input) });
      return true;
    }
    if (path === '/ui/library' && req.method === 'GET') {
      json(res, 200, await library(user.id, url.searchParams.get('profileId'), Object.fromEntries(url.searchParams))); return true;
    }
    if (path === '/ui/browse' && req.method === 'GET') {
      const requestedType = url.searchParams.get('type');
      const type = ['movie','tv','all'].includes(requestedType) ? requestedType : 'movie';
      const query = (url.searchParams.get('q') || '').slice(0,200);
      const page = Math.min(100,Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)));
      const board = url.searchParams.get('board') || 'popular';
      const boards = type === 'all' ? ['trending'] : ['popular','top_rated','trending',type === 'movie' ? 'now_playing' : 'on_the_air'];
      if (!query && !boards.includes(board)) throw problem(400,'Unknown catalog category.');
      const path = query ? '/search/multi' : board === 'trending' ? `/trending/${type}/day` : board === 'top_rated' ? `/curated/${type}/top_rated` : `/${type}/${board}`;
      const data = await getCatalogData(path, { page, ...(query ? { query } : {}) });
      json(res,200,{items:(data.results||[]).filter(i=>!i.adult && (query || type === 'all' ? ['movie','tv'].includes(i.media_type):!i.media_type || i.media_type === type)).map(i=>({...i,type:i.media_type||type})),page,pages:data.total_pages}); return true;
    }
    if (['/ui/title','/ui/episodes'].includes(path) && req.method === 'GET') {
      const id = url.searchParams.get('id'), type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie', season = url.searchParams.get('season') || '1';
      if (!/^[1-9]\d*$/.test(id||'') || !/^\d+$/.test(season)) throw problem(400,'Invalid title or season.');
      json(res,200,await getCatalogData(path === '/ui/episodes' ? `/tv/${id}/season/${season}` : `/${type}/${id}`, path === '/ui/title' ? {append_to_response:'credits'} : {})); return true;
    }
    if (path === '/ui/live' && req.method === 'GET') { json(res,200,{items:await browserLive()}); return true; }
    if (path === '/ui/live/refresh' && req.method === 'POST') { await refreshLive(); json(res,200,{items:await browserLive()}); return true; }
    // A media URL can be assigned and played during the original tap. Resolving
    // inside this request avoids losing iOS user activation to a JSON fetch.
    if (path === '/ui/playback.m3u8' && ['GET','HEAD'].includes(req.method)) {
      sameOrigin(req);
      const input = Object.fromEntries(url.searchParams);
      input.fresh = input.fresh === '1';
      input.exclude = input.exclude ? input.exclude.split(',') : [];
      await watchProgressStore.profile(user.id, input.profileId);
      if (input.requestId && !/^[a-f0-9]{32}$/.test(input.requestId)) throw problem(400, 'Invalid playback request.');
      // Native players may probe the source repeatedly. Reuse the resolved URL
      // for this tap, including fresh-source retries, without caching across users.
      const key = input.requestId ? JSON.stringify([user.id,user.version,requestOrigin(req),url.search]) : null;
      for (const [id, entry] of nativeStreams) if (entry.expires < Date.now()) nativeStreams.delete(id);
      let entry = key && nativeStreams.get(key);
      if (!entry) {
        entry = { expires: Date.now() + 300000, result: browserPlay(req, res, user, input).then(stream => ({ stream }), error => ({ error })) };
        if (key) {
          while (nativeStreams.size >= 128) nativeStreams.delete(nativeStreams.keys().next().value);
          nativeStreams.set(key, entry);
        }
      }
      const { stream, error } = await entry.result;
      if (error) throw error;
      // Native <video> errors hide HTTP response bodies. The UI can ask for the
      // outcome of the same tap without resolving another stream or downloading it.
      if (req.headers.accept === 'application/json') { json(res, 200, { ready: true, ...(stream.attemptedProviders ? { provider: stream.provider, attemptedProviders: stream.attemptedProviders } : {}) }); return true; }
      if (!res.destroyed) { res.writeHead(302, { Location: stream.url, 'Cache-Control': 'no-store' }); res.end(); }
      return true;
    }
    if (path === '/ui/play' && req.method === 'POST') { const input=await body(req);await watchProgressStore.profile(user.id,input.profileId);json(res,200,await browserPlay(req,res,user,input));return true; }
    if (path === '/ui/connections' && req.method === 'GET') {
      const target = url.searchParams.get('user') || user.id;
      if (target !== user.id && user.role !== 'admin') throw problem(403,'You can only view your own connection details.');
      const account = settingsStore.user(target); if (!account) throw problem(404,'User not found.');
      json(res,200,connections(req,account)); return true;
    }
    if (path === '/ui/account' && req.method === 'PUT') {
      const input = await body(req);
      if (!settingsStore.authenticate(user.username,input.currentPassword)) throw problem(403,'Your current password is incorrect.');
      const changed = await settingsStore.upsertUser({username:input.username,password:input.password},user,user.id);
      issueSession(res,changed); json(res,200,{user:publicUser(changed)}); return true;
    }
    requireSession(req,true);
    if (path === '/ui/updates/repair' && req.method === 'GET') { json(res,200,await repair.availability()); return true; }
    if (path === '/ui/updates/repair' && req.method === 'POST') {
      const input = await body(req);
      if (Object.keys(input).length) throw problem(400,'Repair takes no commands or options.');
      json(res,202,await repair.start(user,dataDirectory)); return true;
    }
    if (path === '/ui/updates' && req.method === 'GET') { json(res,200,await updates.status()); return true; }
    if (path === '/ui/updates/check' && req.method === 'POST') { await body(req); json(res,202,await updates.check()); return true; }
    if (path === '/ui/updates/restart' && req.method === 'POST') { await body(req); json(res,202,await updates.restart()); return true; }
    if (path === '/ui/settings' && req.method === 'GET') {
      json(res,200,{config:settingsStore.publicConfig(),users:settingsStore.get().users.map(publicUser),ownerId:settingsStore.get().ownerId,catalog:catalogStatus(),live:liveStatus(),uptime:Math.floor((Date.now()-started)/1000),running:req.watchlocalNetwork||{host:process.env.HOST||req.socket.localAddress,port:req.socket.localPort,webPort:req.socket.localPort,webPort80:false,webError:''}}); return true;
    }
    if (path === '/ui/settings' && req.method === 'PUT') { await settingsStore.configure(await body(req)); json(res,200,{config:settingsStore.publicConfig()}); return true; }
    if (path === '/ui/tmdb' && req.method === 'PUT') { const input = await body(req); await saveTMDBCredential(input.credential); json(res,200,{configured:true}); return true; }
    if (path === '/ui/tmdb' && req.method === 'DELETE') { await settingsStore.setTMDBCredential(''); json(res,200,{configured:false}); return true; }
    if (path === '/ui/users' && req.method === 'POST') { const added = await settingsStore.upsertUser(await body(req),user); json(res,201,{user:publicUser(added)}); return true; }
    if (/^\/ui\/users\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1);
      if (req.method === 'PUT') { const changed=await settingsStore.upsertUser(await body(req),user,id); if(changed.id===user.id)issueSession(res,changed); json(res,200,{user:publicUser(changed)}); return true; }
      if (req.method === 'DELETE') { await settingsStore.removeUser(id,user); json(res,200,{ok:true}); return true; }
    }
    if (path === '/ui/refresh' && req.method === 'POST') { refreshCatalog().catch(e=>console.warn('Catalog refresh:',e.message)); json(res,202,{refreshing:true}); return true; }
    if (path === '/ui/activity' && req.method === 'GET') { json(res,200,{items:[...activity].reverse()}); return true; }
    throw problem(404,'Not found.');
  } catch(e) { json(res,e.status||502,{error:e.message}); }
  return true;
}
