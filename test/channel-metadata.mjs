import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import directory from '../api/channel-directory.json' with { type: 'json' };
import artwork from '../docs/channel-artwork.json' with { type: 'json' };
import { channelMetadata, channelArtwork, channelLogos } from '../api/channel-metadata.mjs';
import { liveCategories, filterLiveItems, sortLiveItems, liveCategory } from '../public/live-model.mjs';

test('the curated lineup has complete local artwork and valid category/country metadata', async () => {
  const categories = new Set(liveCategories.map(c => c.id));
  assert.equal(new Set(liveCategories.map(c => c.iptv)).size, liveCategories.length);
  assert.ok(Object.keys(directory).length >= 257);
  for (const [key, row] of Object.entries(directory)) {
    const meta = channelMetadata({ key, name: row.name, group: 'Other' });
    assert.ok(categories.has(meta.category), key); assert.ok(meta.logo, key);
    assert.match(meta.country, /^(?:[A-Z]{2}|INT)$/); assert.notEqual(meta.category_name, 'Other');
    assert.ok(meta.category_id); assert.ok(meta.region);
  }
  for (const file of channelLogos) {
    assert.match(file, /^[a-zA-Z0-9_-]+\.png$/);
    const bytes = await readFile(new URL('../public/channel-logos/' + file, import.meta.url));
    assert.deepEqual(bytes.subarray(0,8), Buffer.from('89504e470d0a1a0a','hex'), file);
    assert.ok(bytes.length < 2000000, file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artwork[file]?.sha256, file);
  }
});

test('channel identities distinguish news from sports and retain alternate feeds and regional brands', () => {
  const get = (key, name = directory[key]?.name) => channelMetadata({ key, name, group: 'Other' });
  assert.equal(get('auto-fox-news').category, 'news'); assert.equal(get('foxnews').category, 'sports');
  assert.equal(get('auto-hbo').category, 'movies'); assert.equal(get('adult-swim-test').category, 'comedy');
  assert.equal(get('auto-animal-planet').category, 'documentary'); assert.equal(get('auto-hgtv').category, 'lifestyle');
  assert.equal(get('auto-bbc-news').country, 'GB'); assert.equal(get('cbc-ca').country, 'CA');
  assert.equal(get('skysportsf1-uk3-llta', 'Sky Sports F1 FHD Backup 3').title, 'Sky Sports F1 · Backup 3');
  assert.equal(get('auto-motogp-channel').category, 'motorsports');
  assert.deepEqual(get('auto-sky-sports-cricket').topics, ['cricket']);
  const future = get('new-provider-id', 'CNN'); assert.equal(future.category, 'news'); assert.ok(future.logo);
  assert.equal(get('new-channel', 'New News Network').category, 'news');
  assert.equal(get('new-channel', 'Community Channel').category, 'entertainment');
  const art = channelArtwork({ key:'auto-cnn', name:'CNN' }, 'http://watch.local:8091/live/user/private/123.m3u8');
  assert.match(art, /^http:\/\/watch.local:8091\/channel-artwork\//); assert.ok(!art.includes('private'));
  assert.equal(channelArtwork({ key:'auto-cnn', name:'CNN' }, 'http://user:private@watch.local:8091/path?token=private'), art);
});

test('genre, country, sport and search facets keep all matching feeds reachable', () => {
  const items = Object.entries(directory).map(([key, row], i) => ({ ...channelMetadata({ key, name:row.name }), stream_id:i+1, kind:'channel', name:row.name, search_name:key }));
  items.push({ stream_id: 9999, kind:'event', provider:'sports', sport:'nba', title:'Celtics vs Raptors', starts_at:10 });
  assert.equal(filterLiveItems(items).length, items.length);
  assert.equal(liveCategories.reduce((total, c) => total + filterLiveItems(items, { category:c.id }).length, 0), items.length);
  assert.ok(filterLiveItems(items, { country:'CA' }).some(i => i.name === 'CBC'));
  assert.ok(filterLiveItems(items, { country:'GB', category:'news' }).some(i => i.name === 'BBC News'));
  assert.equal(filterLiveItems(items, { kind:'event', category:'sports', topic:'basketball' }).length, 1);
  assert.ok(filterLiveItems(items, { kind:'channel', category:'sports', topic:'soccer' }).every(i => i.topics.includes('soccer')));
  assert.ok(filterLiveItems(items, { query:'ESPN 2' }).some(i => i.name === 'ESPN2'));
  assert.ok(filterLiveItems(items, { query:'Canada' }).some(i => i.name === 'CBC'));
  assert.ok(filterLiveItems(items, { query:'cbc', country:'GB' }).length === 0);
  assert.deepEqual(sortLiveItems([{title:'ESPN10'},{title:'ESPN2'}]).map(i => i.title), ['ESPN2','ESPN10']);
  assert.deepEqual(sortLiveItems([{kind:'event', title:'A', starts_at:20}, {kind:'channel', title:'C'}, {kind:'event', title:'B', starts_at:10}]).map(i => i.title), ['C','B','A']);
  assert.ok(items.every(i => liveCategories.some(c => c.id === liveCategory(i))));
});
