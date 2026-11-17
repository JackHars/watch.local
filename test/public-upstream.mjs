// A public-looking fixture hostname backed by an isolated loopback HTTP server.
// Only this test transport maps it locally; production has no private-IP bypass.
export function localUpstream(server, transport = globalThis.fetch) {
  const origin = `http://upstream.fixture.test:${server.address().port}`;
  return {
    origin,
    async fetch(value, options = {}) {
      const url = new URL(value);
      if (url.origin !== origin) return transport(value, options);
      const local = new URL(url); local.hostname = '127.0.0.1';
      const { dispatcher, ...init } = options;
      const response = await transport(local, init);
      const resolved = new URL(response.url); resolved.hostname = 'upstream.fixture.test';
      Object.defineProperty(response, 'url', { value: resolved.href });
      return response;
    },
  };
}
