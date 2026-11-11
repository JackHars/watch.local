import { createServer } from './server.mjs';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

// webPort can be overridden by local tests; the saved setting always selects 80.
export async function listenServers({ host, port, webPort80 = false, webPort = 80, onRequest } = {}) {
  const network = { host, port, webPort: port, webPort80: false, webError: '' };
  const server = createServer({ onRequest, network, mode: () => network.webPort80 ? 'iptv' : 'combined' });
  await listen(server, port, host);
  network.port = network.webPort = server.address().port;
  network.listenAddress = server.address().address;
  const servers = [server];
  if (webPort80) {
    const web = createServer({ onRequest, network, mode: 'web' });
    try {
      await listen(web, webPort, host);
      network.webPort = web.address().port;
      network.webPort80 = true;
      servers.push(web);
    } catch (error) {
      web.close();
      const reason = error.code === 'EADDRINUSE' ? 'it is already in use'
        : error.code === 'EACCES' ? 'the process does not have permission to bind it'
        : 'the listener could not start';
      network.webError = `Web port ${webPort} could not open because ${reason}. The web panel is still available on IPTV port ${network.port}.`;
    }
  }
  return {
    network, servers,
    close: () => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))),
    closeAllConnections: () => servers.forEach(server => server.closeAllConnections()),
  };
}
