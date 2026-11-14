# Sports-event fallbacks

## Current architecture has a limit

Read `api/sports.mjs` (`createSportsProvider`, `resolve`, `media`, `recover`), `api/strmfree.mjs`, `api/live.mjs`, and `api/iptv.mjs` (`serveMedia`). Then read `test/sports-fallback-http.mjs`.

The current sports provider has **one primary source and one named Strmfree fallback**. It is not a generic multi-provider registry. Adding another source file or a settings flag does not extend that chain. Do not overwrite Strmfree to make room for the new API.

For a third source, make the smallest tested extension to a named ordered adapter collection. Preserve the existing primary and Strmfree identities and configuration. Extend candidate selection, caching, dispatch, status, recovery, and exclusion tracking together. Test the existing two-source behavior unchanged before claiming completion.

## Source contract

Strmfree is the closest example for an additional event source:

```js
const source = {
  async resolve(event, { signal, fresh = false } = {}) {
    // event carries the existing ID, title, sport and starts_at (Unix seconds).
    // Match this exact fixture, acquire fresh media, verify each candidate.
    return {
      url: verifiedManifestURL, headers: requiredHeaders,
      playback: { provider: providerID, root: verifiedManifestURL,
                  /* adapter-specific stable identifiers for renewal */ }
    };
  },
  async media(url, context) {
    // Renew temporary URLs/headers without changing the requested resource kind.
    return { url: currentResourceURL, headers: currentHeaders,
             playback: currentContext };
  },
  // Optional status() and verify(stream, {signal}).
  // Set validatesStreams:true only when resolve verifies EVERY chosen candidate.
};
```

Do not copy the identifiers above as real API fields. Map the actual schema. The primary source uses `resolve(event)` followed by `hls(event,{signal,verify:true})`; a fallback's `resolve` returns the stream directly. Preserve that distinction when generalizing dispatch.

## Matching rules

Reuse the logic and tests around `matchStrmfreeEvent` as a pattern, not as a parser for an unrelated schema. Match sport/league, both participants, and start time. Account for reversed home/away order and verified aliases. Use seconds consistently. Current Strmfree allows a 90-minute window; a different tolerance needs evidence from that API. Reject ambiguous fixtures and wrong leagues rather than substituting another live game. Do not label an upcoming or ended fixture playable solely because it has a listing.

Keep one existing event ID/card. Extra APIs supply alternate broadcasts for that event. Do not append duplicate fixture lists to the UI or allocate a second IPTV event ID. If the user requests genuinely new events, normalize and merge those separately by identity/time.

## Wiring and recovery checklist

- [ ] New source file with injectable fetching, bounded requests and sanitized fixtures.
- [ ] `api/live.mjs`: construction/configuration/status of the new fallback; pass it to `createSportsProvider` without dropping the existing fallback.
- [ ] `api/settings.mjs`: live default flag, boolean validation, allowed config key, and preservation of saved disables.
- [ ] `api/iptv.mjs`: test-source injection in initialization and correct browser provider labels.
- [ ] `public/app.js`: settings toggle, save field, provider display name.
- [ ] `api/sports.mjs`: ordered enabled candidates; failed-source exclusions across repeated recovery; no reuse of a disabled source from cache; `media` dispatch by actual chosen source. Propagate `eventId` and `sportsSource` in playback context.
- [ ] `api/iptv.mjs` `serveMedia`: its current recovery condition explicitly checks `sportsSource === 'primary'` or a channel group. If fallback A fails and fallback B should run, extend this guard **and** the sports `recover` function. Updating only the initial resolution loop is incomplete.
- [ ] `package.json`: syntax and test registration.

Preflight must check media bytes with `probeSportsStream`, not just HTTP 200 or `#EXTM3U`. If that provider uses unusual wrappers, apply the same decoding rules during verification and relay. Do not recurse through a renewal method that awaits the in-flight resolution itself; the Strmfree code documents this deadlock.

A relay can switch a **root playlist** to another broadcast. It must not return a new playlist as a response to a segment/key request, or splice bytes from another stream into an old timeline. A failed child can prime the next root request to use the fallback while that child fails honestly. Preserve native iOS playback and its media headers.

Test primary failure → existing fallback failure → new fallback success; then initial success → later failure → next untried provider. Test disabled and exhausted chains, concurrent retries, cancellation, stale URLs renewing on the selected source, one UI event/M3U entry, and resource-kind correctness. Use deterministic source fixtures so a real match starting or ending cannot make CI flaky.
