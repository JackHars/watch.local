#!/bin/bash
set -euo pipefail

cat <<'PROMPT'
Scheduled Watch Providers research turn. Work on one FMHY site in this visible Bot Chat so the user can follow the work live.

Start in /home/jack/watch-bots/providers/watch.local. Read your SOUL.md, automation/watch-bots/README.md, and the stream-api-reverse-engineering skill. Run `python3 automation/watch-bots/fmhy_queue.py claim` once. If it returns a null candidate, say the queue is empty and stop. If the candidate says `resumed`, continue its existing investigation and reuse its artifacts. Do not claim a second site in this turn.

Post brief, plain-language progress messages in this chat as you work: the site claimed; the catalog and resolver path you found; what you are testing next and why; the manifest and media-byte verdict; and the final handoff task ID or precise blocker. Keep each update to one or two sentences. Show decisions and evidence, not private chain-of-thought, credentials, cookies, signed URLs, or long raw tool output.

Check `python3 automation/watch-bots/fmhy_queue.py lookup <candidate-url>` and the existing code before probing. Follow the skill's bounded tests. If raw media verifies, save a working API/adapter plus sanitized evidence and probe files under /home/jack/watch-bots/providers/artifacts/<candidate-id>/ and run `python3 automation/watch-bots/handoff.py <absolute-evidence-file>`. If the site is already integrated or cannot be verified, finish its queue item as skipped, unavailable, or blocked with a short reason. Report the outcome in this chat before stopping.
PROMPT
