# Security

watch.local is intended for a trusted home network. Do not expose its HTTP ports
to the Internet. With LAN login disabled, devices on that network can use the
owner account, including Settings. Enable **Require login on LAN** on shared
networks. Plain HTTP does not encrypt passwords; use a trusted HTTPS reverse
proxy or VPN when accessing the server across an untrusted network.

## What the application enforces

- Provider and metadata requests use a shared transport that blocks loopback,
  private, link-local, multicast, reserved, and IPv4-mapped IPv6 destinations.
  DNS answers are checked at socket lookup, and every redirect is checked again.
  Playlist entries, keys, subtitles, and stream probes use the same protection.
  Cookies and authorization headers are stripped on cross-origin redirects;
  credentialed TMDB requests refuse redirects.
- Relayed content is served with a restrictive document sandbox and `nosniff`.
  Upstream HTML/XML/SVG content types cannot turn a playback link into an active
  page on the authenticated app origin. The app's static files have their own
  policy allowing the scripts and media needed for playback.
- Browser and IPTV authentication share a limit of 15 failed attempts per
  minute per TCP peer. Forwarding headers cannot change that identity. Successful
  playback requests do not consume the failed-login budget.
- Sessions and signed playback links are time limited and revoked when account
  credentials or permissions change. Administration and profile operations
  validate the authenticated user; browser mutations check request origin.
- Parsers and buffered proxy responses have size limits. Native media is streamed
  rather than buffered as a whole movie.
- Private configuration and state stay under `data/`, outside Git. CI checks
  private files, scans Git history for secrets, audits dependencies, and runs
  security regressions alongside the application tests.

## Trust boundaries

An authenticated administrator and the local operating-system account are
trusted. IPTV passwords are stored in private configuration because the server
must generate credentialed client URLs. Protect the data directory and backups;
do not publish them or mount them into research bots.

Provider responses are untrusted data. New integrations must use
`api/public-fetch.mjs` and must not evaluate downloaded JavaScript. Existing
bundled player ports are pinned for review; Node's `vm` is **not** an isolation
boundary. Changes to those ports still need code review. Run the service as an
unprivileged user; the Docker example additionally limits filesystem access and
capabilities. Network filtering is not a replacement for operating-system
isolation.

Automatic updates trust this repository's `main` branch after its required checks
pass. Protect GitHub write access and review changes before pushing. Tests and
dependency audits reduce risk; they do not prove the absence of vulnerabilities.

## Verify a change

```sh
npm ci --ignore-scripts
npm run check
npm run check:private
npm run check:provider-safety
npm audit --omit=dev --audit-level=high
npm test
```

Security regressions include URL and DNS restrictions, redirect handling,
oversized responses, signed playlist relays, browser content isolation, and
authentication limits. HTTP fixtures use temporary data directories and never
need real credentials. Do not add a production switch that allows providers to
reach private addresses to make a test pass.

If a credential is exposed, revoke or rotate it first. Deleting a file or rewriting
Git history cannot revoke copies that were already obtained. Report security
issues privately to the repository owner; never post live credentials in an issue.
