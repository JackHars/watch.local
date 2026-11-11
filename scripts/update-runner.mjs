// Self-contained: the installer keeps this runner outside the checkout so it can
// recover an interrupted update even when the application cannot start.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, cp, readdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export async function command(file, args, { label = file, ...options } = {}) {
  try {
    const result = await execute(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
    return result.stdout.trim();
  } catch { throw new Error(`${label} failed. Check the host service and try again.`); }
}
async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJSON(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
const exists = async path => { try { await access(path); return true; } catch { return false; } };
export function githubRepository(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error('Automatic updates require a GitHub origin without credentials in its URL.');
  return match[1];
}
export async function githubChecks(repository, sha, fetcher = fetch) {
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/checks.yml/runs`);
  url.search = new URLSearchParams({ branch: 'main', event: 'push', head_sha: sha, per_page: '10' });
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'watchlocal-updater', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('GitHub checks are unavailable. The installed version has been kept; the updater will try again.');
  const data = await response.json();
  const run = (data.workflow_runs || []).filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'passed' : 'failed';
}

export function createUpdater(config, { run = command, fetcher = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = githubChecks, adapter } = {}) {
  const { repo, data, state: directory } = config;
  const stage = join(directory, 'candidate'), backup = join(directory, 'backup');
  const journalFile = join(directory, 'transaction.json'), statusFile = join(data, 'updates/status.json');
  const git = (...args) => run('git', ['-C', repo, ...args], { label: 'Git' });
  const compose = (...args) => run('docker', ['compose', '-f', config.compose, ...args], { label: 'Docker Compose', timeout: 180_000 });
  const services = config.services || ['watchlocal', 'discovery'];
  const runtime = adapter || {
    async prepare(path) {
      if (config.compose) {
        const definition = JSON.parse(await compose('config', '--format', 'json'));
        const image = definition.services[services[0]]?.image;
        if (!image) throw new Error('The main Compose service must specify a Node 24 image.');
        await run('docker', ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
          '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,source=${path},target=/app`,
          '--workdir', '/app', '--tmpfs', '/tmp:rw,size=256m,mode=1777', '-e', 'npm_config_cache=/tmp/npm', image,
          'sh', '-c', 'npm ci --ignore-scripts --no-audit --no-fund && npm run check'], { label: 'Candidate dependency and syntax checks', timeout: 600_000 });
      } else {
        await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path, timeout: 600_000, label: 'Candidate dependencies' });
        await run('npm', ['run', 'check'], { cwd: path, label: 'Candidate syntax checks' });
      }
      await access(join(path, 'scripts/update-runner.mjs'));
    },
    async stop() {
      if (config.compose) await compose('stop', ...services);
      else await run('systemctl', ['--user', 'stop', config.service], { label: 'Stopping watch.local' });
    },
    async start() {
      // Recreate bind mounts, including discovery's individual files and modules.
      if (config.compose) await compose('up', '-d', '--force-recreate', ...services);
      else await run('systemctl', ['--user', 'start', config.service], { label: 'Starting watch.local' });
    },
    async healthy() {
      for (const url of config.healthUrls) {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
          const body = response.ok && await response.json();
          if (!body || body.application !== 'watchlocal' || body.ok !== true) return false;
        } catch { return false; }
      }
      return true;
    },
  };
  let status;
  const report = async patch => {
    status = { ...status, ...patch, version: 1, heartbeat: now() };
    await writeJSON(statusFile, status);
    return status;
  };
  async function healthy() {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await runtime.healthy()) return;
      await sleep(2000);
    }
    throw new Error('The updated server did not become healthy.');
  }
  async function cleanMain() {
    if (await git('symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('Updates are paused because this checkout is not on main.');
    if (await git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Updates are paused because the checkout has local changes. Commit or move those changes first.');
    if (await git('remote', 'get-url', 'origin') !== config.remote) throw new Error('The origin remote changed. Reinstall the update service to use the new repository.');
  }
  async function rollback(transaction) {
    await report({ state: 'rolling_back', message: 'Restoring the previous version.' });
    const head = await git('rev-parse', 'HEAD');
    if (![transaction.previous, transaction.target].includes(head)) throw new Error('Recovery stopped because the checkout changed outside the updater.');
    if (transaction.phase !== 'prepared' && await git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Recovery stopped to preserve local changes made during the update.');
    await runtime.stop();
    if (transaction.phase !== 'prepared') {
      // A transaction is written before changes begin; only that transaction may reset.
      await git('reset', '--hard', transaction.previous);
      if (await exists(join(backup, 'node_modules'))) {
        await rm(join(repo, 'node_modules'), { recursive: true, force: true });
        await rename(join(backup, 'node_modules'), join(repo, 'node_modules'));
      }
      for (const entry of await readdir(data)) if (entry !== 'updates') await rm(join(data, entry), { recursive: true, force: true });
      await cp(join(backup, 'data'), data, { recursive: true });
    }
    await runtime.start();
    await healthy();
    await report({ state: 'rolled_back', current: transaction.previous, failedCommit: transaction.target,
      message: 'The update failed. The previous version and private data were restored. This commit will not be installed again.' });
    await rm(journalFile, { force: true });
  }
  async function apply(previous, target) {
    await rm(stage, { recursive: true, force: true });
    await run('git', ['clone', '--shared', '--no-checkout', repo, stage], { label: 'Preparing update checkout' });
    await run('git', ['-C', stage, 'checkout', '--detach', target], { label: 'Preparing update revision' });
    await report({ state: 'preparing', message: 'Checking dependencies before installing the update.' });
    await runtime.prepare(stage);
    await cleanMain();
    if (await git('rev-parse', 'HEAD') !== previous) throw new Error('The installed revision changed while the update was being prepared.');
    const settings = await readJSON(join(data, 'iptv.json'));
    if (!settings.config?.updates?.enabled) return report({ state: 'available', message: 'An update is available. Automatic updates are turned off.' });
    await rm(backup, { recursive: true, force: true });
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const transaction = { previous, target, phase: 'prepared' };
    await writeJSON(journalFile, transaction);
    try {
      await report({ state: 'installing', message: 'Installing the update. The server will restart briefly.' });
      await runtime.stop();
      await cp(data, join(backup, 'data'), { recursive: true, filter: source => source !== join(data, 'updates') });
      transaction.phase = 'backed_up'; await writeJSON(journalFile, transaction);
      await git('merge', '--ff-only', target);
      if (await exists(join(repo, 'node_modules'))) await rename(join(repo, 'node_modules'), join(backup, 'node_modules'));
      await rename(join(stage, 'node_modules'), join(repo, 'node_modules'));
      await runtime.start();
      await healthy();
      // Keep a recovery copy of the runner outside the repository, too.
      await cp(join(repo, 'scripts/update-runner.mjs'), join(directory, 'runner.mjs.tmp'));
      await rename(join(directory, 'runner.mjs.tmp'), join(directory, 'runner.mjs'));
      await report({ state: 'updated', current: target, lastUpdated: now(), failedCommit: '', message: 'The latest update is installed and the server is healthy.' });
      await rm(journalFile, { force: true });
    } catch {
      await rollback(transaction);
    }
  }
  return {
    async tick() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      status = await readJSON(statusFile, {});
      try {
        const transaction = await readJSON(journalFile, null);
        if (transaction) { await rollback(transaction); return status; }
        const settings = (await readJSON(join(data, 'iptv.json'))).config?.updates || {};
        const enabled = settings.enabled === true;
        const interval = Math.min(1440, Math.max(5, settings.intervalMinutes || 5)) * 60_000;
        const request = await readJSON(join(data, 'updates/request.json'), {});
        const manual = Boolean(request.id && request.id !== status.requestId);
        const due = manual || (enabled && (!status.enabled || !status.lastChecked || now() >= status.lastChecked + interval));
        await report({ enabled, current: await git('rev-parse', 'HEAD'), repository: `https://github.com/${githubRepository(config.remote)}`,
          nextCheck: enabled ? (due ? now() : status.lastChecked + interval) : null });
        if (!due) return enabled ? status : report({ state: 'disabled', message: 'Automatic updates are turned off.' });
        await report({ state: 'checking', message: 'Checking main for new commits.', lastChecked: now(), nextCheck: enabled ? now() + interval : null, requestId: request.id || status.requestId });
        await cleanMain();
        await git('fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/main:refs/remotes/origin/main');
        const target = await git('rev-parse', 'refs/remotes/origin/main');
        await report({ latest: target });
        if (target === status.current) return report({ state: 'current', message: 'You are running the latest version.' });
        try { await git('merge-base', '--is-ancestor', status.current, target); }
        catch { throw new Error('Local main has diverged from the remote. No changes were made.'); }
        if (target === status.failedCommit) return report({ state: 'rolled_back', message: 'This commit previously failed to start. Waiting for a newer commit.' });
        const result = await checks(githubRepository(config.remote), target, fetcher);
        if (result !== 'passed') return report({ state: result === 'failed' ? 'checks_failed' : 'waiting_checks',
          message: result === 'failed' ? 'GitHub checks failed. The installed version has been kept.' : 'Waiting for GitHub checks to pass before installing.' });
        if (!enabled) return report({ state: 'available', message: 'An update is available. Turn on automatic updates to install it.' });
        await apply(status.current, target);
        return status;
      } catch (error) {
        const interrupted = await exists(journalFile);
        return report({ state: interrupted ? 'recovery_needed' : 'error', message: interrupted
          ? 'Automatic recovery could not finish. Check the host update service; the recovery backup has been kept.'
          : (error instanceof SyntaxError || error.code ? 'Update state could not be read. Check the host update service.' : error.message) });
      } finally {
        if (!(await exists(journalFile))) await rm(stage, { recursive: true, force: true });
      }
    },
  };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node update-runner.mjs /absolute/path/to/host-config.json');
  const config = await readJSON(resolve(configPath));
  await mkdir(config.state, { recursive: true, mode: 0o700 });
  if (!process.argv.includes('--locked')) {
    // OS lock is released even after SIGKILL or a power loss. Every entry point uses it.
    console.log(await command('flock', ['-n', join(config.state, 'update.lock'), process.execPath, process.argv[1], resolve(configPath), '--locked'], { timeout: 1_200_000, label: 'Update service' }));
    return;
  }
  const status = await createUpdater(config).tick();
  console.log(`watch.local updater: ${status.state}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('watch.local update service failed. Check its installation and host configuration.'); process.exitCode = 1; });
}
