# Validation and completion

## Build meaningful fixtures

Use `node:test`, injected `fetchResource`, and synthetic `.test` hosts. Each test must fail on an unexpected request; it must not fall through to the internet. Use `mkdtemp` for state and set `WATCHLOCAL_DATA_DIR` **before** importing stateful app modules. Restore fetch/environment changes and close servers in `finally`. Existing HTTP tests show how to create a temporary account/profile without touching production data.

Capture structure from real responses but replace private/session values and media URLs. Synthetic byte fixtures only prove the behavior under test, not that a real device can decode a provider's codec. Use existing TS/fMP4 fixture conventions; do not copy real video into the repository.

| Behavior | Observable result |
|---|---|
| Correct identity | Requested TMDB/season/episode, channel key, or event appears in the exact outbound request; wrong response identity is rejected |
| Valid media | Follow root → selected rendition → segment; inspect audio/init/key where present; expected bytes and headers reach the local client |
| Broken first candidate | HTML/PNG, dead audio, empty media, or expired URL is rejected; another candidate is tried |
| Whole provider fails | A later enabled provider succeeds; no request goes to disabled providers |
| Later playback failure | Failed provider/member is excluded; cache cannot revive it; chain terminates when exhausted |
| Time bounds | A stalled body is aborted; cancellation stops further candidate requests |
| Settings restart | New provider appears as intended; saved order, existing disables, private config and profile history survive |
| UI identity | No duplicate cards for the same channel/event; distinct countries/fixtures stay separate |
| IPTV delivery | Actual relevant Xtream/M3U/XMLTV and signed playback endpoints work, not only the web JSON resolver |

For live streams test both root and child failures. A playlist must never be returned in place of a media segment/key. For VOD test season-zero specials, unavailable middle episodes, and a source that validates initially but fails later.

## Commands

From the checkout root, first run the new adapter's focused tests. Then run the appropriate integration tests:

```bash
# VOD
npm run test:providers
node --test test/playback-recovery.mjs test/vod-fallback-http.mjs test/settings.mjs

# Channels
npm run test:live
node --test test/settings.mjs

# Sports
npm run test:sports
node --test test/settings.mjs
```

Run the relevant block, not all three automatically. Verify the new tests are actually included in `package.json`; an explicit test-file list does not discover new files by itself. Finally run:

```bash
npm run check
npm test
npm run check:private
git diff --check
git status --short
```

`check:private` checks tracked paths and default TMDB configuration, **not all secret content**. Review the actual changed/staged files, including new files. Run the repository's configured secret scanner with redaction if available before publication; do not print full credentials while investigating a hit. Never stage the entire checkout indiscriminately.

For this skill's own VOD example, the offline exercise is:

```bash
node --test skills/watchlocal-provider-integration/scripts/vod-adapter.test.mjs
```

It validates the reusable adapter mechanism. It does not replace tests of a real provider's network protocol or registration.

## Real-source and UI checks

When source access is available, use one working item and one known unavailable item. Report metadata extraction, validated media bytes, local relay playback, and native-device playback separately. Record timing, status, selected provider and which failures were attempted; omit signed URLs and authentication material. A currently offline broadcaster is not evidence that fallback code is broken, nor permission to substitute another game.

Inspect the provider's settings UI and a representative playback flow. For channels/events inspect category, artwork, one visible item, and fallback with the preferred source unavailable. Use the tools the environment actually provides; do not claim iPhone testing from Chromium emulation alone.

## Final report

Keep the report short:

- Provider ID/name, media types and integration/fallback position.
- Settings/default/migration behavior and whether a service/key is required.
- Tests run and separately observed live playback, with any untested limitation.
- Commit/push/deployment status only for actions actually performed.

Follow existing user authorization for publication/deployment. For a deployment, verify checks for the exact commit and the server's running revision/health; a successful `git fetch` alone does not update or restart the running app. Never replace private runtime configuration to make a test pass.
