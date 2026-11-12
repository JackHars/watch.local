import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createUpdateRepair, sudoTerminal } from '../api/update-repair.mjs';
import { launchRepair, runRepair, validateRepairJob, transientRepairCommand } from '../scripts/repair-updater.mjs';
import { writeJSON } from '../scripts/update-runner.mjs';

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'watchlocal-repair-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), directory = join(data, 'updates/repair');
  await mkdir(data);
  const user = { id: 'admin', version: 3, enabled: true, role: 'admin' };
  const target = { repo: root, service: 'watchlocal.service', username: 'fixture', uid: process.getuid(), gid: process.getgid() };
  const children = [], passwords = [];
  let clock = Date.now();
  const options = { now: () => clock, target: async () => target, account: () => user, terminal: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', chunk => passwords.push(chunk.toString()));
    child.kill = () => { child.killed = true; }; children.push(child); return child;
  } };
  const repair = createUpdateRepair(directory, options);
  return { root, data, directory, target, user, options, repair, children, passwords, advance: value => { clock += value; } };
}

test('repair sends one password per sudo prompt, rejects control input and never records or returns secrets', async t => {
  const f = await fixture(t), session = await f.repair.start(f.user, f.data), child = f.children[0];
  child.stdout.write('private terminal text');
  child.stdout.write('watchlocal-sudo-'); child.stdout.write('password:'); await settle();
  let status = await f.repair.status(session.id, session.token);
  assert.equal(status.waitingForPassword, true); assert.equal(status.prompt, 1); assert.doesNotMatch(status.output, /private terminal text/);
  await assert.rejects(f.repair.password(session.id, session.token, { password: 'escape\u0003', prompt: 1 }, f.user), { status: 400 });
  await assert.rejects(f.repair.password(session.id, session.token, { password: 'line\nbreak', prompt: 1 }, f.user), { status: 400 });
  const input = { password: 'fixture-password-with-$;quotes', prompt: 1 };
  const attempts = await Promise.allSettled([f.repair.password(session.id, session.token, input, f.user), f.repair.password(session.id, session.token, { ...input }, f.user)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(input.password, '');
  assert.deepEqual(f.passwords, ['fixture-password-with-$;quotes\n']);
  await assert.rejects(f.repair.password(session.id, session.token, { password: 'duplicate', prompt: 1 }, f.user), { status: 409 });
  child.stderr.write('Sorry, try again.\nwatchlocal-sudo-password:'); await settle();
  status = await f.repair.status(session.id, session.token); assert.equal(status.prompt, 2); assert.match(status.message, /not accepted/);
  await assert.rejects(f.repair.password(session.id, session.token, { password: 'stale', prompt: 1 }, f.user), { status: 409 });
  for (const file of await readdir(join(f.directory, session.id))) {
    const text = await readFile(join(f.directory, session.id, file), 'utf8');
    assert.ok(!text.includes('fixture-password-with-$;quotes')); assert.ok(!text.includes(session.token));
    assert.equal((await stat(join(f.directory, session.id, file))).mode & 0o777, 0o600);
  }
  assert.ok(!JSON.stringify(status).includes('fixture-password-with-$;quotes'));
  await f.repair.cancel(session.id, session.token, f.user);
});

test('job capabilities are scoped, revocable and expire; concurrent repair and unauthorized input are rejected', async t => {
  const f = await fixture(t), session = await f.repair.start(f.user, f.data);
  await assert.rejects(f.repair.status(session.id, 'a'.repeat(43)), { status: 403 });
  await assert.rejects(f.repair.status('../outside', session.token), { status: 403 });
  await assert.rejects(f.repair.password(session.id, session.token, {}, { id: 'other' }), { status: 403 });
  await assert.rejects(f.repair.start(f.user, f.data), { status: 429 });
  f.advance(16_000); await assert.rejects(f.repair.start(f.user, f.data), { status: 409 });
  f.user.version++; await assert.rejects(f.repair.status(session.id, session.token), { status: 403 }); f.user.version--;
  f.user.enabled = false; await assert.rejects(f.repair.status(session.id, session.token), { status: 403 }); f.user.enabled = true;
  await f.repair.cancel(session.id, session.token, f.user);
  assert.equal(f.children[0].killed, true); assert.equal((await f.repair.status(session.id, session.token)).state, 'cancelled');
  f.advance(36 * 60_000); await assert.rejects(f.repair.status(session.id, session.token), { status: 403 });
});

test('status survives replacement of the web process; closed sudo does not overwrite the independent worker', async t => {
  const f = await fixture(t), session = await f.repair.start(f.user, f.data);
  const file = join(f.directory, session.id, 'status.json');
  await writeJSON(file, { state: 'running', message: 'Installing the timer', output: 'Sudo accepted\n', updatedAt: Date.now() });
  f.children[0].emit('close', 0); await settle();
  assert.equal((await f.repair.status(session.id, session.token)).state, 'running');
  const restarted = createUpdateRepair(f.directory, f.options);
  assert.equal((await restarted.status(session.id, session.token)).message, 'Installing the timer');
  await writeJSON(file, { state: 'complete', message: 'Done', updatedAt: Date.now() });
  assert.equal((await restarted.status(session.id, session.token)).state, 'complete');
});

test('abandoned authentication expires and a restart before authorization produces a retryable error', async t => {
  const f = await fixture(t);
  const short = createUpdateRepair(f.directory, { ...f.options, authTimeout: 20 });
  const first = await short.start(f.user, f.data); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await short.status(first.id, first.token)).state, 'error'); assert.equal(f.children[0].killed, true);
  const next = createUpdateRepair(f.directory, f.options), session = await next.start(f.user, f.data);
  const restarted = createUpdateRepair(f.directory, f.options);
  assert.match((await restarted.status(session.id, session.token)).message, /restarted before sudo/);
  await next.cancel(session.id, session.token, f.user);
});

