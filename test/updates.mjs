import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater, githubChecks, githubRepository, command, writeJSON } from '../scripts/update-runner.mjs';
import { createUpdateControl } from '../api/updates.mjs';
import { createSettingsStore } from '../api/settings.mjs';

test('update preferences default off, migrate, validate and persist without accepting commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-update-settings-'));
  try {
    const store = createSettingsStore(directory); await store.initialize();
    assert.deepEqual(store.config().updates, { enabled: false, intervalMinutes: 5 });
    await store.configure({ updates: { enabled: true, intervalMinutes: 15 } });
    const restored = createSettingsStore(directory); await restored.initialize();
    assert.deepEqual(restored.publicConfig().updates, { enabled: true, intervalMinutes: 15 });
    for (const updates of [{ enabled: 'yes' }, { intervalMinutes: 0 }, { intervalMinutes: 1441 }, { command: 'anything' }, { repository: 'anything' }, null]) {
      await assert.rejects(store.configure({ updates }), { status: 400 });
    }
    const legacy = restored.get(); delete legacy.config.updates;
    await writeJSON(join(directory, 'iptv.json'), legacy);
    const migrated = createSettingsStore(directory); await migrated.initialize();
    assert.deepEqual(migrated.config().updates, { enabled: false, intervalMinutes: 5 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('web control exposes only public status and rejects requests when the host agent is stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchlocal-update-control-'));
  try {
    const control = createUpdateControl(directory);
    assert.equal((await control.status()).available, false);
    await assert.rejects(control.check(), { status: 503 });
    await writeJSON(join(directory, 'status.json'), { version: 1, heartbeat: Date.now(), state: 'current', current: 'a'.repeat(40), message: 'Up to date', secret: 'private-fixture' });
    assert.equal((await control.status()).available, true);
    assert.ok(!JSON.stringify(await control.status()).includes('private-fixture'));
    await control.check(); assert.ok(JSON.parse(await readFile(join(directory, 'request.json'))).id);
    await writeJSON(join(directory, 'status.json'), { version: 1, heartbeat: 1 });
    await assert.rejects(control.check(), { status: 503 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GitHub gate accepts only successful push checks for the exact main commit', async () => {
  assert.equal(githubRepository('https://github.com/JackHars/watch.local.git'), 'JackHars/watch.local');
  assert.equal(githubRepository('git@github.com:example/watch.local.git'), 'example/watch.local');
  assert.throws(() => githubRepository('https://token@github.com/example/app.git'));
  assert.throws(() => githubRepository('https://example.test/app.git'));
  const valid = { id: 1, head_sha: 'target', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
  const check = runs => githubChecks('fixture/app', 'target', async url => {
    assert.equal(url.searchParams.get('head_sha'), 'target');
    return Response.json({ workflow_runs: runs });
  });
  assert.equal(await check([valid]), 'passed');
  for (const invalid of [{ head_sha: 'other' }, { head_branch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' }]) assert.equal(await check([{ ...valid, ...invalid }]), 'pending');
  assert.equal(await check([valid, { ...valid, id: 2, conclusion: 'failure' }]), 'failed');
  await assert.rejects(githubChecks('fixture/app', 'target', async () => new Response('', { status: 403 })));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'watchlocal-updater-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), remote = join(root, 'remote.git'), repo = join(root, 'app'), data = join(root, 'data'), state = join(root, 'agent');
  const git = (cwd, ...args) => command('git', ['-C', cwd, ...args]);
  await command('git', ['init', '--bare', '--initial-branch=main', remote]);
  await command('git', ['init', '--initial-branch=main', source]);
  await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.test');
  await mkdir(join(source, 'scripts')); await writeFile(join(source, '.gitignore'), 'node_modules/\n');
  await writeFile(join(source, 'version.txt'), 'old');
  await writeFile(join(source, 'scripts/update-runner.mjs'), '// recovery runner fixture\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Initial');
  await git(source, 'remote', 'add', 'origin', remote); await git(source, 'push', 'origin', 'main');
  await command('git', ['clone', remote, repo]);
  const url = 'https://github.com/fixture/watch.local.git';
  await git(repo, 'remote', 'set-url', 'origin', url);
  await git(repo, 'config', `url.${remote}.insteadOf`, url);
  // remote get-url resolves insteadOf; record that same value for the guard, but
  // keep GitHub identity in the runner's remote config via the command adapter.
  const run = (file, args, options) => file === 'git' && args.slice(-3).join(' ') === 'remote get-url origin'
    ? Promise.resolve(url) : command(file, args, options);
  await mkdir(join(repo, 'node_modules')); await writeFile(join(repo, 'node_modules/version'), 'old');
  await mkdir(data); await writeJSON(join(data, 'iptv.json'), { config: { updates: { enabled: true, intervalMinutes: 5 } }, credential: 'private-fixture-value' });
  await writeFile(join(data, 'watch-progress.json'), '{"position":1200}', { mode: 0o600 });
  let time = 1_800_000_000_000, check = 'passed', fail = false, prepareHook = async () => {};
  const events = [], original = await git(repo, 'rev-parse', 'HEAD');
  const adapter = {
    async prepare(path) { events.push('prepare'); await mkdir(join(path, 'node_modules')); await writeFile(join(path, 'node_modules/version'), await readFile(join(path, 'version.txt'))); await prepareHook(); },
    async stop() { events.push('stop'); },
    async start() {
      events.push('start');
      if (fail && await readFile(join(repo, 'version.txt'), 'utf8') === 'new') await writeFile(join(data, 'watch-progress.json'), 'failed migration');
    },
    async healthy() { return !(fail && await readFile(join(repo, 'version.txt'), 'utf8') === 'new'); },
  };
  const updater = createUpdater({ repo, data, state, remote: url, healthUrls: [] }, { run, adapter, now: () => time, sleep: async () => {}, checks: async () => check });
  return { root, source, repo, data, state, git, updater, events, original,
    tick: () => updater.tick(), advance: () => { time += 360_000; }, fail: () => { fail = true; }, checks: result => { check = result; }, onPrepare: callback => { prepareHook = callback; },
    async enable(enabled) { const value = JSON.parse(await readFile(join(data, 'iptv.json'))); value.config.updates.enabled = enabled; await writeJSON(join(data, 'iptv.json'), value); },
    async push() { await writeFile(join(source, 'version.txt'), 'new'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Update'); await git(source, 'push', 'origin', 'main'); return git(source, 'rev-parse', 'HEAD'); },
  };
}

test('updates main, installs prepared dependencies, preserves private data and respects the interval', async t => {
  const f = await fixture(t); const target = await f.push();
  const settings = await readFile(join(f.data, 'iptv.json'), 'utf8');
  const result = await f.tick();
  assert.equal(result.state, 'updated'); assert.equal(result.current, target);
  assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), target);
  assert.equal(await readFile(join(f.repo, 'node_modules/version'), 'utf8'), 'new');
  assert.equal(await readFile(join(f.data, 'iptv.json'), 'utf8'), settings);
  assert.equal(await readFile(join(f.data, 'watch-progress.json'), 'utf8'), '{"position":1200}');
  assert.deepEqual(f.events, ['prepare', 'stop', 'start']);
  await assert.rejects(access(join(f.state, 'transaction.json')));
  await f.tick(); assert.equal(f.events.length, 3);
  f.advance(); assert.equal((await f.tick()).state, 'current');
  assert.equal(await f.git(f.repo, 'status', '--porcelain'), '');
});

test('disabled mode only checks on request and pending or failed CI never stops the server', async t => {
  const f = await fixture(t); await f.push(); await f.enable(false);
  assert.equal((await f.tick()).state, 'disabled');
  await writeJSON(join(f.data, 'updates/request.json'), { id: 'manual' });
  assert.equal((await f.tick()).state, 'available');
  await f.enable(true); f.checks('pending'); assert.equal((await f.tick()).state, 'waiting_checks');
  f.advance(); f.checks('failed'); assert.equal((await f.tick()).state, 'checks_failed');
  assert.deepEqual(f.events, []); assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), f.original);
});

test('local edits and divergent commits are preserved; disabling during preparation cancels installation', async t => {
  const f = await fixture(t); await f.push();
  await writeFile(join(f.repo, 'version.txt'), 'local edit');
  assert.match((await f.tick()).message, /local changes/); assert.deepEqual(f.events, []);
  await f.git(f.repo, 'restore', 'version.txt'); f.advance();
  f.onPrepare(() => f.enable(false)); assert.equal((await f.tick()).state, 'available'); assert.deepEqual(f.events, ['prepare']);
  await f.enable(true);
  await writeFile(join(f.repo, 'local.txt'), 'local commit'); await f.git(f.repo, 'add', '.');
  await f.git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Local work');
  f.advance(); assert.match((await f.tick()).message, /diverged/);
  assert.equal(await readFile(join(f.repo, 'local.txt'), 'utf8'), 'local commit');
});

test('failed startup restores code, dependencies and watch history, then quarantines the failed commit', async t => {
  const f = await fixture(t); const target = await f.push(); f.fail();
  assert.equal((await f.tick()).state, 'rolled_back');
  assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), f.original);
  assert.equal(await readFile(join(f.repo, 'node_modules/version'), 'utf8'), 'old');
  assert.equal(await readFile(join(f.data, 'watch-progress.json'), 'utf8'), '{"position":1200}');
  assert.equal(JSON.parse(await readFile(join(f.data, 'iptv.json'))).credential, 'private-fixture-value');
  const count = f.events.length; f.advance(); const result = await f.tick();
  assert.equal(result.failedCommit, target); assert.equal(result.state, 'rolled_back'); assert.equal(f.events.length, count);
});

test('preparation failures leave the running installation untouched', async t => {
  const f = await fixture(t); await f.push();
  f.onPrepare(async () => { throw new Error('Dependency preparation failed.'); });
  assert.equal((await f.tick()).state, 'error');
  assert.deepEqual(f.events, ['prepare']);
  assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), f.original);
  assert.equal(await readFile(join(f.repo, 'node_modules/version'), 'utf8'), 'old');
  await assert.rejects(access(join(f.state, 'transaction.json')));
});

test('an interrupted backup keeps live data and does not restore a partial snapshot', async t => {
  const f = await fixture(t); const target = await f.push();
  await mkdir(join(f.state, 'backup/data'), { recursive: true });
  await writeFile(join(f.state, 'backup/data/watch-progress.json'), 'partial snapshot');
  await writeJSON(join(f.state, 'transaction.json'), { previous: f.original, target, phase: 'prepared' });
  assert.equal((await f.tick()).state, 'rolled_back');
  assert.equal(await readFile(join(f.data, 'watch-progress.json'), 'utf8'), '{"position":1200}');
  assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), f.original);
});

test('a journal left by an interrupted process recovers before checking preferences or fetching', async t => {
  const f = await fixture(t); const target = await f.push();
  await mkdir(join(f.state, 'backup'), { recursive: true });
  await cp(f.data, join(f.state, 'backup/data'), { recursive: true });
  await rename(join(f.repo, 'node_modules'), join(f.state, 'backup/node_modules'));
  await f.git(f.repo, 'fetch', 'origin'); await f.git(f.repo, 'merge', '--ff-only', target);
  await mkdir(join(f.repo, 'node_modules')); await writeFile(join(f.repo, 'node_modules/version'), 'broken');
  await f.enable(false); await writeFile(join(f.data, 'watch-progress.json'), 'interrupted migration');
  await writeJSON(join(f.state, 'transaction.json'), { previous: f.original, target, phase: 'backed_up' });
  assert.equal((await f.tick()).state, 'rolled_back');
  assert.deepEqual(f.events, ['stop', 'start']);
  assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), f.original);
  assert.equal(await readFile(join(f.repo, 'node_modules/version'), 'utf8'), 'old');
  assert.equal(await readFile(join(f.data, 'watch-progress.json'), 'utf8'), '{"position":1200}');
});
