import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { getResponder } from '@homebridge/ciao';

export const validLocalName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
export const discoveryConfig = (server, network) => ({
  enabled: server.mdns !== false, hostname: server.mdnsHostname || 'watch',
  name: server.name, host: network.listenAddress || network.host, port: network.webPort,
});
export const discoveryURL = (hostname, port) => new URL(`http://${hostname}:${port}`).origin;

// Keep container bridges, VPNs and loopback out of LAN advertisements. Explicit
// listen addresses are still restricted to the interface actually serving HTTP.
export function discoveryInterfaces(host, interfaces = networkInterfaces()) {
  if (!['0.0.0.0', '::'].includes(host) && !isIP(host)) return [];
  return Object.entries(interfaces).flatMap(([name, addresses]) => {
    if (/^(?:lo\d*$|docker|br-|veth|virbr|tun|tap|utun|tailscale|wg\d)/i.test(name)) return [];
    const usable = (addresses || []).filter(a => !a.internal &&
      (host === '::' || (host === '0.0.0.0' ? a.family === 'IPv4' : a.address === host)));
    return usable.length ? [{ name, addresses: usable.map(a => a.address).sort() }] : [];
  });
}

export function createDiscovery({ responderFactory = getResponder, interfaces = networkInterfaces, onStatus = () => {} } = {}) {
  let desired, signature = '', responder, service, generation = 0, closed = false;
  let queue = Promise.resolve(), status = { state: 'disabled', hostname: '', url: '', message: '' };
  const report = next => { status = next; onStatus({ ...status }); };
  const stop = async () => {
    generation++;
    const old = responder; responder = service = undefined;
    if (old) try { await old.shutdown(); } catch { /* Socket failure must not stop the web server. */ }
  };
  async function reconcile() {
    if (closed || !desired) return;
    const target = desired, selected = discoveryInterfaces(target.host, interfaces());
    const next = JSON.stringify([target, selected]);
    if (next === signature) return;
    signature = next;
    await stop();
    if (closed) return;
    if (!target.enabled) return report({ state: 'disabled', hostname: '', url: '', message: 'Local discovery is turned off.' });
    if (!validLocalName(target.hostname) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      return report({ state: 'unavailable', hostname: '', url: '', message: 'The local discovery configuration is invalid.' });
    }
    if (!selected.length) return report({ state: 'unavailable', hostname: '', url: '', message: 'No LAN interface matches the web server’s listen address.' });
    report({ state: 'starting', hostname: '', url: '', message: 'Checking the local name on your network…' });
    const current = generation;
    const update = () => {
      if (closed || current !== generation || !service) return;
      const hostname = service.getHostname().replace(/\.$/, '');
      report({ state: 'advertising', hostname, url: discoveryURL(hostname, target.port),
        message: hostname === `${target.hostname}.local` ? 'Available to compatible devices on your local network.'
          : `${target.hostname}.local was already in use. This server is using ${hostname}.` });
    };
    try {
      const ipv6 = target.host === '::' || isIP(target.host) === 6;
      responder = responderFactory({ interface: selected.map(i => i.name), disableIpv6: !ipv6, advertiseIpv6: ipv6 });
      const instanceName = `watch.local · ${target.hostname}`;
      service = responder.createService({ name: Buffer.byteLength(instanceName) <= 63 ? instanceName : target.hostname, hostname: target.hostname,
        type: 'http', port: target.port, disabledIpv6: !ipv6,
        restrictedAddresses: ['0.0.0.0', '::'].includes(target.host) ? selected.map(i => i.name) : [target.host],
        txt: { path: '/' } });
      service.on('hostname-change', () => { if (status.state === 'advertising') update(); });
      // Advertise asynchronously: slow probing must never delay HTTP startup,
      // disabling discovery, or shutdown. ciao handles probing and conflicts.
      service.advertise().then(update, () => {
        if (closed || current !== generation) return;
        signature = ''; // Retry on the next network/settings check.
        report({ state: 'unavailable', hostname: '', url: '', message: 'Local discovery could not announce on this network. The server’s IP address still works.' });
      });
    } catch {
      signature = '';
      await stop();
      report({ state: 'unavailable', hostname: '', url: '', message: 'Local discovery could not start. Check that multicast UDP port 5353 is available.' });
    }
  }
  const refresh = () => { queue = queue.then(reconcile); return queue; };
  return {
    configure(config) { desired = { ...config }; return refresh(); }, refresh,
    status: () => ({ ...status }),
    async close() { closed = true; await queue; await stop(); },
  };
}

// Only accept a fresh companion report for the currently requested settings.
// Build the link ourselves so a corrupt report cannot inject an unrelated URL.
export function companionStatus(record, target, now = Date.now()) {
  if (!record || record.target !== JSON.stringify(target) || !Number.isFinite(record.at) ||
      record.at > now + 1000 || now - record.at > 20000) return null;
  const status = record.status;
  if (!status || !['disabled','starting','advertising','unavailable'].includes(status.state)) return null;
  if (status.state === 'advertising') {
    if (!/^[a-z0-9][a-z0-9()-]{0,62}\.local$/.test(status.hostname)) return null;
    return { state: status.state, hostname: status.hostname, url: discoveryURL(status.hostname, target.port),
      message: status.hostname === `${target.hostname}.local` ? 'Available to compatible devices on your local network.'
        : `${target.hostname}.local was already in use. This server is using ${status.hostname}.` };
  }
  return { state: status.state, hostname: '', url: '', message: status.state === 'starting'
    ? 'Checking the local name on your network…' : 'Local discovery is not currently advertising.' };
}
