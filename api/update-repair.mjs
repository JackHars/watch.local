import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, rm } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { command, writeJSON } from '../scripts/update-runner.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const terminalStates = new Set(['complete', 'error', 'cancelled']);
const prompt = 'watchlocal-sudo-password:';
async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }

export async function nativeRepairTarget(repo = repository, run = command) {
  if (process.platform !== 'linux') throw Error('Browser repair requires a Linux system boot service.');
  try { await access('/.dockerenv'); throw Error('docker'); }
  catch (error) { if (error.message === 'docker') throw Error('This installation uses Docker. Its updater must be installed on the host using the README setup command.'); }
  if ((await readFile('/proc/self/status', 'utf8')).includes('NoNewPrivs:\t1')) throw Error('This service blocks sudo. Run the repair command on the host instead.');
  const owner = userInfo();
  if (!owner.uid) throw Error('Run watch.local as a regular user with sudo access before using browser repair.');
  for (const binary of ['/usr/bin/script', '/usr/bin/sudo', '/usr/bin/systemd-run']) {
    try { await access(binary); } catch { throw Error('Install sudo, systemd and util-linux on this server before using browser repair.'); }
  }
  const groups = await readFile('/proc/self/cgroup', 'utf8');
  const service = groups.match(/\/system\.slice\/([A-Za-z0-9_.@-]+\.service)(?:\/|\n|$)/)?.[1] || 'watchlocal.service';
  if (service === 'watchlocal-update.service') throw Error('Open repair from the watch.local application service.');
  const properties = await run('/usr/bin/systemctl', ['show', service, '--property=LoadState,User,WorkingDirectory']);
  const fields = Object.fromEntries(properties.split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (fields.LoadState !== 'loaded' || ![owner.username, String(owner.uid)].includes(fields.User)) throw Error('Browser repair needs a system boot service running as this checkout’s owner. See the Raspberry Pi setup command in the README.');
  repo = await realpath(repo);
  if (await realpath(fields.WorkingDirectory || '/') !== repo || (await stat(repo)).uid !== owner.uid) throw Error('The system boot service must use this checkout as its WorkingDirectory.');
  return { repo, service, username: owner.username, uid: owner.uid, gid: owner.gid };
}

// A PTY is needed for sudo configurations that require a terminal. There is no
// interactive shell after the fixed command; input echo and input logging are off.
export function sudoTerminal(jobDirectory, { spawnProcess = spawn, node = process.execPath } = {}) {
  const helper = fileURLToPath(new URL('../scripts/repair-updater.mjs', import.meta.url));
  const args = ['/usr/bin/sudo', '-k', '-p', prompt, '--', node, helper, '--launch', jobDirectory];
  return spawnProcess('/usr/bin/script', ['--quiet', '--return', '--flush', '--echo=never', '--command', 'exec ' + args.map(quote).join(' '), '/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: userInfo().homedir, TERM: 'dumb', LANG: 'C', LC_ALL: 'C', SHELL: '/bin/sh' },
  });
}

export function createUpdateRepair(directory, { target = nativeRepairTarget, terminal = sudoTerminal, account, now = Date.now, authTimeout = 300_000 } = {}) {
  const sessions = new Map();
  let starting = false, lastStarted = 0;
  const path = id => join(directory, id);
  async function statusFile(id) { return readJSON(join(path(id), 'status.json')); }
  async function setAuthStatus(id, changes) {
    const current = await statusFile(id);
    // Once sudo hands off, only the independent repair service writes status.
    if (current.state !== 'authenticating') return;
    await writeJSON(join(path(id), 'status.json'), { ...current, ...changes, updatedAt: now() });
  }
  async function authorize(id, token) {
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw fail(403, 'This repair session has expired. Open a new repair terminal.');
    let job;
    try { job = await readJSON(join(path(id), 'job.json')); } catch { throw fail(404, 'Repair session not found.'); }
    const user = account(job.userId);
    if (job.expires < now() || !user?.enabled || user.role !== 'admin' || user.version !== job.userVersion || (user.expiresAt && Date.parse(user.expiresAt) <= now()) || !/^[a-f0-9]{64}$/.test(job.tokenHash) || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(job.tokenHash))) throw fail(403, 'This repair session has expired. Open a new repair terminal.');
    return job;
  }
  function stop(id) {
    const session = sessions.get(id); if (!session) return;
    clearTimeout(session.timeout); sessions.delete(id);
    session.child.stdin.end();
    try { process.kill(-session.child.pid, 'SIGTERM'); } catch { session.child.kill('SIGTERM'); }
  }
  return {
    async availability() {
      try { const found = await target(); return { supported: true, username: found.username, service: found.service }; }
      catch (error) { return { supported: false, message: error.message }; }
    },
    async start(user, data) {
      if (starting || now() - lastStarted < 15_000) throw fail(429, 'A repair was just started. Wait a moment before trying again.');
      starting = true;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let active;
        try { active = await readJSON(join(directory, 'active.json')); } catch {}
        if (/^[a-f0-9]{32}$/.test(active?.id || '')) {
          const prior = await readJSON(join(path(active.id), 'job.json')).catch(() => null);
          const status = await statusFile(active.id).catch(() => null);
          if (prior?.expires > now() && status && !terminalStates.has(status.state) && now() - status.updatedAt < 26 * 60_000 && (status.state !== 'authenticating' || sessions.has(active.id))) throw fail(409, 'A repair is already running. Return to its browser tab to see progress.');
          // Keep only the most recent session; runtime files never enter Git.
          if (/^[a-f0-9]{32}$/.test(active.id || '')) await rm(path(active.id), { recursive: true, force: true });
        }
        const found = await target();
        const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('base64url');
        const job = { ...found, id, data: await realpath(data), userId: user.id, userVersion: user.version, tokenHash: hash(token), expires: now() + 35 * 60_000 };
        await writeJSON(join(path(id), 'job.json'), job);
        await writeJSON(join(path(id), 'status.json'), { state: 'authenticating', message: 'Opening a sudo terminal on the server…', output: 'Repair automatic updates\n', updatedAt: now(), waitingForPassword: false, username: found.username, prompt: 0 });
        await writeJSON(join(directory, 'active.json'), { id });
        lastStarted = now();
        const child = terminal(path(id));
        const session = { child, waiting: false, buffer: '', prompts: 0, queue: Promise.resolve() };
        sessions.set(id, session);
        const finish = message => {
          session.queue = session.queue.then(async () => {
            await setAuthStatus(id, { state: 'error', waitingForPassword: false, message }); stop(id);
          }).catch(() => stop(id));
        };
        const receive = chunk => {
          // Never forward raw terminal output: PAM/sudo output may contain
          // sensitive information. Only recognize our fixed password prompt.
          session.buffer = (session.buffer + chunk.toString()).slice(-2048);
          let index;
          while ((index = session.buffer.indexOf(prompt)) !== -1) {
            session.buffer = session.buffer.slice(index + prompt.length); session.prompts++;
            session.queue = session.queue.then(async () => {
              session.waiting = true;
              await setAuthStatus(id, { waitingForPassword: true, prompt: session.prompts, message: session.prompts > 1 ? 'Password not accepted. Try the server user’s sudo password again.' : 'Enter the server user’s sudo password below.' });
            }).catch(() => stop(id));
          }
        };
        child.stdout.on('data', receive); child.stderr.on('data', receive);
        child.stdin.on('error', () => {});
        child.on('error', () => finish('The sudo terminal could not start. Check that sudo and util-linux are installed.'));
        child.on('close', () => finish('Sudo could not start the repair. Check the password and that this server user has sudo access.'));
        session.timeout = setTimeout(() => finish('The password prompt expired. Open repair again to retry.'), authTimeout); session.timeout.unref?.();
        return { id, token };
      } finally { starting = false; }
    },
    async status(id, token) {
      await authorize(id, token);
      let status = await statusFile(id);
      if (status.state === 'authenticating' && !sessions.has(id)) {
        await setAuthStatus(id, { state: 'error', waitingForPassword: false, message: 'The server restarted before sudo finished. Open repair again to retry.' });
        status = await statusFile(id);
      }
      if (status.state === 'running' && now() - status.updatedAt > 26 * 60_000) status = { ...status, state: 'error', message: 'Repair stopped reporting progress. Check the host update service before retrying.' };
      return status;
    },
    async password(id, token, input, user) {
      const job = await authorize(id, token);
      if (job.userId !== user.id) throw fail(403, 'Open your own repair session.');
      if (typeof input.password !== 'string' || !input.password || Buffer.byteLength(input.password) > 512 || /[\x00-\x1f\x7f]/.test(input.password) || !Number.isInteger(input.prompt)) throw fail(400, 'Enter a valid sudo password.');
      const session = sessions.get(id);
      if (!session) throw fail(409, 'The password prompt is no longer active.');
      const operation = session.queue.then(async () => {
        if (!session.waiting || session.prompts !== input.prompt || (await statusFile(id)).state !== 'authenticating') throw fail(409, 'The password prompt is no longer active.');
        session.waiting = false;
        await setAuthStatus(id, { waitingForPassword: false, message: 'Authenticating with sudo…' });
        session.child.stdin.write(input.password + '\n');
        input.password = ''; // Never save, log, return, or retry password input.
        return { accepted: true };
      });
      session.queue = operation.catch(() => {});
      return operation;
    },
    async cancel(id, token, user) {
      const job = await authorize(id, token);
      if (job.userId !== user.id) throw fail(403, 'Open your own repair session.');
      // After handoff a close only hides the terminal; don't interrupt repairs.
      await setAuthStatus(id, { state: 'cancelled', waitingForPassword: false, message: 'Password prompt cancelled.' });
      stop(id); return { ok: true };
    },
  };
}
