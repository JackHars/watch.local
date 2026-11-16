import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStellarResolver } from '../api/stellar.mjs';
import { extractEn } from '../api/stellar-vm.mjs';

// Stellar (stellar.rip / vidfast.vc) fixture — mirrors the live-verified
// contract (evidence artifact 7cf2a1329b1b, re-verified live 2026-11-16):
//
//   * the player domain vidfast.vc (Cloudflare) answers the per-title SSR
//     player page only for a browser UA plus a stellar.rip Referer;
//   * the page carries a one-shot `en` envelope; the bundled bytecode-VM
//     client (ported into api/stellar-vm.mjs, run via node:vm) scans it
//     into a 4-source roster and decodes each source into a descriptor
//     { url, tmdbId, title, noReferrer } pointing at a short-lived signed
//     fMP4 HLS master on the site's media CDN (keyless: ftyp init, moof
//     segments, no #EXT-X-KEY);
//   * the envelope is one-shot and unknown ids still answer 200 with a
//     valid envelope, so the resolver gates every source on the decoded
//     descriptor echoing the exact requested tmdbId + a non-empty title,
//     then validates the media through the shared ctx.accept byte gate;
//   * the media CDN wants a browser UA, Referer required unless the
//     descriptor's noReferrer flag says otherwise;
//   * the unit tests drive the resolver with an injected fake VM; the
//     real VM + live media are exercised by the live canary
//     (scripts/check-providers-live.mjs --provider stellar).
const PLAYER = 'https://vidfast.vc';
const UA_RE = /Mozilla\/5\.0/;

const mediaUrl = (n) =>
  `https://moon.goldenkite.top/vd/fixture-key-${n}/master.m3u8?sig=fixture${n}`;

const ROSTER = ['vRapid', 'vBlaze', 'Cobra', 'Bravo'].map((name, i) => ({
  name,
  data: `fixture-data-${i}`,
}));

function fakeCtx({ mediaFails = 0 } = {}) {
  const calls = { text: [], accept: [] };
  let fails = mediaFails;
  const ctx = {
    text: async (url, headers, opts) => {
      calls.text.push({ url, headers, opts });
      return '<html>player page</html>';
    },
    accept: async (url, headers, source, opts) => {
      calls.accept.push({ url, headers, source, opts });
      if (fails-- > 0) throw new Error(`media gate rejected ${source}`);
      return { stream: `stream:${source}` };
    },
    signal: {},
  };
  return { ctx, calls };
}

function fakeVm({ identity = null, mediaOk = true, decodeFails = 0, scanError = null } = {}) {
  let calls = [];
  let n = 0;
  return {
    calls: () => calls,
    scanPage: async () => {
      if (scanError) throw new Error(scanError);
      return ROSTER;
    },
    decodeSource: async (src, path) => {
      calls.push({ name: src.name, path });
      if (n++ < decodeFails) throw new Error(`decoder failed for ${src.name}`);
      const tmdbId = identity ? identity(src.name) : 1368337;
      return {
        url: mediaUrl(n),
        tmdbId,
        title: tmdbId === 1368337 ? 'The Odyssey' : 'Some Other Title',
        noReferrer: src.name === 'Bravo',
      };
    },
  };
}

test('movie: player page fetch, roster scan, identity gate, and media accept all use the verified contract', async () => {
  const vm = fakeVm();
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  const out = await resolve({ kind: 'movie', tmdb: 1368337 }, ctx);

  // player page: browser UA + stellar referer, exact path and query
  assert.equal(calls.text.length, 1);
  const t = calls.text[0];
  assert.equal(
    t.url,
    `${PLAYER}/movie/1368337?autoplay=true&autoNext=true&theme=4f46e5&server=alfa`,
  );
  assert.match(t.headers['user-agent'], UA_RE);
  assert.equal(t.headers.referer, 'https://stellar.rip/');
  assert.ok(t.opts.timeout > 0 && t.opts.limit > 0);

  // first source decodes clean and is accepted
  assert.deepEqual(vm.calls(), [{ name: 'vRapid', path: '/movie/1368337' }]);
  assert.equal(calls.accept.length, 1);
  const a = calls.accept[0];
  assert.equal(a.url, mediaUrl(1));
  assert.match(a.headers['user-agent'], UA_RE);
  assert.equal(a.headers.referer, 'https://vidfast.vc/');
  assert.equal(a.source, 'stellar:vRapid');
  assert.deepEqual(a.opts, { minDuration: 180 });
  assert.deepEqual(out, { stream: 'stream:stellar:vRapid' });
});

test('series: exact season/episode path seeds the chain; noReferrer drops the referer on media hops', async () => {
  const vm = fakeVm({
    identity: () => 1400,
  });
  // force the noReferrer source (Bravo) to be the one that wins by making
  // the earlier sources' decodes fail.
  vm.decodeSource = async (src, path) => {
    vm.__calls = (vm.__calls || []).concat({ name: src.name, path });
    if (src.name !== 'Bravo') throw new Error(`decoder failed for ${src.name}`);
    return { url: mediaUrl(99), tmdbId: 1400, title: 'Seinfeld', noReferrer: true };
  };
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  const out = await resolve(
    { kind: 'series', tmdb: 1400, season: 1, episode: 2 },
    ctx,
  );

  assert.equal(
    calls.text[0].url,
    `${PLAYER}/tv/1400/1/2?autoplay=true&autoNext=true&theme=4f46e5&server=alfa`,
  );
  assert.equal(vm.__calls.length, 4);
  for (const c of vm.__calls) assert.equal(c.path, '/tv/1400/1/2');
  assert.equal(calls.accept.length, 1);
  const a = calls.accept[0];
  assert.equal(a.url, mediaUrl(99));
  assert.match(a.headers['user-agent'], UA_RE);
  assert.equal(a.headers.referer, undefined, 'noReferrer must omit the referer');
  assert.equal(a.source, 'stellar:Bravo');
  assert.deepEqual(out, { stream: 'stream:stellar:Bravo' });
});

