import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createDiscovery, discoveryConfig, companionStatus } from './api/discovery.mjs';
import { environment } from './api/environment.mjs';

export function startDiscovery({ settings, network, onChange = () => {},
  mode = environment('MDNS_MODE') || (existsSync('/.dockerenv') ? 'container' : 'builtin'),
  statusFile = environment('MDNS_STATUS_FILE') } = {}) {
  let stopped = false, queue = Promise.resolve(), previous = '';
  const report = status => {
    if (stopped) return;
    network.discovery = status;
    const key = JSON.stringify(status);
    if (key !== previous) { previous = key; onChange(status); }
  };
  const publisher = mode === 'builtin' ? createDiscovery({ onStatus: report }) : null;
  async function update() {
    if (stopped) return;
    const target = network.discoveryConfig = discoveryConfig(settings.config().server, network);
    if (publisher) return publisher.configure(target);
    if (!target.enabled) return report({ state: 'disabled', hostname: '', url: '', message: 'Local discovery is turned off.' });
    if (mode === 'external' && statusFile) {
      try {
        const status = companionStatus(JSON.parse(await readFile(statusFile, 'utf8')), target);
        if (status) return report(status);
      } catch { /* Missing/stale companion reports are not proof of discovery. */ }
      return report({ state: 'unavailable', hostname: '', url: '', message: 'Waiting for the LAN discovery companion.' });
    }
    report({ state: 'unavailable', hostname: '', url: '', message: 'Docker discovery needs a companion on the host network. See the Local discovery section in the README.' });
  }
  const refresh = () => { queue = queue.then(update); return queue; };
  settings.events.on('change', refresh);
  const timer = setInterval(refresh, mode === 'external' ? 3000 : 10000); timer.unref();
  refresh();
  return { refresh, async close() { stopped = true; clearInterval(timer); settings.events.off('change', refresh); await queue; await publisher?.close(); } };
}
