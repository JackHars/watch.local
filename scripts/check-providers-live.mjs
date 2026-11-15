// Public upstream smoke checks. Run in a separate GitHub job from fixture tests:
// an upstream outage should be visible without making unit tests nondeterministic.
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never load a server's saved provider settings or metadata credentials in CI.
process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'watch-provider-health-'));

const { PROVIDERS } = await import('../api/providers.mjs');
const { defaultConfig } = await import('../api/settings.mjs');
const liveProviders = Object.keys(defaultConfig().live);
const supportedLive = ['sports', 'zlive', 'timstreams', 'strmfree'];
if (liveProviders.length !== supportedLive.length || liveProviders.some(id => !supportedLive.includes(id))) {
  throw new Error('Live provider health checks must cover every configured live provider.');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--matrix') {
  console.log(JSON.stringify({ include: [
    ...PROVIDERS.map(provider => ({ kind: 'vod', provider })),
    ...liveProviders.map(provider => ({ kind: 'live', provider })),
  ] }));
  process.exit(0);
}
if (args.length !== 4 || args[0] !== '--kind' || args[2] !== '--provider') {
  console.error('Usage: node scripts/check-providers-live.mjs --kind vod|live --provider ID');
  process.exit(2);
}
const [, kind, , provider] = args;
if (!(kind === 'vod' ? PROVIDERS : liveProviders).includes(provider)) {
  console.error('Unknown provider for this check kind.');
  process.exit(2);
}

