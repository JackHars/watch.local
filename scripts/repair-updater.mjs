// Fixed, sudo-authorized repair. The transient service lives outside the app's
// cgroup and checkout, so stopping the app or updating Git cannot kill it.
import { cp, mkdir, mkdtemp, readFile, realpath, stat, rm, chmod } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { installUpdater } from './install-updater.mjs';
import { command, writeJSON } from './update-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
export function transientRepairCommand(directory, id, node = process.execPath) {
  // systemd expands dollars in ExecStart arguments, even without a shell.
  const literal = value => value.replaceAll('$', () => '$$');
  return ['/usr/bin/systemd-run', ['--quiet', `--unit=watchlocal-repair-${id}`, '--collect', '--service-type=exec',
    '--property=RuntimeMaxSec=25min', '--property=UMask=0077', '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null',
    literal(node), literal(join(directory, 'repair-updater.mjs')), '--run', literal(directory)]];
}

export async function validateRepairJob(directory, { run = command, sudoUid = process.env.SUDO_UID } = {}) {
  if (!/^[a-f0-9]{32}$/.test(basename(directory)) || await realpath(directory) !== directory) throw Error('Invalid repair session.');
  const file = join(directory, 'job.json');
  if (await realpath(file) !== file) throw Error('Invalid repair session.');
  const info = await stat(file), job = await readJSON(file);
  if (info.uid !== Number(sudoUid) || !info.uid || info.mode & 0o077 || job.uid !== info.uid || job.id !== basename(directory) || job.expires < Date.now()) throw Error('Repair session ownership or expiry is invalid.');
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(job.service || '') || job.service === 'watchlocal-update.service') throw Error('Invalid application service.');
  for (const path of [job.repo, job.data]) {
    if (typeof path !== 'string' || /[\r\n,%]/.test(path) || await realpath(path) !== path || (await stat(path)).uid !== info.uid) throw Error('Repair paths must belong to the application user.');
  }
  if (directory !== join(job.data, 'updates', 'repair', job.id)) throw Error('Repair session is outside the application data directory.');
  const unit = await run('/usr/bin/systemctl', ['show', job.service, '--property=LoadState,User,WorkingDirectory']);
  const fields = Object.fromEntries(unit.split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (fields.LoadState !== 'loaded' || await realpath(fields.WorkingDirectory || '/') !== job.repo) throw Error('The system service does not run this checkout.');
  const owner = (await run('/usr/bin/getent', ['passwd', fields.User])).split(':');
  if (Number(owner[2]) !== info.uid || !/^[a-zA-Z_][a-zA-Z0-9_-]*\$?$/.test(owner[0])) throw Error('The system service must run as the user authorizing sudo.');
  return { ...job, username: owner[0], gid: Number(owner[3]), home: owner[5], directory };
}

// Root never writes through a path controlled by the web application. Reports
// are written by a subprocess with the application user's normal privileges.
export async function reportAsOwner(directory, job, status, { execute = execFile, node = process.execPath } = {}) {
  await new Promise((resolve, reject) => {
    const child = execute('/usr/sbin/runuser', ['-u', job.username, '--', node, join(directory, 'repair-updater.mjs'), '--report', job.directory], {
      timeout: 10_000, maxBuffer: 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: job.home },
    }, error => error ? reject(Error('Could not report repair progress.')) : resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(status));
  });
}

export async function launchRepair(directory, { run = command, root = '/run', report = reportAsOwner } = {}) {
  const job = await validateRepairJob(directory, { run });
  const snapshot = await mkdtemp(join(root, 'watchlocal-repair-'));
  try {
    // Files are root-owned but readable by the app user for --report. The
    // manifest is root-only. No password or capability token enters the unit.
    await chmod(snapshot, 0o755);
    for (const name of ['repair-updater.mjs', 'install-updater.mjs', 'update-runner.mjs']) {
      await cp(join(here, name), join(snapshot, name)); await chmod(join(snapshot, name), 0o644);
    }
    const { tokenHash, userId, userVersion, ...workerJob } = job;
    await writeJSON(join(snapshot, 'job.json'), workerJob);
    await report(snapshot, job, { state: 'running', waitingForPassword: false, username: job.username, message: 'Sudo accepted. Starting the independent repair service…', output: 'Sudo accepted.\n', updatedAt: Date.now() });
    const [file, args] = transientRepairCommand(snapshot, job.id);
    await run(file, args, { label: 'Starting the independent repair service' });
  } catch (error) {
    await report(snapshot, job, { state: 'error', waitingForPassword: false, message: error.message, output: 'Repair could not start.\n', updatedAt: Date.now() }).catch(() => {});
    await rm(snapshot, { recursive: true, force: true }); throw error;
  }
}

