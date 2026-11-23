import directory from './channel-directory.json' with { type: 'json' };
import { liveCategories, countryName, normalizeLiveSearch } from '../public/live-model.mjs';

const categoryByID = new Map(liveCategories.map(category => [category.id, category]));
const channelsByKey = new Map(Object.entries(directory));
const channelsByName = Map.groupBy(channelsByKey.values(), item => normalizeLiveSearch(item.name));
export const channelLogos = new Set(Object.values(directory).map(item => item.logo));
export const channelCategories = liveCategories;

function directoryChannel(channel, flag) {
  // Cross-listed feeds use the same regional slug, with an auto- prefix in ZLive.
  const timstreams = channel.provider === 'timstreams';
  const match = channelsByKey.get(timstreams ? `auto-${channel.key}` : channel.key);
  if (match && (!timstreams || !flag || match.country === flag)) return match;

  const candidates = channelsByName.get(normalizeLiveSearch(channel.name));
  if (!candidates) return;
  if (flag) return candidates.find(item => item.country === flag);
  if (candidates.every(item => item.country === candidates[0].country)) return candidates[0];
}

export function channelMetadata(channel) {
  const flag = /^[a-z]{2}$/i.test(channel.flag || '') ? channel.flag.toUpperCase() : '';
  const known = directoryChannel(channel, flag);
  const name = known?.name || channel.name;
  const category = known?.category || (categoryByID.has(channel.category) ? channel.category : null) || (/\bf1\b|motogp|motorsport/i.test(channel.name) || channel.group === 'F1' ? 'motorsports'
    : /news|weather|bloomberg/i.test(channel.name) ? 'news'
    : /\bkids\b|cartoon|nickelodeon|disney|treehouse/i.test(channel.name) || channel.group === 'Kids' ? 'kids'
    : /sport|\bespn\b|\btsn\b/i.test(channel.name) || channel.group === 'Sports' ? 'sports'
    : /documentar|discovery|nature|animal planet/i.test(channel.name) ? 'documentary'
    : /cinema|movies|\bhbo\b|showtime|starz/i.test(channel.name) ? 'movies' : 'entertainment');
  const country = known?.country || flag || 'INT';
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
