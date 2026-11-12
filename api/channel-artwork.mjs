import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { channelLogos } from './channel-metadata.mjs';

// Public, bundled broadcaster artwork works on both web and IPTV listeners.
// Only filenames from the curated manifest are admitted; no URL proxy or disk
// path supplied by a client is ever fetched. Logos need no personal credentials.
const cache = new Map();
export async function handleChannelArtwork(req, res) {
  const path = new URL(req.url, 'http://local').pathname;
  if (!path.startsWith('/channel-artwork/')) return false;
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
  const file = path.slice('/channel-artwork/'.length);
  if (!channelLogos.has(file)) { res.writeHead(404); res.end(); return true; }
  try {
    let asset = cache.get(file);
    if (!asset) {
      const bytes = await readFile(new URL('../public/channel-logos/' + file, import.meta.url));
      asset = { bytes, etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"' };
      cache.set(file, asset);
    }
    const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ETag: asset.etag, 'Access-Control-Allow-Origin': '*' };
    if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, { ...headers, 'Content-Length': asset.bytes.length });
    res.end(req.method === 'HEAD' ? undefined : asset.bytes);
  } catch { res.writeHead(404); res.end(); }
  return true;
}
