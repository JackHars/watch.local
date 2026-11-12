import { gunzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';

const unzip = promisify(gunzip), decompress = promisify(inflate);
export const ZLIVE_MEDIA_LIMIT = 32 * 1024 * 1024;
const outputLimit = 64 * 1024 * 1024;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const invalid = () => Object.assign(new Error('ZLive returned an unsupported video segment.'), { status: 502 });
const isTS = bytes => bytes.length >= 188 * 3 && [0, 188, 376].every(i => bytes[i] === 0x47);
const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };

// The public player supports TS hidden after PNGs, in IDAT/WebP EXIF chunks,
// and gzip-compressed TS stored as PNG RGB pixels (TIKTIKPX). Decode on the
// server so Safari and IPTV apps don't need the site's custom HLS loader.
async function pngVideo(bytes) {
  let width, height, channels, end, pixelFormat, offset = 8; const chunks = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) throw invalid();
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw invalid();
      pixelFormat = chunk[8] === 8 && [2, 6].includes(chunk[9]) && !chunk[10] && !chunk[11] && !chunk[12];
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') chunks.push(chunk);
    offset += length + 12;
    if (type === 'IEND') { end = offset; break; }
  }
  if (end && isTS(bytes.subarray(end))) return bytes.subarray(end);
  const compressed = Buffer.concat(chunks);
  if (isTS(compressed)) return compressed;
  const stride = width * channels, size = (stride + 1) * height;
  if (!pixelFormat || !end || !width || !height || !Number.isSafeInteger(size) || size > outputLimit) throw invalid();
  const raw = await decompress(compressed, { maxOutputLength: size });
  if (raw.length !== size) throw invalid();
  const rgb = Buffer.alloc(width * height * 3);
  let prior = Buffer.alloc(stride), row = Buffer.alloc(stride), pixel = 0;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start];
    if (filter > 4) throw invalid();
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0, b = prior[x], c = x >= channels ? prior[x - channels] : 0;
      const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      row[x] = (raw[start + 1 + x] + prediction) & 255;
    }
    if (channels === 3) { row.copy(rgb, pixel); pixel += stride; }
    else for (let x = 0; x < stride; x += 4) { rgb[pixel++] = row[x]; rgb[pixel++] = row[x + 1]; rgb[pixel++] = row[x + 2]; }
    [prior, row] = [row, prior];
  }
  if (rgb.toString('ascii', 0, 8) !== 'TIKTIKPX' || rgb.length < 12) throw invalid();
  const length = rgb.readUInt32BE(8);
  if (!length || length > rgb.length - 12) throw invalid();
  return unzip(rgb.subarray(12, 12 + length), { maxOutputLength: outputLimit });
}

export async function decodeZliveMedia(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > ZLIVE_MEDIA_LIMIT) throw invalid();
  let video = bytes;
  if (bytes.subarray(0, 8).equals(png)) video = await pngVideo(bytes);
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12, found = false;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4), type = bytes.toString('ascii', offset, offset + 4); offset += 8;
      if (size > bytes.length - offset) throw invalid();
      if (type === 'EXIF') { video = bytes.subarray(offset, offset + size); found = true; break; }
      offset += size + (size & 1);
    }
    if (!found) throw invalid();
  } else if (!isTS(bytes) && !/^(ftyp|styp|moof|moov)$/.test(bytes.toString('ascii', 4, 8))) {
    const raw = bytes.indexOf('TIKTIKRAW'), gzip = bytes.indexOf('TIKTIKTSGZ');
    if (raw !== -1) video = bytes.subarray(raw + 9);
    else if (gzip !== -1) video = await unzip(bytes.subarray(gzip + 10), { maxOutputLength: outputLimit });
    else throw invalid();
  }
  if (!isTS(video) && !/^(ftyp|styp|moof|moov)$/.test(video.toString('ascii', 4, 8))) throw invalid();
  return video;
}

export function createZliveRelay({ fetchResource = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), waiting = [];
  let used = 0, active = 0;
  function prune() {
    for (const [url, item] of cache) if (item.until <= now() || used > ZLIVE_MEDIA_LIMIT) { used -= item.bytes.length; cache.delete(url); }
  }
  async function load(url, headers) {
    prune();
    if (cache.has(url)) return cache.get(url).bytes;
    if (pending.has(url)) return pending.get(url);
    const work = (async () => {
      if (active >= 4) await new Promise(resolve => waiting.push(resolve)); else active++;
      try {
        // Ranges describe the decoded video, not the upstream image container.
        const response = await fetchResource(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`ZLive video host returned HTTP ${response.status}.`), { status: 502 }); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > ZLIVE_MEDIA_LIMIT) throw invalid(); chunks.push(chunk); }
        const bytes = await decodeZliveMedia(Buffer.concat(chunks));
        if (bytes.length <= ZLIVE_MEDIA_LIMIT) { cache.set(url, { bytes, until: now() + 30000 }); used += bytes.length; prune(); }
        return bytes;
      } finally { if (waiting.length) waiting.shift()(); else active--; }
    })().finally(() => pending.delete(url));
    pending.set(url, work); return work;
  }
  return async (req, res, url, headers) => {
    const bytes = await load(url, headers);
    if (res.destroyed) return;
    const result = { 'Content-Type': isTS(bytes) ? 'video/mp2t' : 'video/mp4', 'Cache-Control': 'private, max-age=30', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    let from = 0, to = bytes.length - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        from = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
        to = match[1] && match[2] ? Math.min(to, Number(match[2])) : to;
      } else from = bytes.length;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || from >= bytes.length) { res.writeHead(416, { ...result, 'Content-Range': `bytes */${bytes.length}` }); return res.end(); }
      status = 206; result['Content-Range'] = `bytes ${from}-${to}/${bytes.length}`;
    }
    result['Content-Length'] = to - from + 1;
    res.writeHead(status, result); res.end(req.method === 'HEAD' ? undefined : bytes.subarray(from, to + 1));
  };
}
