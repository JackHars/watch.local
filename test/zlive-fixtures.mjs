import { deflateSync, gzipSync } from 'node:zlib';

export const video = Buffer.alloc(188 * 8);
for (let i = 0; i < video.length; i++) video[i] = i % 188 === 0 ? 0x47 : i % 251;
const chunk = (name, data) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(name, 4); data.copy(out, 8); return out; };
// Small synthetic image carrying a known transport-stream payload. CRC bytes
// are unused by the provider's framing protocol; no real broadcast is bundled.
export function wrappedVideo({ rgba = false } = {}) {
  const zip = gzipSync(video), payload = Buffer.alloc(zip.length + 12); payload.write('TIKTIKPX'); payload.writeUInt32BE(zip.length, 8); zip.copy(payload, 12);
  const width = 8, height = Math.ceil(payload.length / (width * 3)), bpp = rgba ? 4 : 3;
  const pixels = Buffer.alloc(width * height * bpp);
  if (rgba) for (let i = 0; i < payload.length; i++) pixels[Math.floor(i / 3) * 4 + i % 3] = payload[i];
  else payload.copy(pixels);
  const stride = width * bpp, scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = y % 5; scanlines[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= bpp ? pixels[at - bpp] : 0, above = y ? pixels[at - stride] : 0, corner = y && x >= bpp ? pixels[at - stride - bpp] : 0;
      const candidates = [left, above, corner], predictor = left + above - corner;
      const nearest = candidates.reduce((best, value) => Math.abs(predictor - value) < Math.abs(predictor - best) ? value : best);
      const prediction = [0, left, above, Math.floor((left + above) / 2), nearest][filter];
      scanlines[y * (stride + 1) + 1 + x] = (pixels[at] - prediction + 256) % 256;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = rgba ? 6 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

export const channel = { key: 'fixture-tv', name: 'Fixture TV', group: 'Entertainment', sources: ['fixture-primary', 'fixture-backup'], accent: '#527de0', region: 'CA', quality: 'HD', live: true };
