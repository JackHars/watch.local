import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Existing bundled player ports are pinned for review. This is a regression
// tripwire, not a sandbox: new provider code must not evaluate site JavaScript
// in the Node server. Updating these pins requires deliberate security review.
const pinned = new Map([
  ['api/stellar-vm.mjs', '8b66d64fd2078fb18821cee3d7a79b34017e3e6c24d8a59181d294ab5f19a71e'],
  ['api/zlive-resolver.mjs', 'dd0cd2793aba02ff7f20223bddfdd71dd013282d7fac887d8904cc4b5d7eafd3'],
  ['api/vendor/zlive-resolver.cjs', 'e021707d162b8c359eaa1ff944fb862cee61a2d130e9e410106fe0dfcfc2f07d'],
]);
const root = resolve(import.meta.dirname, '..');
const api = join(root, 'api');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(path);
  }
}
walk(api);

const risky = /\bnew\s+Function\s*\(|\beval\s*\(|\b(?:from|import\s*\()\s*['"]node:vm['"]|\b(?:runInContext|runInNewContext|runInThisContext)\s*\(/;
const failures = [];
for (const path of files) {
  const rel = relative(root, path);
  const bytes = readFileSync(path);
  if (pinned.has(rel)) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pinned.get(rel)) failures.push(`${rel}: reviewed bundled code changed`);
    continue;
  }
  const code = bytes.toString('utf8');
  const executableLines = code.split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
  if (risky.test(executableLines)) failures.push(`${rel}: dynamic code execution needs security review`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} server JavaScript files; no new dynamic provider code execution.`);
}
