# Watch provider bots

Two local Hermes profiles share a `watch-local` Kanban board:

- **Watch Providers** refreshes [FMHY's video page](https://fmhy.net/video), walks its streaming and live TV/sports links in page order, and researches one site per scheduled run. The queue includes alternatives with distinct names and hosts, but excludes mirrors, status links, IPTV tools, players, and download-only sections. It keeps progress in `/home/jack/watch-bots/state/fmhy-queue.json`.
- **Watch Integrator** receives a Kanban card only after Watch Providers supplies a raw media proof and a local API/adapter file. New cards wait for its visible Bot Chat, where it independently verifies the provider, follows `skills/watchlocal-provider-integration/SKILL.md`, posts progress notes, commits a successful integration, and pushes to the watch.local GitHub repo.

## Researched-site index

`provider-index.json` is the versioned inventory of sites already integrated into watch.local. Its origins are exact host matches, and each entry points to the implementation files. An entry means the source has been reverse engineered and integrated in code; it does not promise that the external site is currently online. When Watch Integrator adds a provider or a new site in an existing provider network, it updates this file in the same commit.

The research queue also records completed investigations (`verified`, `unavailable`, `blocked`, or `skipped`). The `index` command combines those outcomes with the versioned inventory. Watch Providers checks it before investigating a site, and the queue automatically skips integrated hosts before claiming a candidate:

```bash
python3 automation/watch-bots/fmhy_queue.py index
python3 automation/watch-bots/fmhy_queue.py lookup https://cinejoy.pk
python3 automation/watch-bots/fmhy_queue.py sync-index
```

Research outcomes live in `/home/jack/watch-bots/state/fmhy-queue.json` on this host. Keep that state when upgrading; it is not committed to GitHub because investigation artifacts can contain private or short-lived media data.

Both profiles have separate checkouts. The research checkout's push remote is disabled; the integrator checkout tracks `origin/main`. Research code and probe results live in `/home/jack/watch-bots/providers/artifacts/<queue-id>/`, outside either Git checkout. These may contain short-lived media URLs and must not be committed. The Kanban card carries paths and a sanitized summary, not the media URLs.

The scheduler uses the Watch Providers profile's hourly cron job in `--no-agent` mode. Its script sends a research assignment into the profile's visible Bot Chat; the bot claims one site there and posts short progress notes while it works. The final result and failures appear in the same chat. A failed turn can retry the leased item after it expires. On a verified result, `handoff.py` validates the evidence and creates an idempotent Kanban task. New cards start blocked so the host gateway does not also start a background worker. The Watch Integrator profile's lightweight inbox cron checks for a new card every minute and sends it to its own Bot Chat. A source that has no usable stream is marked unavailable or blocked, so the next run moves on.

The inbox records delivered card IDs in `/home/jack/watch-bots/state/integration-chat-sent.json` to prevent duplicate chat turns. Failed integrations stay blocked with a comment; an operator can inspect the card and retry explicitly. The Movy card created before this change is already running in a background worker and is left there until it finishes.

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
