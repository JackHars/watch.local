import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { listenServers } from './listeners.mjs';
import { initializeEngine } from './api/platform.mjs';
import { initializeIPTV, setIPTVCredentials, warmIPTV } from './api/iptv.mjs';
import { promptForLogin } from './api/login-tui.mjs';
import { settingsStore, dataDirectory } from './api/settings.mjs';
import { createDashboard } from './api/dashboard.mjs';
import { startDiscovery } from './discovery-runtime.mjs';

let config = {};
try { config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let existingLogin = null;
try { existingLogin = JSON.parse(await readFile(join(dataDirectory, 'iptv.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let newLogin = null;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
if (interactive) {
  try { newLogin = await promptForLogin({ firstRun: !existingLogin, current: existingLogin }); }
  catch (error) { console.error(error.message); process.exit(1); }
} else if (!existingLogin) {
  console.error('IPTV login setup needs an interactive terminal. Run npm start in a terminal first.');
  process.exit(1);
}

await settingsStore.initialize(config);
await initializeIPTV(config.iptv);
if (newLogin) {
  await setIPTVCredentials(newLogin.username, newLogin.password);
  console.log('IPTV login saved.');
}
await initializeEngine();
const port = Number(process.env.PORT || settingsStore.config().server.port);
const host = process.env.HOST || settingsStore.config().server.host;
const login = newLogin || existingLogin;
const dashboard = createDashboard({ password: login.password });
let listeners;
try { listeners = await listenServers({ host, port, webPort80: settingsStore.config().server.webPort80, onRequest: dashboard.logRequest }); }
catch (error) { console.error(error.message); process.exit(1); }
for (const server of listeners.servers) server.on('error', error => { dashboard.stop(); console.error(error.message); process.exit(1); });
let stopping = false;
let discovery;
function shutdown() {
  if (stopping) return;
  stopping = true;
  dashboard.stop();
  Promise.all([listeners.close(), discovery?.close()]).then(() => process.exit(0));
  setTimeout(() => { listeners.closeAllConnections(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => dashboard.stop());
{
  const actualPort = listeners.network.port;
  const lanAddresses = Object.values(networkInterfaces()).flatMap(addresses => addresses || [])
    .filter(address => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'));
  const address = ['127.0.0.1', 'localhost'].includes(host) ? '127.0.0.1'
    : host !== '0.0.0.0' ? host : lanAddresses[0]?.address || '127.0.0.1';
  const base = new URL(`http://${address.includes(':') ? `[${address}]` : address}:${actualPort}`).origin;
  const web = new URL(base); web.port = String(listeners.network.webPort);
  const makeDetails = () => {
    const login = settingsStore.user(settingsStore.get().ownerId);
    const query = new URLSearchParams({ username: login.username, password: login.password });
    const advertised = settingsStore.config().server.publicUrl || base;
    return {
      server: listeners.network.discovery?.url || web.origin,
      xtreamServer: advertised,
      username: login.username,
      password: login.password,
      playlist: `${advertised}/get.php?${query}&type=m3u_plus&output=m3u8`,
      sportsPlaylist: `${advertised}/get.php?${query}&type=m3u_plus&output=m3u8&content=live`,
      epg: `${advertised}/xmltv.php?${query}`,
    };
  };
  if (interactive) {
    dashboard.start(makeDetails());
    settingsStore.events.on('change', () => dashboard.update(makeDetails()));
  } else { console.log(`Web interface: ${web.origin}`); console.log(`IPTV server: ${base}`); }
  if (listeners.network.webError) console.warn(listeners.network.webError);
  discovery = startDiscovery({ settings: settingsStore, network: listeners.network, onChange(status) {
    if (interactive) dashboard.update(makeDetails());
    if (status.url) console.log(`Local discovery: ${status.url}`);
    else if (status.state === 'unavailable') console.warn(`Local discovery: ${status.message}`);
  } });
  warmIPTV();
}
