import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function createUpdateControl(directory) {
  return {
    async status() {
      try {
        const saved = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
        const available = saved.version === 1 && Date.now() - saved.heartbeat < 20 * 60_000;
        // Only expose public status fields, never host configuration or command output.
        const result = { available };
        for (const key of ['state', 'message', 'current', 'latest', 'lastChecked', 'lastUpdated', 'nextCheck', 'repository']) {
          if (typeof saved[key] === 'string' || Number.isFinite(saved[key])) result[key] = saved[key];
        }
        if (!available) Object.assign(result, { state: 'unavailable', message: 'The update service is not running. See Automatic updates in the README for installation.' });
        return result;
      } catch {
        return { available: false, state: 'unavailable', message: 'Install the host update service to enable automatic updates. See Automatic updates in the README.' };
      }
    },
    async check() {
      if (!(await this.status()).available) throw Object.assign(new Error('The host update service is not available.'), { status: 503 });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID(), temporary = join(directory, `request-${id}.tmp`);
      await writeFile(temporary, JSON.stringify({ id, at: Date.now() }), { mode: 0o600 });
      await rename(temporary, join(directory, 'request.json'));
      return { queued: true };
    },
  };
}
