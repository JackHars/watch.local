import directory from './channel-directory.json' with { type: 'json' };
import { liveCategories, countryName, normalizeLiveSearch } from '../public/live-model.mjs';

const categoryByID = new Map(liveCategories.map(category => [category.id, category]));
const names = new Map(Object.values(directory).map(item => [normalizeLiveSearch(item.name), item]));
export const channelLogos = new Set(Object.values(directory).map(item => item.logo));
export const channelCategories = liveCategories;

// These identities describe broadcasters, not stream availability. Keep the
// provider's numeric IDs and alternate feeds; enrich old caches on read too.
export function channelMetadata(channel) {
  const known = (channel.provider === 'timstreams' ? null : directory[channel.key]) || names.get(normalizeLiveSearch(channel.name));
  const name = known?.name || channel.name;
  const category = known?.category || (categoryByID.has(channel.category) ? channel.category : null) || (/\bf1\b|motogp|motorsport/i.test(channel.name) || channel.group === 'F1' ? 'motorsports'
    : /news|weather|bloomberg/i.test(channel.name) ? 'news'
    : /\bkids\b|cartoon|nickelodeon|disney|treehouse/i.test(channel.name) || channel.group === 'Kids' ? 'kids'
    : /sport|\bespn\b|\btsn\b/i.test(channel.name) || channel.group === 'Sports' ? 'sports'
    : /documentar|discovery|nature|animal planet/i.test(channel.name) ? 'documentary'
    : /cinema|movies|\bhbo\b|showtime|starz/i.test(channel.name) ? 'movies' : 'entertainment');
  const country = known?.country || (/^[a-z]{2}$/i.test(channel.flag || '') ? channel.flag.toUpperCase() : 'INT');
  const variant = channel.name.match(/\bBackup(?:\s+\d+)?/i)?.[0] || '';
  const definition = categoryByID.get(category);
  return { name, title: variant ? `${name} · ${variant}` : name, category, category_name: definition.name, category_id: definition.iptv,
    country, region: countryName(country), topics: known?.topics || [], logo: known?.logo || '',
    white_logo: Boolean(known?.white_logo), logo_plate: Boolean(known?.logo_plate), accent: definition.color };
}

export function channelArtwork(channel, base) {
  const logo = channelMetadata(channel).logo;
  if (!logo) return '';
  const path = '/channel-artwork/' + logo;
  try { return new URL(path, new URL(base).origin).href; } catch { return path; }
}
