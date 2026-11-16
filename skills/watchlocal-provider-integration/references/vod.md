# Movies and episodes

## Read these anchors

- `api/providers.mjs`: `PROVIDERS`, `createProviderContext`, `createProviderResolver`, `adapters`.
- `api/reelix.mjs` and `test/reelix.mjs`: a separately implemented adapter, central registration, fixtures, HTTP relay coverage.
- `api/settings.mjs`: `providerNames`, `defaultConfig`, settings initialization migration, `validateConfig`.
- `api/iptv.mjs`: `browserPlay`, VOD resolution, `serveMedia`.
- `api/web.mjs`: `/ui/play` and `/ui/playback.m3u8` (including its JSON status response).
- `public/playback-recovery.mjs`: per-playback exclusion chain. `public/app.js`: provider labels and native/HLS error handling.

## Adapter contract

The central resolver normalizes browser `tv` into internal `series` and calls:

```js
async function adapter(input, ctx) {
  // input: { tmdb: number, kind: 'movie' | 'series',
  //          season: number | null, episode: number | null, ... }
  // ctx: { signal, read, text, json, accept }
  // Obtain candidates using this provider's verified request/response contract.
  // For every candidate, return ONLY after ctx.accept(...) succeeds:
  return await ctx.accept(candidate.url, candidate.headers, sourceLabel);
}
```

`ctx.json(url, headers, { body, timeout, limit })` sends JSON POST when `body` is truthy; otherwise GET. `ctx.read` returns `{bytes, url}`; `url` accounts for redirects. These helpers bound requests and body size. Reuse them instead of unbounded raw fetches.

`mediaHeaders` currently forwards only `user-agent`, `referer`, and `origin`. API request headers passed to `ctx.json` are separate. If media needs a private cookie or Authorization header, this is an explicit relay/configuration requirement: do not assume it survives `ctx.accept`, and do not put account credentials in browser code or the encoded media URL payload.

`ctx.accept` returns `{master, headers, server, variants, streams}`. It checks the selected HLS rendition, media bytes, initialization/key resources, and the selected external audio track. Do not return `{master: rawURL}` yourself: that bypasses validation. Central resolution adds `provider`, attempted-provider information, identity, and cache metadata.

Use the [adapter example](../assets/vod-adapter.mjs) if the API returns candidate URLs. Implement `loadSources(input, ctx)` with verified endpoint parameters and map results into its documented candidate fields. If the upstream needs a handshake, parse it as data and acquire fresh tickets per playback. Never eval downloaded JavaScript. Do not copy a live ticket or account key into a fixture.

Use exact IDs. If IMDb is required, inspect the existing `vidsrc` adapter's `getCatalogData('/…/external_ids')` conversion. Never replace an unplayable episode with the previous/next one. If response IDs are present, compare them with the requested identity. Season zero is valid; `season || 1` is wrong.

## When the first hop is an HTML page (signed URL in markup)

Some VOD providers serve a server-rendered watch page instead of a JSON API, and that page already embeds the first signed URL (for example in `<link rel="preload">`). The rest of the chain is often keyless — all upstream signing is issued server-side in the page, so no client-side crypto is needed.

- The page may carry the URL in several encodings at once: HTML-entity (`&amp;`) inside a real tag, and JSON-escaped inside an embedded JS string (`\u0026`, or double-escaped `\\u0026`/`\\\"` in a flight payload). Decode the specific escapes (`\\u0026`→`&`, `\\\"`→`"`); never strip backslash runs, which corrupt the escapes.
- The extraction regex must capture the whole URL to the next quote or whitespace boundary (e.g. `/https?:\/\/host[^"'\s]*/`). A pattern that ends in a keyword group like `…\?(?:url|Policy|Signature|Key)` matches only through the keyword — `match[0]` then lacks the `=value`, and any later "contains `url=`" check fails silently.
- When the signed URL rides in a `url=` query parameter, its `/` characters arrive as `%2F`; parse with `URLSearchParams` and write string assertions against the encoded form.
- SSR pages are exactly keyed and honest: the page echoes the requested identity in several channels (embedded state JSON, a title suffix like `· S<n> E<n>`, `<s>_<e>` components of the CDN path). Require all echo channels to match the requested kind/ID/season/episode. A page that renders the home page with no signed master is a "not found" — fail honestly, never substitute.
- Worker-dependent SSR can omit the signed URL for an otherwise valid request. A second TLD serving the same app is the correct per-origin failover, not a second provider entry.

## Wiring checklist

- [ ] Add `api/<id>.mjs`, or a small adapter in `api/providers.mjs` when appropriate.
- [ ] Add its ID once to `PROVIDERS`, import the factory/function, and register it in `adapters`. For the injected example, that entry is `example: createExampleResolver({ loadSources: loadExampleSources })`; import or define the verified `loadExampleSources` implementation too. Exporting a file alone does nothing.
- [ ] Add the display name and description to `names` / `subtitles` in `public/app.js`. Existing provider settings rows are generated from configured order.
- [ ] Inspect settings migration before changing it. Currently every `PROVIDERS` entry is enabled on a fresh install; newly introduced IDs are appended and enabled once on existing installs. Already disabled providers stay disabled. Test this behavior; if a different default is requested, implement it explicitly without resetting other settings.
- [ ] Preserve the user's ordering preference, including any explicitly requested last-choice source. Do not silently replace their saved order with the default array.
- [ ] Register the new `.mjs` file in `npm run check`, and tests in `npm test` plus the relevant targeted test command.
- [ ] Inspect the `for (const provider of PROVIDERS.filter(...))` fixture loop in `test/providers.mjs`. Extend its mock for this provider, or exclude it **only when a dedicated test file supplies equivalent coverage**.

Do not add new catalog entries, provider-specific player screens, or client-side upstream fetches. Normal VOD adapters already flow through `resolveStream` and the signed relay. Change those layers only if a demonstrated contract requirement needs it.

## Prove fallback, not only extraction

Test all three levels:

1. Candidate A returns a valid-looking master but its segment or default audio fails; candidate B succeeds.
2. The new provider has no usable candidate; the next enabled provider succeeds. Force the new provider first in a test-only policy so an earlier existing provider cannot hide the bug.
3. A source initially passes validation then fails during playback. `fresh` plus the accumulated `exclude` list selects another provider without reusing the failed cache entry. Inspect the same `/ui/playback.m3u8` request with `Accept: application/json` and the same `requestId` as the native tap; there is no separate `/ui/playback-status` endpoint. Test this as well as `/ui/play`; see `test/vod-fallback-http.mjs` and `test/playback-recovery.mjs`.

Pinning `provider:<id>` intentionally restricts resolution to that provider. A pinned diagnostic cannot prove cross-provider fallback. Use an unpinned request with a controlled configured order for that test.
