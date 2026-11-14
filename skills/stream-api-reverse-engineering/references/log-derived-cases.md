# Lessons from Hermes Red's stream API sessions

These cases summarize the local Red transcripts and surviving API artifacts. They are examples of *decision patterns*, not hardcoded provider instructions. The live site, current source code, and a fresh media probe take precedence over a dated report. Do not copy private requests, cookies, tokens, signed links, or raw logs into a repository.

## Rotating edge pages: NTV

The NTV session sampled multiple edge pages. Some responses were live pages with HLS references; others were promo slates or 404s as games ended. A one-shot scrape and a byte-size-only classifier gave false conclusions. Compare a bounded set of page variants using hashes and actual playlist markers, timestamp the census, and report `live`, `slate`, or `offline` separately. An API with zero streams during a slate is not proof that its extractor is broken. The same session lost time to repeated service restarts: stale listeners served old content types, so the browser showed HTML source as text. Verify the listener PID and response `Content-Type` after deployment.

## Signed resolver: ZLive

The public channel JSON was the catalog. An anonymous `/streams` request returned an empty list, so repeating it would never list channels. A ticket plus a signing function in the site's JavaScript produced a short-lived HLS URL. A working JS harness existed before the final API; preserving that function was faster and safer than porting its obfuscated cipher to Python. A playlist and a real MPEG-TS segment were verified with the site's `Origin` and `Referer`; bare CDN requests returned 403. The CDN also returned a generic feed for unknown signed keys, so the API checked keys against the catalog before resolving. General lesson: catalog source, signing source, CDN header contract, and identity validation are separate gates.

## P2P wrapper with raw fallback: StreamFree

The shortest route was catalog → stream-key lookup → server-rendered embed page → signed playlist. The site's own playlist pointed to PNG-wrapped P2P chunks that ordinary players could not decode. Its fragment data identified raw MPEG-TS fallback URLs; a rewritten playlist and a constrained segment relay made a genuinely playable feed. Some origin streams were direct TS instead. The raw CDN required specific page headers. General lesson: inspect the *segment bytes* and playlist URI structure before deciding whether a manifest is playable; avoid deobfuscating an analytics bundle when the needed signature is already inline in HTML.

## Public catalog, opaque player: TimStreams

Same-origin JSON provided channels and events, but most stream links led to obfuscated player pages. One family used a JavaScript redirect despite HTTP 200; another used a signed player route. The initial API could verify the final player page, not raw media, because the player configuration required a browser session that the sandbox lacked. The correct response was `player_only`, with the blocker stated, not a `raw_verified` claim. General lesson: successful catalog and redirect resolution do not prove a direct media API.

## Search identity, session protocol, and stale handoff: Reelix/VidCore

The catalog used a stable numeric title ID in its slug. Earlier notes described only a player-page resolver and called native extraction unavailable; a later watch.local adapter implemented a session protocol and validated a media segment. This is why the latest source and fresh test outrank an old handoff. Search by title cannot replace an exact numeric ID, especially for a TV episode. The upstream also returned burst 503s, so backoff and caching were more productive than parallel probing. General lesson: preserve exact identity, classify transient failure, and update the verdict when new evidence arrives.

## Cross-case failure signatures

| Observation | Check next |
|---|---|
| 200 response, blank player or no video | Content type, body marker, manifest, then segment bytes. |
| 403 on a signed CDN URL | Expiry and exact `Origin`/`Referer` used by the site; retry once with fresh resolution. |
| 200 image or tiny payload | Tracking/P2P wrapper; inspect alternate segment path rather than claiming video. |
| 200 embed or JW page | Look for media requests; classify `player_only` until a segment is verified. |
| Empty list while site shows events | Confirm the actual catalog route and whether the edge is in a slate state. |
| Same error after multiple retries | Stop; write the blocker and change the hypothesis or required tool. |
| Old behavior after code change | Check the listening PID, port, process start time, and served build. |
