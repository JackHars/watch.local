import { cp, mkdir, readFile, realpath, writeFile, stat, chown, chmod, rename, access, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, githubRepository, writeJSON, validateService } from './update-runner.mjs';

export const usage = `Install the Linux host updater:
  node scripts/install-updater.mjs --compose /absolute/path/compose.yaml [--data /private/data]
  node scripts/install-updater.mjs --service watchlocal.service [--data /private/data]
  sudo node scripts/install-updater.mjs --system-service watchlocal.service --enable
Options: --repo PATH --state PATH --services watchlocal,discovery --health-urls URL,URL
--service controls a user service; --system-service controls a system boot service.
--enable turns on automatic updates and restarts the app once after installation.
Otherwise, enable automatic updates in Settings → Updates.`;

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--enable') { options.enable = true; continue; }
    if (!['--compose','--service','--system-service','--repo','--data','--state','--services','--health-urls'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error(usage);
    options[args[i].slice(2)] = args[++i];
  }
  if ([options.compose, options.service, options['system-service']].filter(Boolean).length !== 1) throw new Error(usage);
  return options;
}
const quote = text => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const properties = text => Object.fromEntries(text.split('\n').map(line => { const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1)]; }));
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export async function installUpdater(options, { run = command, uid = process.getuid?.(), home = homedir(), env = process.env,
  node = process.execPath, systemRoot = '/', log = console.log } = {}) {
  if (process.platform !== 'linux') throw new Error('The host updater requires Linux and systemd.');
  if (Number(process.versions.node.split('.')[0]) < (options.compose ? 22 : 24)) throw new Error(options.compose ? 'The host updater needs Node 22 or newer.' : 'Native installations need Node 24 or newer.');
  const system = Boolean(options['system-service']), service = options['system-service'] || options.service;
  if (system && uid !== 0) throw new Error('Run --system-service with sudo so it can install a boot timer and permission to restart only the app service.');
  if (!system && uid === 0) throw new Error('Run the user/Compose installer as the checkout owner, or use --system-service for a system boot service.');
  if (service && (!/^[A-Za-z0-9_.@-]+\.service$/.test(service) || service === 'watchlocal-update.service')) throw new Error('Specify the app service name ending in .service.');
  const repo = await realpath(options.repo || fileURLToPath(new URL('..', import.meta.url)));
  const systemctl = system ? await realpath(join(systemRoot, 'usr/bin/systemctl')) : 'systemctl';
  let owner = { name: userInfo().username, uid, gid: process.getgid?.(), home };
  if (system) {
    const unit = properties(await run(systemctl, ['show', service, '--property=LoadState,User,WorkingDirectory']));
    if (unit.LoadState !== 'loaded') throw new Error(`System service ${service} was not found. Use the name of the service that starts watch.local.`);
    const user = unit.User;
    if (!user || user === 'root') throw new Error('The app service must specify a non-root User. Run the app as the owner of its checkout.');
    const account = (await run('getent', ['passwd', user])).split(':');
    owner = { name: account[0], uid: Number(account[2]), gid: Number(account[3]), home: account[5] };
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*\$?$/.test(owner.name) || !Number.isInteger(owner.uid) || owner.uid <= 0 || !Number.isInteger(owner.gid) || !owner.home?.startsWith('/')) throw new Error('Could not identify the app service account.');
    if ((await stat(repo)).uid !== owner.uid) throw new Error('The checkout must be owned by the app service user. Use that user’s checkout with --repo.');
  }
  const asOwner = (file, args, settings) => system ? run('runuser', ['-u', owner.name, '--', file, ...args], settings) : run(file, args, settings);
  const data = await realpath(options.data || join(repo, 'data'));
  await asOwner('test', ['-r', join(data, 'iptv.json')]);
  await asOwner('test', ['-w', data]);
  const state = resolve(options.state || join(system ? owner.home : env.XDG_STATE_HOME || join(home, '.local/state'), system ? '.local/state/watchlocal-updater' : 'watchlocal-updater'));
  if ([repo, data].some(path => state === path || state.startsWith(path + '/'))) throw new Error('Keep updater state outside the checkout and application data.');
  if ([repo,data,state,options.compose || ''].some(path => /[\r\n,]/.test(path))) throw new Error('Paths must not contain commas or newlines.');
  const git = (...args) => asOwner('git', ['-C', repo, ...args]);
  if (await git('symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('Switch this checkout to main before installing automatic updates.');
  if (await git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit or move local changes before installing automatic updates.');
  const remote = await git('remote', 'get-url', 'origin'); githubRepository(remote);
  const stored = JSON.parse(await readFile(join(data, 'iptv.json'), 'utf8'));
  const server = stored.config?.server || {};
  const ports = [...new Set([server.port || 8091, ...(server.webPort80 ? [80] : [])])];
  const healthUrls = options['health-urls']?.split(',') || ports.map(port => `http://127.0.0.1:${port}/health`);
  for (const value of healthUrls) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/health' || url.search || url.hash) throw new Error('Health URLs must point to the local server’s /health endpoint.');
  }
  const services = (options.services || 'watchlocal,discovery').split(',');
  if (services.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Invalid Compose service name.');
  const config = { repo, data, state, remote, healthUrls, ...(options.compose ? { compose: await realpath(options.compose), services }
    : { service, serviceScope: system ? 'system' : 'user', ...(system ? { systemctl } : {}) }) };
  await asOwner('flock', ['--version']);
  if (config.compose) {
    const definition = JSON.parse(await asOwner('docker', ['compose', '-f', config.compose, 'config', '--format', 'json']));
    if (services.some(name => !definition.services[name])) throw new Error('One of the requested Compose services does not exist.');
  } else await validateService(config, run);
  if (!system) await run('systemctl', ['--user', 'show-environment']);
  const journal = join(state, 'transaction.json');
  let cancelPreparation = false;
  if (await exists(journal)) {
    const transaction = JSON.parse(await readFile(journal, 'utf8'));
    // A wrong service manager can leave a journal before stop() ever succeeds.
    // In this phase no code, dependencies or live data have been replaced.
    cancelPreparation = options.enable && transaction.phase === 'prepared' && /^[a-f0-9]{40}$/.test(transaction.previous || '') && /^[a-f0-9]{40}$/.test(transaction.target || '');
    if (!cancelPreparation) throw new Error('An update needs recovery. Preserve its backup and recover the existing transaction before reinstalling the updater.');
  }
  if (system && !options.state) await asOwner('mkdir', ['-p', '-m', '700', state]);
  await mkdir(state, { recursive: true, mode: 0o700 });
  if (system) { await chown(state, owner.uid, owner.gid); await chmod(state, 0o700); }
  await asOwner('flock', ['-n', join(state, 'update.lock'), 'true']);
  if (cancelPreparation) await rm(journal);
  const configFile = join(state, 'host-config.json'), runnerFile = join(state, 'runner.mjs');
  await writeJSON(configFile, config);
  await cp(new URL('./update-runner.mjs', import.meta.url), runnerFile);
  if (system) {
    for (const file of [configFile, runnerFile]) { await chown(file, owner.uid, owner.gid); await chmod(file, 0o600); }
    const policyDirectory = join(systemRoot, 'etc/sudoers.d'); await mkdir(policyDirectory, { recursive: true });
    const temporary = join(policyDirectory, '.watchlocal-updater.tmp');
    await writeFile(temporary, `${owner.name} ALL=(root) NOPASSWD: ${systemctl} stop ${service}, ${systemctl} start ${service}\n`, { mode: 0o440 });
    await run('visudo', ['-cf', temporary]);
    await rename(temporary, join(policyDirectory, 'watchlocal-updater'));
    for (const action of ['stop','start']) await asOwner('sudo', ['-n','-l',systemctl,action,service]);
    // Retire an older user timer if that manager is online. Both generations
    // share the same state/lock, so an offline legacy timer cannot race updates.
    try { await asOwner('env', [`XDG_RUNTIME_DIR=/run/user/${owner.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${owner.uid}/bus`, 'systemctl','--user','disable','--now','watchlocal-update.timer']); } catch { /* no user manager or no old timer */ }
  }
  const unitDirectory = system ? join(systemRoot, 'etc/systemd/system') : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user');
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(join(unitDirectory, 'watchlocal-update.service'), `[Unit]
Description=Check and safely update watch.local from main
${system ? 'Wants=network-online.target\nAfter=network-online.target\n' : ''}
[Service]
Type=oneshot
${system ? `User=${owner.name}\nEnvironment=${quote('HOME=' + owner.home)}\n` : ''}UMask=0077
TimeoutStartSec=20min
Environment=${quote('PATH=' + dirname(node) + ':/usr/local/bin:/usr/bin:/bin')}
ExecStart=${quote(node)} ${quote(runnerFile)} ${quote(configFile)}
`, { mode: system ? 0o644 : 0o600 });
  await writeFile(join(unitDirectory, 'watchlocal-update.timer'), `[Unit]
Description=Check watch.local update settings every minute

[Timer]
${system ? 'OnBootSec' : 'OnStartupSec'}=30s
OnUnitInactiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
`, { mode: system ? 0o644 : 0o600 });
  const manager = (...args) => run(systemctl, [...(system ? [] : ['--user']), ...args]);
  await manager('daemon-reload');
  if (options.enable) {
    const control = action => config.compose ? asOwner('docker', ['compose','-f',config.compose,action === 'start' ? 'up' : 'stop', ...(action === 'start' ? ['-d'] : []), ...services]) : manager(action, service);
    await control('stop');
    try {
      // Read after stopping so a final application write cannot overwrite the setting.
      const current = JSON.parse(await readFile(join(data, 'iptv.json'), 'utf8'));
      current.config ||= {}; current.config.updates = { intervalMinutes: 5, ...current.config.updates, enabled: true };
      await writeJSON(join(data, 'iptv.json'), current);
      if (system) await chown(join(data, 'iptv.json'), owner.uid, owner.gid);
    } finally { await control('start'); }
  }
  await manager('enable', '--now', 'watchlocal-update.timer');
  // Always check immediately after a repair, even if the previous agent left a
  // recent check time or an error while using the wrong service manager.
  await asOwner('mkdir', ['-p', '-m', '700', join(data, 'updates')]);
  const request = join(data, 'updates/request.json');
  await writeJSON(request, { id: randomUUID(), action: 'check', at: Date.now() });
  if (system) await chown(request, owner.uid, owner.gid);
  await run(systemctl, [...(system ? [] : ['--user']), 'start', 'watchlocal-update.service'], { timeout: 1_200_000 });
  log(`Update service installed${options.enable ? ' and automatic updates enabled' : '. Enable automatic updates in Settings → Updates'}.`);
  if (!system) {
    const linger = await run('loginctl', ['show-user', owner.name, '--property=Linger', '--value']);
    if (linger !== 'yes') log(`To keep checks running after logout and reboot: sudo loginctl enable-linger ${owner.name}`);
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log(usage);
  else installUpdater(parseOptions(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
