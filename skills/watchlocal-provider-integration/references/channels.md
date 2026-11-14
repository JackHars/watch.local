# Permanent live TV channels

## Reuse the channel framework

Read `api/timstreams.mjs`, `api/channel-provider.mjs`, `api/live.mjs`, `api/channel-groups.mjs`, and `test/timstreams-http.mjs`.

Implement a source, then wrap it with `createChannelProvider`. This supplies persistent IDs, cache refresh, per-channel source attempts, EPG, Xtream rows, and XMLTV.

```js
const source = {
  async list() {
    // Fetch every required page and normalize observed data into this shape.
    return [{
      key: 'stable-upstream-key', name: 'Example TV',
      category: 'news', flag: 'US', quality: 'HD', live: true,
      sources: ['stable-source-reference']
    }];
  },
  async resolve(sourceReference) {
    // Acquire fresh playback data, verify it, then return:
    return { url: verifiedManifestURL, headers: requiredMediaHeaders };
  },
  // Optional guide(): { 'stable-upstream-key':
  //   [{ start: unixSeconds, stop: unixSeconds, title, description }] }
};
```

The identifiers above are examples, not real API payload fields. Translate the observed upstream schema. Store stable references in `sources`; fetch expiring tickets during `resolve`. Bound retries/body sizes and validate public media addresses and redirects. Use `probeSportsStream` with the same fetch/header behavior as real playback. The framework does not validate every new source automatically; `probeChannelStream` currently has provider-specific behavior.

Create `create<Provider>Provider(options)` around `createChannelProvider({provider, label, idBase, ...options, source: options.source || create<Provider>Source()})`, as in Tim Streams. Inject networking for deterministic fixtures. Do not return the VOD `{master}` shape; live resolution requires `{url, headers}`. The wrapper adds its `playback` context.

## Every wiring point matters

- [ ] Export a new numeric `*_ID_BASE`. Inspect all existing bases first: current ZLive is `1000000000`, Tim Streams `1100000000`. Select a non-overlapping range within safe client integer limits. Do not move existing ranges or reuse IDs from another provider. `createChannelProvider` allocates starting at `idBase + 1` and saves key→ID mappings.
- [ ] `api/live.mjs`: import/register the provider, accept its injectable source, add its default config flag, update `providerFor` and the media-provider dispatch. Current ID dispatch is a descending threshold chain; a new highest range must be checked first. Otherwise it resolves through Tim Streams by mistake.
- [ ] Preserve the aggregator's `gather` paths: initialization, refresh/status, categories, `rows`, `browserRows`, `epg`, `resolve`, `media`, `recover`, and `xmltv`.
- [ ] `api/settings.mjs`: update `defaultConfig().live`, boolean validation, and the `configure` allowed-key list. Default merging must preserve explicit `false` on restart. Choose the new flag's default from the task and existing convention.
- [ ] `api/iptv.mjs`: pass the injectable source in `initializeIPTV`; update `browserPlay`'s live provider label mapping. Inspect relay dispatch if the source needs special media handling.
- [ ] `public/app.js`: add the display label, a live-provider settings toggle, and the matching form-save field. A visible toggle without serialization is broken.
- [ ] `package.json`: register source syntax checks and targeted/aggregate tests.

## Group sources, keep artwork and categories

`browserRows()` must use the common shape with `kind:'channel'`, `provider`, numeric `stream_id`, `channel_name`, `country`, and category/artwork fields. Reusing `createChannelProvider` provides this shape.

`groupChannels` merges normalized broadcaster name **and country** and keeps the first provider's visible ID. Keep alternate members for fallback. Do not merge ESPN with ESPN2, different language/regional channels, or similarly named broadcasters. Verify one visible UI card and multiple candidates behind it. The existing IPTV `rows()` exports provider entries separately; do not accidentally promise IPTV deduplication when only the UI is grouped.

Read `api/channel-metadata.mjs`, `api/channel-directory.json`, `api/channel-artwork.mjs`, and `public/live-model.mjs`. Reuse the current category IDs and logo route. Match directory entries by broadcaster identity, not a coincidentally equal provider key. The current directory key lookup originated with ZLive; inspect it when adding another key namespace. Add verified logo mappings/assets where needed, with the app's existing styled fallback for unknown artwork. Merely returning an arbitrary `logo` property will not make the wrapper display it.

## Required edge cases

Test catalog pagination, refresh outages retaining prior channels, stable IDs after restart, and routing on both sides of numeric range boundaries. Test a same-name/same-country pair collapsing into one UI card; same-name/different-country and ESPN/ESPN2 stay separate. Then fail the first provider and prove the second returns validated media. Disable that second provider and prove it is not contacted.

Also fail the initially successful root/segment after selection. Preserve `group`, `requestedId`, `memberId`, `failedIds`, and `root` through signed relay URLs so recovery does not restart the same failing member indefinitely. Add a fixture against actual web, M3U, Xtream, and XMLTV endpoints; copying an existing mock assertion is not a substitute for testing the new ID dispatch.
