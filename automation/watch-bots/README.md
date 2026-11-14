# Watch provider bots

Two local Hermes profiles share a `watch-local` Kanban board:

- **Watch Providers** refreshes [FMHY's video page](https://fmhy.net/video), walks its streaming and live TV/sports links in page order, and researches one site per scheduled run. The queue includes alternatives with distinct names and hosts, but excludes mirrors, status links, IPTV tools, players, and download-only sections. It keeps progress in `/home/jack/watch-bots/state/fmhy-queue.json`.
- **Watch Integrator** receives a Kanban card only after Watch Providers supplies a raw media proof and a local API/adapter file. It independently verifies the provider, follows `skills/watchlocal-provider-integration/SKILL.md`, commits a successful integration, and pushes to the watch.local GitHub repo.

Both profiles have separate checkouts. The research checkout's push remote is disabled; the integrator checkout tracks `origin/main`. Research code and probe results live in `/home/jack/watch-bots/providers/artifacts/<queue-id>/`, outside either Git checkout. These may contain short-lived media URLs and must not be committed. The Kanban card carries paths and a sanitized summary, not the media URLs.

The scheduler uses the Watch Providers profile's hourly cron job. Its script runs `fmhy_queue.py claim`, leases one site for four hours, and injects that candidate into the bot's prompt. A failed run can retry the same item after the lease expires. On a verified result, `handoff.py` validates the evidence and creates an idempotent Kanban task assigned to Watch Integrator. The host Hermes gateway dispatches the task. A source that has no usable stream is marked unavailable or blocked, so the next run moves on.

## Evidence contract

Copy `evidence.example.json` into the candidate's artifact directory and fill it with the exact provider ID, site URL, method/routes, known-good sample, media result, and API/adapter path. Save the output from `skills/stream-api-reverse-engineering/scripts/probe-hls.mjs` as `probe.json`. Both files stay in the artifact directory. Then:

```bash
python3 automation/watch-bots/handoff.py /home/jack/watch-bots/providers/artifacts/<queue-id>/evidence.json
```

The handoff helper rejects an unclaimed site, a stale or non-video probe, missing implementation, or mismatched source host. The integrator must still verify the real stream and app playback itself.

## Operations

```bash
python3 automation/watch-bots/fmhy_queue.py status
hermes -p watch-providers cron list
hermes kanban --board watch-local list
hermes gateway status
```

`fmhy_queue.py refresh` updates the site list while retaining progress. `fmhy_queue.py finish <id> unavailable|blocked|skipped --note 'reason'` closes a candidate without a handoff. Use `hermes -p watch-providers cron pause <job-id>` to stop new research; existing integrator cards remain on the board. The app repo is the only GitHub publication target. A bot profile is a local process identity and does not itself create a GitHub account.
