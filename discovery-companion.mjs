import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDiscovery, validLocalName } from './api/discovery.mjs';
import { environment } from './api/environment.mjs';

export function createDiscoveryCompanion({ endpoint, statusFile, fetchHealth = fetch, publisherFactory = createDiscovery, log = console.log } = {}) {
  const address = new URL(endpoint);
  if (address.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(address.hostname) || address.username || address.password) {
    throw new Error('The discovery companion must query a local watch.local HTTP health endpoint.');
  }
  let target, previous = '', stopped = false, queue = Promise.resolve(), writes = Promise.resolve();
  const write = status => {
    if (!statusFile) return Promise.resolve();
    const record = JSON.stringify({ at: Date.now(), target: JSON.stringify(target), status });
    writes = writes.then(async () => {
      await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 });
      await writeFile(statusFile + '.tmp', record, { mode: 0o600 });
      await rename(statusFile + '.tmp', statusFile);
    }).catch(() => { log('Could not update the local discovery status file.'); });
    return writes;
  };
  const publisher = publisherFactory({ onStatus: status => {
    const key = JSON.stringify(status);
    if (key !== previous) { previous = key; log(status.url ? `Local discovery: ${status.url}` : status.message); }
    write(status);
  } });
  async function poll() {
    if (stopped) return;
    try {
      const response = await fetchHealth(address, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw Error('Health unavailable');
      const health = await response.json(), config = health.discovery;
      if (health.application !== 'watchlocal' || !health.ok || !config || typeof config.enabled !== 'boolean' ||
          !validLocalName(config.hostname) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
          !['0.0.0.0','::'].includes(config.host)) throw Error('No LAN listener');
      target = config;
      await publisher.configure(target);
    } catch {
      // Withdraw promptly if the app stops, so watch.local never advertises a
      // dead container or another service that happens to occupy its old port.
      target = undefined;
      await publisher.configure({ enabled: false, hostname: 'watch', host: '0.0.0.0', port: 80 });
    }
    await write(publisher.status());
  }
  const refresh = () => { queue = queue.then(poll); return queue; };
  return { refresh, async close() { stopped = true; await queue; await publisher.close(); target = undefined;
    await write({ state: 'disabled', hostname: '', url: '', message: 'Discovery companion stopped.' }); await writes; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companion = createDiscoveryCompanion({
    endpoint: environment('DISCOVERY_ENDPOINT') || 'http://127.0.0.1:8091/health',
    statusFile: environment('MDNS_STATUS_FILE'),
  });
  const timer = setInterval(() => companion.refresh(), 5000);
  companion.refresh();
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; clearInterval(timer);
    companion.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