test('identity gate: a decoder that echoes a different tmdbId is rejected without a media hop', async () => {
  const vm = fakeVm({
    identity: (name) => (name === 'vRapid' ? 9999999 : 1368337),
  });
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  const out = await resolve({ kind: 'movie', tmdb: 1368337 }, ctx);

  // vRapid (wrong id) never reaches accept; vBlaze (right id) wins.
  assert.equal(calls.accept.length, 1);
  assert.equal(calls.accept[0].source, 'stellar:vBlaze');
  assert.deepEqual(out, { stream: 'stream:stellar:vBlaze' });
});

test('identity gate: when every source mismatches, the error names the mismatch and no media is accepted', async () => {
  const vm = fakeVm({ identity: () => 424242 });
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  await assert.rejects(
    () => resolve({ kind: 'movie', tmdb: 1368337 }, ctx),
    (error) => {
      assert.match(error.message, /identity mismatch/);
      return true;
    },
  );
  assert.equal(calls.accept.length, 0);
});

test('no sources from the scanner: honest failure, no decode, no media', async () => {
  const vm = {
    scanPage: async () => [],
    decodeSource: async () => {
      throw new Error('decode must not run');
    },
  };
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  await assert.rejects(
    () => resolve({ kind: 'movie', tmdb: 1368337 }, ctx),
    /no sources/,
  );
  assert.equal(calls.accept.length, 0);
});

test('scan failure (missing envelope / stale build) surfaces as an honest no-playable-source error', async () => {
  const vm = fakeVm({ scanError: 'no en envelope in player page (page layout changed?)' });
  const { ctx, calls } = fakeCtx();
  const resolve = createStellarResolver(vm);
  await assert.rejects(
    () => resolve({ kind: 'series', tmdb: 1400, season: 1, episode: 1 }, ctx),
    (error) => {
      assert.match(error.message, /source scan failed/);
      assert.match(error.message, /no en envelope/);
      return true;
    },
  );
  assert.equal(calls.accept.length, 0);
});

test('player page fetch failure fails honestly before any scan', async () => {
  const { ctx, calls } = fakeCtx();
  ctx.text = async () => {
    throw new Error('HTTP 403');
  };
  const vm = fakeVm();
  const resolve = createStellarResolver(vm);
  await assert.rejects(
    () => resolve({ kind: 'movie', tmdb: 1368337 }, ctx),
    (error) => {
      assert.match(error.message, /player page fetch failed/);
      assert.match(error.message, /HTTP 403/);
      return true;
    },
  );
  assert.equal(calls.accept.length, 0);
});

test('media failover: a source whose media fails the byte gate falls through to the next source', async () => {
  const vm = fakeVm({ mediaOk: true });
  const { ctx, calls } = fakeCtx({ mediaFails: 2 });
  const resolve = createStellarResolver(vm);
  const out = await resolve({ kind: 'movie', tmdb: 1368337 }, ctx);
  assert.equal(calls.accept.length, 3);
  assert.deepEqual(
    calls.accept.map((a) => a.source),
    ['stellar:vRapid', 'stellar:vBlaze', 'stellar:Cobra'],
  );
  assert.deepEqual(out, { stream: 'stream:stellar:Cobra' });
});

test('every source failing the media gate produces a combined error (bounded to 3)', async () => {
  const vm = fakeVm();
  const { ctx, calls } = fakeCtx({ mediaFails: 99 });
  const resolve = createStellarResolver(vm);
  await assert.rejects(
    () => resolve({ kind: 'movie', tmdb: 1368337 }, ctx),
    (error) => {
      assert.match(error.message, /no playable source/);
      // bounded error list: max 3 entries
      const parts = error.message.split('; ');
      assert.ok(parts.length <= 4, `too many parts: ${parts.length}`);
      return true;
    },
  );
  assert.equal(calls.accept.length, 4, 'roster is bounded to 4 sources');
});

test('extractEn: pulls the RSC-escaped envelope; rejects lookalike keys and short values', () => {
  // RSC flight payload escapes quotes: "en\":\"TOKEN"
  const page1 = 'self.__next_f.push([1,"a: {\\"text\\":\\"en\\":\\"AbCdEfGh1234567890XY\\"}"])';
  assert.equal(extractEn(page1), 'AbCdEfGh1234567890XY');

  // a lookalike key (open) must not match
  const page2 = 'self.__next_f.push([1,"a: {\\"text\\":\\"open\\":\\"AbCdEfGh1234567890XY\\"}"])';
  assert.equal(extractEn(page2), null);

  // values under 20 chars are not envelopes
  const page3 = 'self.__next_f.push([1,"a: {\\"text\\":\\"en\\":\\"AbCdEf\\"}"])';
  assert.equal(extractEn(page3), null);

  // no envelope at all
  assert.equal(extractEn('<html><body>nothing</body></html>'), null);
});
