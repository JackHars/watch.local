import { createCipheriv, createHash } from 'node:crypto';

// Synthetic public-player parameters. No upstream sessions or API credentials.
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const route = '/gacvejtu/t/12345678/' + 'a'.repeat(40);
const key = Buffer.alloc(32, 17), seed = Buffer.alloc(32, 23), iv = Buffer.alloc(16, 31);
const counters = ['1234567890', '9876543210'];
const encodeMask = (seed, step) => Uint8Array.from({ length: 256 }, () => {
  let n = seed = (seed + step) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35) >>> 0;
  return (n ^ (n >>> 16)) & 255;
});
export function reelixFixture() {
  const literals = [];
  for (let i = 0; i < 5; i++) literals.push(Buffer.alloc(32, 40 + i).toString('base64'), Buffer.alloc(8, 50 + i).toString('base64'));
  literals.push(key.toString('hex'), iv.toString('hex'), Buffer.alloc(3, 61).toString('hex'), route, '/', 'handshake01', '/');
  for (let i = 0; i < 5; i++) literals.push(Buffer.alloc(32, 70 + i).toString('base64'));
  literals.push(seed.toString('hex'), ...counters, route, '/', 'sources0001', '/');
  const data = Buffer.alloc(53058);
  let offset = 0;
  for (const value of literals) {
    const bytes = Buffer.from(value); data[offset] = 155; data[offset + 1] = 35; data.writeUInt16BE(bytes.length, offset + 2); bytes.copy(data, offset + 4); offset += bytes.length + 4;
  }
  const a = encodeMask(0x395290c, 0x6c62272e), b = encodeMask(0xa6308ca9, 0x9e3779b9);
  const encoded = data.map((v, i) => v ^ a[i % 256] ^ b[i % 256]);
  const script = `a=B.from("${encoded.subarray(0, 10000).toString('base64')}",b64),b=B.from("${encoded.subarray(10000, 14000).toString('hex')}",hex),c=B.from("${encoded.subarray(14000).toString('hex')}",hex);JSON.parse('${JSON.stringify([...alphabet].reverse())}');x.concat("streams0001","/").concat(r.data);throw new Error('This downloaded script must never execute');`;
  const numbers = counters.map(n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; });
  const responseKey = createHash('sha256').update(Buffer.concat([seed, ...numbers])).digest();
  function encrypt(value) {
    const salt = Buffer.alloc(16, 83), nonce = Buffer.alloc(12, 91);
    const key = createHash('sha256').update(Buffer.concat([responseKey, salt])).digest();
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const data = Buffer.concat([Buffer.alloc(8), Buffer.from(JSON.stringify(value))]);
    return Buffer.concat([salt, nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  return { script, responseKey, encrypt, route };
}

export function reelixFetch({ wrongID = false, brokenFirst = false, allBroken = false, noReferrer = false, mediaOrigin = 'https://media.test', onRequest = () => {} } = {}) {
  const fixture = reelixFixture(), calls = [], active = { id: 0 };
  const fetchResource = async (url, options = {}) => {
    const u = new URL(url); calls.push(u); onRequest(u, options);
    if (u.hostname === 'vidcore.io') {
      const player = u.pathname.match(/^\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?$/);
      if (player) {
        active.id = Number(player[2]);
        return new Response(`<script src="/_next/static/chunks/281-abcdef.js"></script><script>self.__next_f.push([1,"{\\"en\\":\\"${'fixture-session-'.repeat(4)}\\",\\"id\\":\\"${active.id}\\"}"])</script>`);
      }
      if (u.pathname.endsWith('.js')) return new Response(fixture.script);
      if (u.pathname.startsWith(fixture.route + '/handshake01/')) return new Response('synthetic-session-challenge');
      if (u.pathname.startsWith(fixture.route + '/sources0001/')) return new Response(fixture.encrypt([{ name: 'First', data: 'fixture-source-first' }, { name: 'Backup', data: 'fixture-source-backup' }]));
      if (u.pathname.startsWith(fixture.route + '/streams0001/')) return new Response(fixture.encrypt({ tmdbId: wrongID ? 99999 : active.id, url: mediaOrigin + ((allBroken || brokenFirst && u.pathname.endsWith('-first')) ? '/bad.m3u8' : '/master.m3u8'), noReferrer }));
    }
    if (u.origin === mediaOrigin) {
      if (u.pathname === '/master.m3u8') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\nleaf.m3u8\n');
      if (u.pathname === '/leaf.m3u8') return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');
      if (u.pathname === '/segment.ts') return new Response(Buffer.alloc(188 * 4, 0x47));
      if (u.pathname === '/bad.m3u8') return new Response('<html>Not video</html>');
    }
    return new Response('Unavailable', { status: 404 });
  };
  return { fetchResource, calls, fixture };
}
