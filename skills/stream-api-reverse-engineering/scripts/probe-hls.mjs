#!/usr/bin/env node
// Bounded HLS smoke probe. Inputs live outside the repo; no URL or header values are logged.
import { readFile } from 'node:fs/promises';

const usage = 'Usage: node probe-hls.mjs --url-file PATH [--headers-file PATH]';
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--url-file', '--headers-file'].includes(flag) || !value) {
    console.error(usage);
    process.exit(2);
  }
  options.set(flag, value);
}
if (!options.has('--url-file')) {
  console.error(usage);
  process.exit(2);
}

function safeUrl(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  return url.href;
}

function mediaKind(bytes) {
  if (bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47 &&
      (bytes.length === 376 || bytes[376] === 0x47)) return 'mpeg-ts';
  if (bytes.length >= 8 && ['ftyp', 'moof', 'styp', 'moov'].includes(bytes.subarray(4, 8).toString())) return 'fragmented-mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png-not-video';
  const lead = bytes.subarray(0, 80).toString('utf8').trimStart().toLowerCase();
  if (lead.startsWith('<') || lead.startsWith('{') || lead.startsWith('[')) return 'html-or-json-not-video';
  return 'unknown-bytes';
}

async function fetchBounded(url, headers, limit) {
  const response = await fetch(safeUrl(url), {
    headers: { ...headers, Range: `bytes=0-${limit - 1}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, limit - size);
      chunks.push(Buffer.from(value.subarray(0, take)));
      size += take;
      if (take < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks), url: response.url, status: response.status,
    type: response.headers.get('content-type') || '' };
}

function playlistLines(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!text.startsWith('#EXTM3U')) throw new Error(`Not an HLS manifest (${mediaKind(bytes)})`);
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function nextUri(lines, start) {
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].startsWith('#')) return lines[i];
    if (lines[i].startsWith('#EXT-X-STREAM-INF') || lines[i].startsWith('#EXTINF')) break;
  }
  return null;
}

async function main() {
  const url = safeUrl(await readFile(options.get('--url-file'), 'utf8'));
  const headers = options.has('--headers-file')
    ? JSON.parse(await readFile(options.get('--headers-file'), 'utf8')) : {};
  if (!headers || Array.isArray(headers) || typeof headers !== 'object' ||
      Object.values(headers).some(value => typeof value !== 'string')) {
    throw new Error('Headers file must contain a JSON object of strings');
  }

  let manifest = await fetchBounded(url, headers, 256 * 1024);
  let lines = playlistLines(manifest.bytes);
  let variant = false;
  const masterIndex = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'));
  if (masterIndex >= 0) {
    const path = nextUri(lines, masterIndex);
    if (!path) throw new Error('Master manifest has no variant URI');
    manifest = await fetchBounded(new URL(path, manifest.url).href, headers, 256 * 1024);
    lines = playlistLines(manifest.bytes);
    variant = true;
  }

  const segmentIndex = lines.findIndex(line => line.startsWith('#EXTINF:'));
  const segmentPath = segmentIndex >= 0 ? nextUri(lines, segmentIndex) : null;
  if (!segmentPath) throw new Error('Media manifest has no segment');
  const segment = await fetchBounded(new URL(segmentPath, manifest.url).href, headers, 64 * 1024);
  const kind = mediaKind(segment.bytes);
  const mapLine = lines.find(line => line.startsWith('#EXT-X-MAP:'));
  let mapKind = null;
  if (mapLine) {
    const mapPath = mapLine.match(/URI="([^"]+)"/)?.[1];
    if (mapPath) {
      const map = await fetchBounded(new URL(mapPath, manifest.url).href, headers, 4096);
      mapKind = mediaKind(map.bytes);
    }
  }
  const playable = kind === 'mpeg-ts' || kind === 'fragmented-mp4';
  console.log(JSON.stringify({ verdict: playable ? 'raw_verified' : 'not_verified', variant,
    manifestStatus: manifest.status, manifestType: manifest.type,
    segmentStatus: segment.status, segmentType: segment.type, segmentBytesChecked: segment.bytes.length,
    segmentKind: kind, initMapKind: mapKind }));
  if (!playable) process.exitCode = 1;
}

main().catch(error => {
  // Error messages from fetch may contain signed URLs on some Node versions.
  const message = error.message || '';
  const safe = /^HTTP \d+$/.test(message) || /^(Only HTTP|Headers file|Not an HLS|Master manifest|Media manifest)/.test(message)
    ? message : error.name === 'TimeoutError' ? 'Request timed out' : 'Fetch or input failed';
  console.error(JSON.stringify({ verdict: 'not_verified', error: safe }));
  process.exitCode = 1;
});
