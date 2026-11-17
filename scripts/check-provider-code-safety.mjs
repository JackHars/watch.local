import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Existing bundled player ports are pinned for review. This is a regression
// tripwire, not a sandbox: new provider code must not evaluate site JavaScript
// in the Node server. Updating these pins requires deliberate security review.
const pinned = new Map([
  ['api/stellar-vm.mjs', '9512464bd1d12316c7a7bd56dc45240a7568e89c00e7a8e497613f1c44a52505'],
  ['api/zlive-resolver.mjs', '2b9ff14ac5dd531f78612e364030fb4ccf4f2bdee3f57df886d04d31bb9e512b'],
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
  const code = bytes.toString('utf8');
  // Keep new provider ports on the guarded transport. The vendored signer is
  // pinned below and receives a restricted fetch through its wrapper.
  if (rel !== 'api/public-fetch.mjs' && !rel.startsWith('api/vendor/')) {
    const executable = code.split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
    if (/\bglobalThis\.fetch\b/.test(executable) || (/\bfetch\s*\(|=\s*fetch\s*[,}]/.test(executable) && !/import\s*\{[^}]*publicFetch\s+as\s+fetch[^}]*\}\s*from\s*['"]\.\/public-fetch\.mjs['"]/.test(code))) {
      failures.push(`${rel}: outbound provider requests must use publicFetch`);
    }
  }
  if (pinned.has(rel)) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pinned.get(rel)) failures.push(`${rel}: reviewed bundled code changed`);
    continue;
  }
  const executableLines = code.split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
  if (risky.test(executableLines)) failures.push(`${rel}: dynamic code execution needs security review`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} server JavaScript files; no new dynamic provider code execution.`);
}
