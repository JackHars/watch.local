import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore } from '../api/settings.mjs';
import { settingsGroups, settingsOverview, settingsNavigation, settingsPatch } from '../public/settings-ui.mjs';
import { healthCheckMarkup, healthFailureState, suspiciousHealthDuration, healthPlayerMode } from '../public/provider-health.mjs';

test('the settings index and navigation expose only the sections a user can access', () => {
  const viewer = settingsGroups('viewer').flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(viewer, ['connections', 'account']);
  const all = settingsGroups('admin').flatMap(group => group.items.map(item => item.id));
  assert.equal(new Set(all).size, all.length);
  for (const id of ['playback', 'providers', 'health', 'live', 'general', 'updates']) assert.ok(all.includes(id));
  const icon = () => '';
  for (const html of [settingsOverview('viewer', icon), settingsNavigation('account', 'viewer', icon)]) {
    assert.doesNotMatch(html, /#settings\/(?:providers|health|users|general|updates)/);
    assert.match(html, /#settings\/connections/);
  }
  assert.match(settingsNavigation('account', 'viewer', icon), /aria-current="page"/);
});

test('health check shows each provider once and labels disabled sources', () => {
  const html = healthCheckMarkup([{ id: 'zstream', name: 'Zstream' }, { id: 'vidrift', name: 'Vidrift' }], ['zstream']);
  assert.equal((html.match(/data-health-provider=/g) || []).length, 2);
  assert.match(html, /Breaking Bad/);
  assert.match(html, /Season 1, Episode 1/);
  assert.match(html, /health-snapshot/);
  assert.doesNotMatch(html, /Play all previews/);
  assert.match(html, /data-health-provider="zstream" data-state="waiting"/);
  assert.match(html, /data-health-provider="vidrift" data-state="disabled"/);
});

test('health check separates missing sources from browser playback failures', () => {
  assert.equal(healthFailureState(false, Error('HTTP 404')), 'failed');
  assert.equal(healthFailureState(true, Error('Video timed out')), 'preview-failed');
  assert.equal(healthFailureState(true, Object.assign(Error('incompatible'), { healthCode: 'unsupported' })), 'unsupported');
  assert.equal(suspiciousHealthDuration(64), true, 'a one-minute error video is not a full episode');
  assert.equal(suspiciousHealthDuration(3482), false);
  assert.equal(suspiciousHealthDuration(Infinity), false);
});

test('health previews use Hls.js in Chrome even when native HLS is advertised', () => {
  const video = { canPlayType: () => 'maybe' }, hls = { isSupported: () => true };
  assert.equal(healthPlayerMode(video, hls, 'Google Inc.'), 'hlsjs');
  assert.equal(healthPlayerMode(video, hls, 'Apple Computer, Inc.'), 'native');
  assert.equal(healthPlayerMode(video, { isSupported: () => false }, 'Google Inc.'), 'native');
  assert.equal(healthPlayerMode({ canPlayType: () => '' }, { isSupported: () => false }, 'Google Inc.'), 'unsupported');
});

test('separate playback, provider, live and network forms preserve unrelated saved preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-settings-ui-'));
  try {
    const store = createSettingsStore(directory);
    await store.initialize();
    await store.configure({ server: { webPort80: true }, playback: { providerTimeout: 42, totalTimeout: 230, cacheSeconds: 420, quality: 'adaptive' }, live: { timstreams: false } });
    const before = structuredClone(store.config());
    const edited = { order: [...before.playback.order].reverse(), enabled: before.playback.enabled.slice(1) };
    await store.configure(settingsPatch('providers', {}, edited));
    assert.deepEqual(store.config().playback, { ...before.playback, ...edited });
    assert.deepEqual(store.config().live, before.live);
    assert.deepEqual(store.config().server, before.server);

    await store.configure(settingsPatch('playback', { quality: 'highest', providerTimeout: '20', totalTimeout: '180', cacheSeconds: '60' }));
    assert.deepEqual(store.config().playback.order, edited.order);
    assert.deepEqual(store.config().playback.enabled, edited.enabled);
    assert.equal(store.config().playback.quality, 'highest');
    assert.deepEqual(store.config().live, before.live);

    const playback = structuredClone(store.config().playback);
    await store.configure(settingsPatch('live', { liveTimstreams: 'on', liveSports: 'on' }));
    assert.deepEqual(store.config().live, { timstreams: true, sports: true, zlive: false, strmfree: false, scorezone: false, aurasports: false });
    assert.deepEqual(store.config().playback, playback);

    await store.configure(settingsPatch('general', { name: 'Living room', host: '0.0.0.0', port: '8091', publicUrl: '', webPort80: 'on', mdns: 'on', mdnsHostname: 'watch' }));
    assert.equal(store.config().server.webPort80, true);
    assert.equal(store.config().server.requireLanLogin, false);
    assert.equal(store.config().server.mdns, true);
    assert.deepEqual(store.config().playback, playback);
    assert.deepEqual(store.config().catalog, before.catalog);
    assert.deepEqual(store.config().updates, before.updates);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
