import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { command, githubRepository, writeJSON } from './update-runner.mjs';

const usage = `Install the Linux host update service (run as the owner of the checkout):
  node scripts/install-updater.mjs --compose /absolute/path/compose.yaml [--data /private/data]
  node scripts/install-updater.mjs --service watchlocal.service [--data /private/data]
Options: --repo PATH --state PATH --services watchlocal,discovery --health-urls URL,URL
After installation, enable automatic updates in Settings → Updates.`;
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--compose','--service','--repo','--data','--state','--services','--health-urls'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error(usage);
  options[args[i].slice(2)] = args[i+1];
}
if (process.platform !== 'linux' || Boolean(options.compose) === Boolean(options.service)) throw new Error(usage);
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('The host updater needs Node 22 or newer.');
const repo = await realpath(options.repo || fileURLToPath(new URL('..', import.meta.url)));
const data = await realpath(options.data || join(repo, 'data'));
const state = resolve(options.state || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'watchlocal-updater'));
if ([repo, data].some(path => state === path || state.startsWith(path + '/'))) throw new Error('Keep the updater state directory outside the checkout and application data.');
if ([repo,data,state,options.compose || ''].some(path => /[\r\n,]/.test(path))) throw new Error('Paths must not contain commas or newlines.');
const git = (...args) => command('git', ['-C', repo, ...args]);
if (await git('symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('Switch this checkout to main before installing automatic updates.');
if (await git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit or move local changes before installing automatic updates.');
const remote = await git('remote', 'get-url', 'origin'); githubRepository(remote);
const stored = JSON.parse(await readFile(join(data, 'iptv.json'), 'utf8'));
const server = stored.config?.server || {};
const ports = [...new Set([server.port || 8091, ...(server.webPort80 ? [80] : [])])];
const healthUrls = options['health-urls']?.split(',') || ports.map(port => `http://127.0.0.1:${port}/health`);
for (const value of healthUrls) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/health') throw new Error('Health URLs must point to the local server’s /health endpoint.');
}
if (options.service && !/^[A-Za-z0-9_.@-]+\.service$/.test(options.service)) throw new Error('Specify a user systemd service name ending in .service.');
if (options.service === 'watchlocal-update.service') throw new Error('Choose the app service, not the updater itself.');
if (options.service && Number(process.versions.node.split('.')[0]) < 24) throw new Error('Native installations need Node 24 or newer.');
const services = (options.services || 'watchlocal,discovery').split(',');
if (services.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Invalid Compose service name.');
const config = { repo, data, state, remote, healthUrls, ...(options.compose ? { compose: await realpath(options.compose), services } : { service: options.service }) };
await command('flock', ['--version']);
await command('systemctl', ['--user', 'show-environment']);
if (config.compose) {
  const definition = JSON.parse(await command('docker', ['compose', '-f', config.compose, 'config', '--format', 'json']));
  if (services.some(name => !definition.services[name])) throw new Error('One of the requested Compose services does not exist.');
}
await mkdir(state, { recursive: true, mode: 0o700 });
await writeJSON(join(state, 'host-config.json'), config);
await cp(new URL('./update-runner.mjs', import.meta.url), join(state, 'runner.mjs'));
const unitDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
await mkdir(unitDirectory, { recursive: true });
const quote = text => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
await writeFile(join(unitDirectory, 'watchlocal-update.service'), `[Unit]
Description=Check and safely update watch.local from main

[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=20min
Environment=${quote('PATH=' + dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin')}
ExecStart=${quote(process.execPath)} ${quote(join(state, 'runner.mjs'))} ${quote(join(state, 'host-config.json'))}
`, { mode: 0o600 });
await writeFile(join(unitDirectory, 'watchlocal-update.timer'), `[Unit]
Description=Check watch.local update settings every minute

[Timer]
OnStartupSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
`, { mode: 0o600 });
await command('systemctl', ['--user', 'daemon-reload']);
await command('systemctl', ['--user', 'enable', '--now', 'watchlocal-update.timer']);
await command('systemctl', ['--user', 'start', 'watchlocal-update.service'], { timeout: 1_200_000 });
console.log('Update service installed. Enable automatic updates in Settings → Updates.');
const linger = await command('loginctl', ['show-user', userInfo().username, '--property=Linger', '--value']);
if (linger !== 'yes') console.log(`To keep checks running after logout and reboot: sudo loginctl enable-linger ${userInfo().username}`);