test('real PTY disables input echo, uses no input log and exits instead of opening an interactive shell', async t => {
  const f = await fixture(t), program = join(f.root, 'prompt.mjs');
  await writeFile(program, "process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write('accepted\\n');process.exit(0)});\n");
  let invocation;
  const child = sudoTerminal("/tmp/fixed ' path/$HOME;false", { spawnProcess: (file, args, options) => {
    invocation = { file, args, options }; const testArgs = [...args];
    testArgs[testArgs.indexOf('--command') + 1] = `exec '${process.execPath}' '${program}'`;
    return spawn(file, testArgs, options);
  } });
  let output = ''; child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
  await once(child.stdout, 'data'); child.stdin.write('not-for-the-log\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(output, /accepted/); assert.doesNotMatch(output, /not-for-the-log/);
  assert.equal(invocation.file, '/usr/bin/script'); assert.ok(invocation.args.includes('--echo=never'));
  assert.equal(invocation.args.at(-1), '/dev/null'); assert.ok(invocation.args.includes('--return'));
  const command = invocation.args[invocation.args.indexOf('--command') + 1];
  assert.match(command, /^exec '\/usr\/bin\/sudo' '-k'/); assert.match(command, /'--launch'/);
  assert.ok(!invocation.args.includes('--log-in')); assert.ok(!invocation.args.includes('--log-io'));
});

test('sudo handoff validates the service owner and copies the worker outside the checkout before launching a separate unit', async t => {
  const f = await fixture(t), session = await f.repair.start(f.user, f.data);
  await f.repair.cancel(session.id, session.token, f.user);
  const directory = join(f.directory, session.id), commands = [], reports = [];
  let ownerUid = process.getuid();
  const run = async (file, args) => {
    commands.push([file, args]);
    if (file === '/usr/bin/systemctl') return `LoadState=loaded\nUser=fixture\nWorkingDirectory=${f.root}`;
    if (file === '/usr/bin/getent') return `fixture:x:${ownerUid}:${process.getgid()}:Fixture:${f.root}:/bin/bash`;
    if (file === '/usr/bin/systemd-run') return '';
    assert.fail(file);
  };
  await validateRepairJob(directory, { run, sudoUid: process.getuid() });
  await assert.rejects(validateRepairJob(directory, { run, sudoUid: process.getuid() + 1 }), /ownership/);
  ownerUid++; await assert.rejects(validateRepairJob(directory, { run, sudoUid: process.getuid() }), /user authorizing/); ownerUid--;
  const originalUid = process.env.SUDO_UID; process.env.SUDO_UID = String(process.getuid());
  try { await launchRepair(directory, { run, root: f.root, report: async (...args) => reports.push(args) }); }
  finally { if (originalUid === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = originalUid; }
  assert.equal(reports[0][2].state, 'running');
  const [, args] = commands.find(([file]) => file === '/usr/bin/systemd-run');
  assert.ok(args.includes('--service-type=exec')); assert.ok(args.includes('--collect')); assert.ok(!args.includes('--scope')); assert.ok(!args.includes('--wait'));
  const snapshot = args.at(-1), manifest = await readFile(join(snapshot, 'job.json'), 'utf8');
  assert.notEqual(snapshot, directory); assert.ok(!manifest.includes('tokenHash')); assert.ok(!manifest.includes(session.token));
  assert.ok((await readFile(join(snapshot, 'install-updater.mjs'), 'utf8')).includes('installUpdater'));
  assert.equal((await stat(join(snapshot, 'job.json'))).mode & 0o777, 0o600);
  const [, escaped] = transientRepairCommand('/run/$TEST', session.id, '/opt/$NODE/bin/node');
  assert.ok(escaped.includes('/opt/$$NODE/bin/node'));
});

test('repair reports success only after installer, independent timer and both health endpoints are ready', async t => {
  const f = await fixture(t), snapshot = join(f.root, 'snapshot'); await mkdir(snapshot);
  const job = { ...f.target, directory: f.directory, data: f.data, home: f.root };
  await writeJSON(join(snapshot, 'job.json'), job);
  const revision = 'a'.repeat(40), reports = [], commands = [], health = [], urls = ['http://127.0.0.1:8091/health', 'http://127.0.0.1:80/health'];
  await writeJSON(join(f.root, '.local/state/watchlocal-updater/host-config.json'), { healthUrls: urls });
  const run = async (file, args) => {
    commands.push([file, args]);
    if (args.includes('rev-parse')) return revision;
    if (args[0] === 'is-active') return 'active';
    if (args[0] === 'show') return args[1].endsWith('.timer') ? 'active' : 'inactive';
    return '';
  };
  const install = async (options, dependencies) => {
    assert.equal(options.enable, true); assert.equal(options['system-service'], 'watchlocal.service');
    await dependencies.run('/usr/bin/systemctl', ['stop', 'watchlocal.service']);
    await dependencies.run('/usr/bin/systemctl', ['start', 'watchlocal-update.service']);
    await writeJSON(join(f.data, 'updates/status.json'), { state: 'current' });
  };
  const dependencies = { run, install, report: async (_, __, value) => reports.push(value), fetcher: async url => { health.push(url); return Response.json({ ok: true, application: 'watchlocal', revision }); }, pause: async () => {} };
  await runRepair(snapshot, dependencies);
  assert.equal(reports.at(-1).state, 'complete'); assert.deepEqual(health, urls);
  assert.ok(reports.some(value => value.message.includes('browser will reconnect')));
  await runRepair(snapshot, { ...dependencies, fetcher: async () => Response.json({ ok: true, application: 'watchlocal', revision: 'b'.repeat(40) }) });
  assert.equal(reports.at(-1).state, 'error'); assert.match(reports.at(-1).message, /not restarted successfully/);
  await runRepair(snapshot, { ...dependencies, install: async () => { throw Error('Local changes must be saved first.'); } });
  assert.equal(reports.at(-1).state, 'error'); assert.match(reports.at(-1).message, /Local changes/);
  assert.ok(commands.some(([file, args]) => file.endsWith('systemctl') && args.join(' ') === 'start watchlocal-update.timer'));
});
