import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readRevision, runningRevision } from './runtime-version.mjs';

const busy = new Set(['checking', 'preparing', 'installing', 'restarting', 'rolling_back', 'recovery_needed']);
const failures = new Set(['error', 'checks_failed', 'rolled_back', 'recovery_needed']);

export function createUpdateControl(directory, { running = runningRevision, installed = readRevision } = {}) {
  return {
    async status() {
      try {
        const saved = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
        const available = saved.version === 1 && Date.now() - saved.heartbeat < 20 * 60_000;
        // Only expose public status fields, never host configuration or command output.
        const result = { available, running, restartSupported: saved.restartSupported === true };
        for (const key of ['state', 'message', 'current', 'latest', 'lastChecked', 'lastUpdated', 'nextCheck', 'repository']) {
          if (typeof saved[key] === 'string' || Number.isFinite(saved[key])) result[key] = saved[key];
        }
        if (!available) Object.assign(result, { state: 'unavailable', message: 'The update service is not running. See Automatic updates in the README for installation.' });
        result.current = await installed() || result.current;
        result.restartRequired = Boolean(running && result.current && running !== result.current);
        result.canRestart = available && result.restartSupported && result.restartRequired && !busy.has(result.state) && result.state !== 'checks_failed';
        if (result.restartRequired && !busy.has(result.state) && !failures.has(result.state)) {
          result.state = 'restart_required';
          result.message = result.canRestart ? 'Updated code is installed. Restart watch.local to finish applying it.'
            : 'Updated code is installed, but the running server is older. Install or repair the host update service, then restart watch.local.';
        }
        return result;
      } catch {
        return { available: false, running, state: 'unavailable', message: 'Install the host update service to enable automatic updates. Starting the app at boot alone does not install the updater. See Automatic updates in the README.' };
      }
    },
    async check() {
      if (!(await this.status()).available) throw Object.assign(new Error('The host update service is not available.'), { status: 503 });
      return this.request('check');
    },
    async restart() {
      const status = await this.status();
      if (!status.canRestart) throw Object.assign(new Error(status.restartRequired ? status.message : 'No restart is required.'), { status: 409 });
      return this.request('restart', status.current);
    },
    async request(action, revision) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID(), temporary = join(directory, `request-${id}.tmp`);
      await writeFile(temporary, JSON.stringify({ id, action, revision, at: Date.now() }), { mode: 0o600 });
      await rename(temporary, join(directory, 'request.json'));
      return { queued: true };
    },
  };
}