function reason(error) {
  // Upstream errors can contain signed URLs and tokens. Keep CI logs free of them.
  const value = String(error?.provider_errors?.[provider] || error?.message || error);
  const http = value.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) return `HTTP ${http[1]}`;
  if (/timed?\s*out|timeout|aborted|cancelled/i.test(value)) return 'timeout';
  if (/format changed|layout changed|decrypt|cipher|key function/i.test(value)) return 'provider protocol changed';
  if (/playlist|segment|video|HLS|media/i.test(value)) return 'media validation failed';
  if (/no (?:playable )?(?:source|stream|feed|broadcast)/i.test(value)) return 'no source';
  return 'upstream resolution failed';
}
const healthFailure = message => Object.assign(new Error(message), { healthCheck: true });
const runnerBlocked = message => Object.assign(new Error(message), { runnerBlocked: true });
function summary(status, detail) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${provider}\n\n**${status}** — ${detail}\n`);
  }
}

function validURL(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

async function checkVod(id) {
  const { resolveStream } = await import('../api/platform.mjs');
  const defaultSamples = {
    movie: [{ tmdb: 9384 }, { tmdb: 550 }],
    series: [{ tmdb: 63333, season: 1, episode: 1 }, { tmdb: 1399, season: 1, episode: 1 }],
  };
  // These providers have different catalog coverage from the generic canaries.
  const samples = ['corsflix', 'meowtv', 'flickystream'].includes(id) ? {
    movie: [{ tmdb: 27205 }, ...defaultSamples.movie],
    series: id === 'corsflix'
      ? [{ tmdb: 1396, season: 1, episode: 1 }, ...defaultSamples.series]
      : [{ tmdb: 1399, season: 1, episode: 1 }, { tmdb: 1396, season: 1, episode: 1 }, ...defaultSamples.series],
  } : defaultSamples;
  for (const [mediaKind, cases] of Object.entries(samples)) {
    let passed = false;
    const failures = [];
    for (const sample of cases) {
      try {
        // resolveStream pins the provider and its shared accept() checks actual
        // playlist, init, and video bytes. A metadata-only 200 cannot pass.
        const result = await resolveStream(sample.tmdb, mediaKind, sample.season, sample.episode,
          null, true, { provider: id, signal: AbortSignal.timeout(40000) });
        if (result.provider !== id || result.tmdb !== sample.tmdb || result.kind !== mediaKind ||
          result.season !== (sample.season ?? null) || result.episode !== (sample.episode ?? null) ||
          !validURL(result.master)) throw new Error('wrong media identity or missing stream');
        console.log(`PASS ${id} ${mediaKind} TMDB ${sample.tmdb}${sample.season ? ` S${sample.season}E${sample.episode}` : ''}: video bytes verified`);
        passed = true;
        break;
      } catch (error) {
        const category = reason(error);
        failures.push(category);
        console.log(`FAIL ${id} ${mediaKind} TMDB ${sample.tmdb}: ${category}`);
      }
    }
    if (!passed) {
      if (process.env.GITHUB_ACTIONS === 'true' && failures.every(failure => failure === 'HTTP 403')) {
        throw runnerBlocked(`${id} refused the GitHub-hosted runner with HTTP 403; playback validation is inconclusive here`);
      }
      throw healthFailure(`${id} returned no verified ${mediaKind} stream for either canary`);
    }
  }
  return 'verified';
}

async function checkChannel(id) {
  const { createZliveSource } = await import('../api/zlive.mjs');
  const { createTimstreamsSource } = await import('../api/timstreams.mjs');
  const { probeChannelStream } = await import('../api/channel-groups.mjs');
  const source = id === 'zlive' ? createZliveSource() : createTimstreamsSource();
  const channels = await source.list();
  if (!channels.length) throw healthFailure(`${id} returned an empty channel catalog`);
  console.log(`PASS ${id}: ${channels.length} catalog channels`);
  const candidates = channels.filter(channel => channel.live !== false)
    .flatMap(channel => channel.sources.slice(0, 1)).slice(0, 8);
  if (!candidates.length) throw healthFailure(`${id} has no channel sources`);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const stream = await source.resolve(candidate);
      if (!validURL(stream.url)) throw new Error('missing stream');
      if (id === 'zlive') await probeChannelStream({ ...stream, playback: { provider: 'zlive' } });
      // Tim Streams probes real video inside source.resolve().
      console.log(`PASS ${id}: live channel video bytes verified`);
      return 'verified';
    } catch (error) {
      const category = reason(error);
      failures.push(category);
      console.log(`FAIL ${id} channel candidate: ${category}`);
    }
  }
  if (process.env.GITHUB_ACTIONS === 'true' && failures.every(failure => failure === 'HTTP 403')) {
    throw runnerBlocked(`${id} refused the GitHub-hosted runner with HTTP 403; playback validation is inconclusive here`);
  }
  throw healthFailure(`${id} returned no verified video from eight channel candidates`);
}

async function checkSports() {
  const { createSportsSource } = await import('../api/sports.mjs');
  const source = createSportsSource();
  const results = await Promise.allSettled(['nba', 'nhl', 'soccer'].map(sport => source.list(sport)));
  const good = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!good.length) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      throw runnerBlocked('The GitHub-hosted runner could not read any sports event directory; validation is inconclusive here');
    }
    throw healthFailure('Sports primary source returned no readable event directory');
  }
  const events = good.flatMap(result => result.events);
  console.log(`PASS sports: directories reachable; ${events.length} scheduled events`);
  const now = Date.now() / 1000;
  const live = events.filter(event => event.has_payload &&
    (event.always_live || event.starts_at <= now && event.ends_at >= now)).slice(0, 5);
  if (!live.length) {
    console.log('::warning::Sports primary catalog passed; no active broadcast was available to test playback.');
    return 'catalog-only';
  }
  for (const event of live) {
    try {
      const refreshed = await source.resolve(event, { signal: AbortSignal.timeout(35000) });
      if (!refreshed.has_payload || !refreshed.stream_url) throw new Error('no source');
      const stream = await source.hls(refreshed, { signal: AbortSignal.timeout(35000), verify: true });
      if (!validURL(stream.url)) throw new Error('missing stream');
      console.log('PASS sports: live event video bytes verified');
      return 'verified';
    } catch (error) { console.log(`FAIL sports live candidate: ${reason(error)}`); }
  }
  throw healthFailure('Sports primary source returned no verified video from active events');
}

async function checkStrmfree() {
  const { createStrmfreeSource } = await import('../api/strmfree.mjs');
  const source = createStrmfreeSource();
  const events = await source.events({ signal: AbortSignal.timeout(40000), fresh: true });
  if (!events.length) throw healthFailure('Strmfree returned an empty event catalog');
  console.log(`PASS strmfree: ${events.length} catalog events`);
  const now = Date.now() / 1000;
  const live = events.filter(event => Math.abs(event.match_timestamp - now) <= 3 * 3600).slice(0, 5);
  if (!live.length) {
    console.log('::warning::Strmfree catalog passed; no current broadcast was available to test playback.');
    return 'catalog-only';
  }
  for (const event of live) {
    try {
      const stream = await source.open(event, { signal: AbortSignal.timeout(35000), fresh: true });
      if (!validURL(stream.url)) throw new Error('missing stream');
      // Strmfree probes real video inside source.open().
      console.log('PASS strmfree: live event video bytes verified');
      return 'verified';
    } catch (error) { console.log(`FAIL strmfree live candidate: ${reason(error)}`); }
  }
  throw healthFailure('Strmfree returned no verified video from current events');
}

try {
  const result = kind === 'vod' ? await checkVod(provider)
    : provider === 'sports' ? await checkSports()
    : provider === 'strmfree' ? await checkStrmfree()
    : await checkChannel(provider);
  summary(result === 'verified' ? 'Verified' : 'Catalog only',
    result === 'verified' ? 'The public upstream returned actual video bytes.' : 'No active broadcast was available to validate playback.');
} catch (error) {
  if (error.runnerBlocked || process.env.GITHUB_ACTIONS === 'true' && reason(error) === 'HTTP 403') {
    console.log(`::warning title=${provider} runner access blocked::${error.runnerBlocked ? error.message : 'The GitHub-hosted runner received HTTP 403; playback validation is inconclusive here.'}`);
    console.log(`INCONCLUSIVE ${provider}: GitHub runner could not verify playback; no validity claim made`);
    summary('Inconclusive', error.runnerBlocked ? error.message : 'The upstream refused the GitHub-hosted runner with HTTP 403. This does not establish whether playback works for users.');
  } else {
    const message = error.healthCheck ? error.message : `Upstream check failed (${reason(error)})`;
    console.error(`::error title=${provider} health check failed::${message}`);
    summary('Failed', message);
    process.exitCode = 1;
  }
}
