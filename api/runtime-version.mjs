import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

// No Git executable is needed in the application container. Capture the loaded
// revision once; reading HEAD on every health check would disguise a stale process.
export async function readRevision(repo = root) {
  try {
    let git = join(repo, '.git');
    if ((await stat(git)).isFile()) {
      const pointer = (await readFile(git, 'utf8')).trim();
      if (!pointer.startsWith('gitdir: ')) return null;
      git = resolve(repo, pointer.slice(8));
    }
    const head = (await readFile(join(git, 'HEAD'), 'utf8')).trim();
    if (sha.test(head)) return head;
    if (!/^ref: refs\/[\w./-]+$/.test(head) || head.includes('..')) return null;
    const ref = head.slice(5);
    let common = git;
    try { common = resolve(git, (await readFile(join(git, 'commondir'), 'utf8')).trim()); } catch { /* ordinary checkout */ }
    for (const directory of new Set([git, common])) {
      try {
        const revision = (await readFile(join(directory, ref), 'utf8')).trim();
        if (sha.test(revision)) return revision;
      } catch { /* packed refs or a linked worktree */ }
      try {
        const line = (await readFile(join(directory, 'packed-refs'), 'utf8')).split('\n').find(line => line.endsWith(' ' + ref));
        if (line && sha.test(line.split(' ')[0])) return line.split(' ')[0];
      } catch { /* archive installations may not have Git metadata */ }
    }
  } catch { /* Git metadata is optional outside managed installations. */ }
  return null;
}

export const runningRevision = await readRevision();
