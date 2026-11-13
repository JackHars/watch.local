import { normalizeLiveSearch } from '../public/live-model.mjs';
import { probeSportsStream } from './sports-probe.mjs';
import { decodeZliveMedia, ZLIVE_MEDIA_LIMIT } from './zlive-media.mjs';

// Match broadcaster identity and country, never fuzzy title fragments: ESPN2
// must not become ESPN, and regional versions must not silently replace one another.
export function groupChannels(items) {
  const groups = new Map();
  for (const item of items.filter(row => row.kind === 'channel')) {
    const name = item.channel_name || item.title;
    const identity = normalizeLiveSearch(name.replace(/\s+(?:backup(?:\s+\d+)?|(?:full\s*)?hd|fhd|uhd|sd|4k)\b/gi, ''));
    const key = `${item.country || 'INT'}:${identity}`;
    if (!groups.has(key)) groups.set(key, { key, item, members: [] });
    const group = groups.get(key);
    group.members.push(item);
    // Keep the first provider's ID; borrow artwork/guide if only a fallback has it.
    if (!group.item.artwork && item.artwork) group.item = { ...group.item, artwork: item.artwork, white_logo: item.white_logo, logo_plate: item.logo_plate };
    if (!group.item.program && item.program) group.item = { ...group.item, program: item.program, starts_at: item.starts_at, ends_at: item.ends_at };
  }
  return [...groups.values()];
}

// ZLive can wrap video in an image. Validate its actual video before choosing
// it over another provider, without forwarding an image into a native player.
export async function probeChannelStream(stream, { fetchResource = fetch } = {}) {
  if (stream.playback?.provider !== 'zlive') return; // Tim Streams checks during resolution.
  await probeSportsStream(stream, { fetchResource: async (url, options) => {
    const { Range, ...headers } = options.headers;
    const response = await fetchResource(url, { ...options, headers });
    if (!Range || !response.ok) return response;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > ZLIVE_MEDIA_LIMIT) throw new Error('Channel video is too large.');
      chunks.push(chunk);
    }
    return new Response((await decodeZliveMedia(Buffer.concat(chunks))).subarray(0, 1024));
  } });
}
