import { highestQualityPlaylist } from './hls-quality.mjs';

const fail = message => Object.assign(new Error(message), { status: 502 });
// A valid playlist can still point at an error page or PNG/P2P chunks. Check a
// small piece of video before committing a native player to this provider.
export async function probeSportsStream(stream, { fetchResource = fetch, media = async () => null, signal } = {}) {
  async function request(url, { binary = false, key = false } = {}) {
    const resource = stream.playback ? await media(url, stream.playback) : null;
    const headers = { ...stream.headers, ...resource?.headers, ...(binary && !key ? { Range: 'bytes=0-1023' } : {}) };
    const response = await fetchResource(resource?.url || url, { headers, signal: signal || AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail(`Sports video check returned HTTP ${response.status}.`); }
    const reader = response.body?.getReader(); if (!reader) throw fail('The sports stream is empty.');
    const chunks = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        chunks.push(part.value); length += part.value.length;
        if (binary && length >= (key ? 16 : 564)) break;
        if (length > 2 * 1024 * 1024) throw fail('The sports playlist is too large.');
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { body: Buffer.concat(chunks), url: response.url || resource?.url || url };
  }
  let url = stream.url;
  for (let depth = 0; depth < 4; depth++) {
    const response = await request(url), text = response.body.toString('utf8');
    if (!text.trimStart().startsWith('#EXTM3U')) throw fail('The sports source did not return an HLS playlist.');
    const playlist = highestQualityPlaylist(text), lines = playlist.split(/\r?\n/).map(line => line.trim());
    const entries = lines.filter(line => line && !line.startsWith('#'));
    if (!entries.length) throw fail('The sports playlist has no video yet.');
    if (/#EXT-X-STREAM-INF:/.test(playlist)) { url = new URL(entries[0], response.url).href; continue; }
    const key = playlist.match(/#EXT-X-KEY:METHOD=([^,\r\n]+)[^\r\n]*URI="([^"]+)"/);
    if (key && key[1] !== 'AES-128') throw fail('The sports stream requires an unsupported encryption format.');
    if (key && (await request(new URL(key[2], response.url).href, { binary: true, key: true })).body.length !== 16) throw fail('The sports stream encryption key is unavailable.');
    // Near the live edge, but one complete segment behind the newest upload.
    const bytes = (await request(new URL(entries[Math.max(0, entries.length - 2)], response.url).href, { binary: true })).body;
    if (!bytes.length || /^\s*<(?:!doctype|html|body|\?xml)/i.test(bytes.subarray(0, 120).toString()) || bytes.subarray(0, 4).equals(Buffer.from([137,80,78,71]))) throw fail('The sports source returned a page or image instead of video.');
    const transport = bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47;
    const mp4 = /^(ftyp|styp|moof|moov)$/.test(bytes.subarray(4, 8).toString());
    if (!key && !transport && !mp4) throw fail('The sports source returned unsupported video data.');
    return;
  }
  throw fail('The sports playlist contains too many nested playlists.');
}
