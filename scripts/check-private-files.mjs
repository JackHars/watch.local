import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { defaultConfig } from '../api/settings.mjs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const privatePath = /(?:^|\/)(?:data|private|backups|\.runtime)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|config(?:\.[^/]*)?\.json|iptv[^/]*\.json|watch-progress[^/]*\.json)$|\.(?:pem|key|p12|pfx|sqlite\w*|db)$/i;
const unsafe = files.filter(file => privatePath.test(file));
assert.deepEqual(unsafe, [], 'Private runtime files must not be tracked');
assert.equal(defaultConfig().metadata.tmdbCredential, '', 'TMDB must not ship with a default credential');
assert.equal(defaultConfig().metadata.tmdbFallback, false, 'TMDB must be opt-in');
console.log(`Checked ${files.length} tracked paths; no private runtime files, no default TMDB credential.`);