export async function runRepair(directory, { run = command, install = installUpdater, report = reportAsOwner, fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const job = await readJSON(join(directory, 'job.json'));
  let lines = [], lastMessage, pending = Promise.resolve(), polling, observing = false, stoppedTimer = false, stoppedUserTimer = false;
  const userManager = (...args) => run('/usr/sbin/runuser', ['-u', job.username, '--', 'env', `XDG_RUNTIME_DIR=/run/user/${job.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${job.uid}/bus`, 'systemctl', '--user', ...args]);
  function progress(message, state = 'running') {
    if (message === lastMessage && state === 'running') return pending;
    lastMessage = message; lines.push(message); lines = lines.slice(-80);
    const status = { state, waitingForPassword: false, username: job.username, message, output: lines.join('\n') + '\n', updatedAt: Date.now() };
    pending = pending.catch(() => {}).then(() => report(directory, job, status)); return pending;
  }
  try {
    await progress('Checking the boot service and existing updater…');
    const active = await run('/usr/bin/systemctl', ['show', 'watchlocal-update.service', '--property=ActiveState', '--value']);
    if (['active', 'activating', 'deactivating'].includes(active)) throw Error('An update is already running. Wait for it to finish, then retry repair.');
    const timer = await run('/usr/bin/systemctl', ['show', 'watchlocal-update.timer', '--property=ActiveState', '--value']);
    if (timer === 'active') { await run('/usr/bin/systemctl', ['stop', 'watchlocal-update.timer']); stoppedTimer = true; }
    // Pause an old user timer before the shared lock check. The installer
    // retires it after validation; a failed preflight restores the old timer.
    try {
      if (await userManager('is-active', 'watchlocal-update.timer') === 'active') {
        await userManager('stop', 'watchlocal-update.timer'); stoppedUserTimer = true;
      }
    } catch {}
    await progress('Installing the boot update timer and app restart permission…');
    const trackedRun = async (file, args, options) => {
      if (file.endsWith('systemctl') && args[0] === 'stop' && args[1] === job.service) await progress('Restarting watch.local to enable automatic updates. The browser will reconnect…');
      if (file.endsWith('systemctl') && args[0] === 'start' && args[1] === 'watchlocal-update.service') {
        await progress('Checking main, GitHub checks and dependencies with the updater…');
        observing = true;
        polling = setInterval(async () => {
          try {
            const status = await readJSON(join(job.data, 'updates/status.json'));
            if (observing && status.message) await progress(status.message);
          } catch { /* Status may be atomically replaced during an update. */ }
        }, 2000);
      }
      return run(file, args, options);
    };
    await install({ 'system-service': job.service, repo: job.repo, data: job.data, enable: true }, { run: trackedRun, log: () => {} });
    observing = false; clearInterval(polling); await pending;
    const config = await readJSON(join(job.home, '.local/state/watchlocal-updater/host-config.json'));
    const revision = await run('/usr/sbin/runuser', ['-u', job.username, '--', 'git', '-C', job.repo, 'rev-parse', 'HEAD']);
    let healthy = false;
    for (let attempt = 0; attempt < 15 && !healthy; attempt++) {
      try {
        healthy = (await Promise.all(config.healthUrls.map(async url => {
          const health = await fetcher(url, { signal: AbortSignal.timeout(4000), redirect: 'error' }).then(response => response.json());
          return health.ok && health.application === 'watchlocal' && health.revision === revision;
        }))).every(Boolean);
      } catch { healthy = false; }
      if (!healthy) await pause(2000);
    }
    if (!healthy) throw Error('The updater was installed, but watch.local has not restarted successfully. Check the app service.');
    if (await run('/usr/bin/systemctl', ['is-active', 'watchlocal-update.timer']) !== 'active') throw Error('The update timer is not running. Check the host update service.');
    const status = await readJSON(join(job.data, 'updates/status.json'));
    if (['error', 'checks_failed', 'rolled_back', 'recovery_needed'].includes(status.state)) throw Error(status.message || 'The updater needs attention. Check Updates for details.');
    await progress('Repair complete. Automatic updates are enabled and the boot timer is running.' + (status.state === 'waiting_checks' ? ' The next update will wait for GitHub checks to pass.' : ''), 'complete');
  } catch (error) {
    observing = false; clearInterval(polling);
    if (stoppedTimer) await run('/usr/bin/systemctl', ['start', 'watchlocal-update.timer']).catch(() => {});
    if (stoppedUserTimer) await userManager('start', 'watchlocal-update.timer').catch(() => {});
    await progress(error.message, 'error');
  } finally { observing = false; clearInterval(polling); await pending.catch(() => {}); }
}

async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (process.argv.length !== 4 || !directory?.startsWith('/')) throw Error('Invalid repair command.');
  if (mode === '--report') {
    if (!process.getuid()) throw Error('Progress must be written as the application user.');
    let input = ''; for await (const part of process.stdin) { input += part; if (input.length > 32_768) throw Error('Report too large.'); }
    const value = JSON.parse(input);
    await writeJSON(join(directory, 'status.json'), value); return;
  }
  if (process.getuid() !== 0) throw Error('Repair requires sudo authorization.');
  if (mode === '--launch') return launchRepair(directory);
  if (mode !== '--run' || !basename(directory).startsWith('watchlocal-repair-') || (await stat(directory)).uid !== 0) throw Error('Invalid repair service.');
  try { await runRepair(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Repair could not complete. Check the browser repair status.'); process.exitCode = 1; });
}
