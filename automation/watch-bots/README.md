# Watch provider research

Watch Providers and Watch Integrator are separate Hermes bots. Each runs in its own Docker container with no host home directory or personal credentials mounted. Their only shared data is a Kanban board and the research artifacts; the integrator sees the artifacts read-only. Both checkouts have disabled push remotes. There are **no scheduled jobs**.

Say **`begin`** in the Watch Providers chat to investigate exactly one site from the [FMHY video list](https://fmhy.net/video). The queue preserves completed and blocked work. The bot verifies actual media bytes before writing an adapter and handing off a verified candidate. A readable catalog, player page, or manifest alone is insufficient.

If a verified handoff is waiting, say **`begin`** in the Watch Integrator chat. It rechecks the exact media, updates watch.local, runs the validation checks, and commits locally. It leaves the Kanban card blocked until you review and push the change yourself. It never asks for a GitHub credential.

The sandbox dashboards are available only on the host at `http://127.0.0.1:9121` (research) and `http://127.0.0.1:9122` (integration). Both require login. The containers reach public HTTP(S) through a proxy that denies private network destinations; only the authenticated local model bridge is reachable on the host. Docker volumes hold the queue, repos, artifacts, and bot profiles. They are not host directory mounts.

## Research index and evidence

`provider-index.json` records code-backed site origins and implementation paths. A listed source may still go offline. The queue at `/home/jack/watch-bots/state/fmhy-queue.json` records investigated, blocked, skipped, and pending sites. Inside the research container:

```bash
python3 automation/watch-bots/fmhy_queue.py status
python3 automation/watch-bots/fmhy_queue.py index
python3 automation/watch-bots/fmhy_queue.py lookup https://cinejoy.pk
```

Research artifacts live under `/home/jack/watch-bots/providers/artifacts/<queue-id>/` inside Docker. Use `evidence.example.json` for the handoff contract. Keep signed URLs, cookies, credentials, and raw site instructions out of the Kanban card and Git commits. A verified handoff uses:

```bash
python3 automation/watch-bots/handoff.py /home/jack/watch-bots/providers/artifacts/<queue-id>/evidence.json
```

The handoff helper checks the candidate ID, file locations, fresh raw-media proof, and allowed fields. The integrator still verifies the stream independently. If access or verification fails, close the queue item as `blocked` or `unavailable`; do not send an integration card.
