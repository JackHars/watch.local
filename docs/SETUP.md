# Installation and server setup

[← Back to the README](../README.md)

## Raspberry Pi and Linux

Use a current 64-bit Raspberry Pi OS, Debian, or Ubuntu installation.
Install Node.js 24 and Git before following the README quick start:

```sh
sudo apt-get update &&
sudo apt-get install -y ca-certificates curl git &&
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/watchlocal-node-setup.sh &&
sudo bash /tmp/watchlocal-node-setup.sh &&
sudo apt-get install -y nodejs
```

These commands use the [NodeSource Debian packages](https://github.com/nodesource/distributions/blob/master/DEV_README.md).
On other systems, install [Node.js 24 or newer](https://nodejs.org/en/download).

## Run at boot

Complete `npm start` once to create your account, then press **Ctrl+C**.
For a native Linux installation in `~/watch.local`, run this as the user who owns the checkout:

```sh
(
set -eu
cd "$HOME/watch.local"
sudo tee /etc/systemd/system/watchlocal.service >/dev/null <<EOF
[Unit]
Description=watch.local streaming server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$PWD
ExecStart=$(command -v node) $PWD/start.mjs
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now watchlocal.service
)
```

The service starts at boot and restarts if the process exits. The port capability
allows the optional web listener on port 80 while the app runs as your user.
Enable that listener in **Settings → General**; it is off by default.

```sh
sudo systemctl restart watchlocal.service
sudo systemctl status watchlocal.service --no-pager
```

Back up an existing custom service before replacing its definition.
For automatic updates, also install the [update service](#automatic-updates) below.

## Network and web access

Open the **Web interface** address printed in the terminal, or
`http://localhost:8091` on the host computer. Use the server’s LAN address on
another device. By default, direct LAN visitors open the web panel as the owner
without signing in. Enable **Settings → General → Require login on LAN** to
require an account. Remote and forwarded requests always require a login; IPTV
apps always use their own credentials.

Router-managed local DNS names such as `watch.lan` work with the same LAN access
setting, alongside LAN IP addresses, single-label hostnames, `.local`, and
`.localdomain` names. Requests must still come directly from a private network;
forwarded requests and unrelated public hostnames require a login.

**Settings → General → Web interface on port 80** optionally separates the two
services. It is **off by default**. Enable it and restart watch.local to open the
website at `http://server` or `http://<LAN address>` while IPTV keeps its configured
port (8091 by default). The old web address redirects to the new one. Xtream,
M3U, and XMLTV links continue to use the IPTV port; browser playback uses signed
media links on the web port. Turning the option off and restarting restores the
shared port.

## Local discovery

Local discovery is **on by default**, including when upgrading an existing
installation. On a normal home network, watch.local advertises `watch.local` using
mDNS/Bonjour without changing router DNS settings. Open `http://watch.local`
when the port 80 option is enabled, or `http://watch.local:8091` with the default
shared port. Discovery always advertises the actual running web port, including
the fallback port if port 80 cannot open. IPTV still uses its own port.

In **Settings → General → Local discovery**, turn discovery off or choose a
different **Local name**. These changes apply without restarting. The settings
page and terminal report the address actually announced. If the name is already
taken, the responder chooses a numbered name and the displayed address updates.
The server withdraws its announcement when disabled or shut down and refreshes
it as LAN interfaces change. Discovery errors leave access by IP available.

Devices must support mDNS and be able to exchange local multicast traffic
(UDP 5353). Guest Wi-Fi isolation, host firewalls, and separate VLANs may block
discovery. A loopback-only listener is not advertised. Router-managed names such
as `watch.lan` continue to work independently.

**Linux Docker:** bridge networking does not carry LAN multicast. Use the
discovery companion in [compose.example.yaml](../compose.example.yaml), which runs
on the host network while the web/IPTV app keeps its bridge network. After the
initial account setup and `npm ci`, create `data/discovery` as the same user who
runs the containers (`mkdir -p data/discovery`) and run
`docker compose -f compose.example.yaml up -d`. Match the example's user ID to
the owner of the data directory. Enable the port 80 option separately if wanted.
Keep published web/IPTV ports equal to their configured ports; update
`WATCHLOCAL_DISCOVERY_ENDPOINT` if changing the IPTV port. The companion reads only
the local health endpoint and shares a status file, without access to account or
TMDB settings. It withdraws discovery if the app stops responding.

For a native install, discovery runs inside `npm start`. A Linux container
already using host networking can explicitly select `WATCHLOCAL_MDNS_MODE=builtin`
instead of using the companion; it must be able to bind the configured HTTP
ports. Unconfigured containers report discovery as unavailable rather than
advertising an unreachable container address. Docker Desktop networking differs;
use a native LAN responder when multicast cannot reach the physical network.

Port 80 must be available and the process must have permission to bind it. For a
Docker deployment, publish both `80:80` and the IPTV port, such as `8091:8091`.
If the port 80 listener cannot start, watch.local keeps the web panel on the IPTV
port and shows the reason in General settings and the server log. The toggle
remains saved for the next restart.


## Automatic updates

**Settings → Updates** can automatically install new commits from the
repository's `main` branch. It is **off by default**. The default check interval
is five minutes; **Check now** queues a check within a minute. With automatic
updates off, a manual check reports available updates without installing them.

Install the host service once on Linux, as the user who owns the checkout and
can run Docker Compose:

```sh
node scripts/install-updater.mjs --compose /absolute/path/compose.yaml --data /absolute/path/data
sudo loginctl enable-linger "$USER"
```

The Compose services default to `watchlocal,discovery`; use `--services` to
specify different names. A native installation running as a **user systemd
service** uses `--service watchlocal.service`. A **system service** installed
under `/etc/systemd/system` uses `--system-service`, as shown below. These are
different service managers; the installer checks that the selected service
starts this checkout. Native installs need Node 24 or later. Docker hosts need
Node 22 or later, Git, `flock`, systemd and
Docker Compose; candidate dependencies are installed using the app's Node image.
The installer prints whether lingering still needs to be enabled. It keeps the
timer running after logout and at boot. Then turn on **Automatic updates** in
Settings. No GitHub credential or inbound webhook is required for a public repo.

For a Raspberry Pi already running `watchlocal.service` as a system boot service,
run this once from a fresh terminal (adjust the folder/service name if different):

```sh
cd "$HOME/watch.local" &&
git pull --ff-only &&
npm ci --ignore-scripts &&
sudo node scripts/install-updater.mjs --system-service watchlocal.service --enable
```

This installs a separate system timer that runs after reboot and logout, enables
automatic updates, and restarts the app once to load the repair. The app service
must have a non-root `User` who owns its checkout, with `WorkingDirectory` set to
that checkout. Use `--data /path/to/data` if it stores data elsewhere. The update
agent runs as that same user; a narrow sudoers rule permits only starting and
stopping that app service. The web application never receives root privileges.
Starting the app at boot by itself does **not** install the update timer.

On native Raspberry Pi/Linux system-service installations, administrators can
also use **Settings → Updates → Repair automatic updates**. This opens a terminal
inside the browser, including from a phone or another computer. Enter the Linux
service user's **sudo password** in the masked field. The fixed repair installs
and enables the boot timer, restarts the app and checks for new commits using
the updater's normal CI, dependency preparation and rollback protections. The
terminal reconnects after restarts and shows the result. It is not a general shell.
The password is never stored, logged or echoed; HTTP does not encrypt it in
transit, so use HTTPS on networks you do not trust. Sudo, util-linux (`script`)
and systemd must be installed, and the service user must have sudo access.
Services that prohibit privilege elevation and Docker containers cannot use
this native repair; install their updater on the host with the commands above.
An older installation must update and restart once to receive this button.

If new code has already been pulled but the server still runs the old version,
administrators see **Update available → Restart now**. The prompt waits until
playback and other dialogs are closed. Restart requests go through the host
agent, check CI, prepare dependencies, and retain rollback protection. **Later**
dismisses the prompt; **Settings → Updates → Restart now** remains available.
Settings shows both the installed commit and the commit loaded by the running
process, and health checks verify the new revision before marking an update done.

The host agent only follows the configured GitHub `origin` and fast-forwards
`main`. It waits for the exact commit's `checks.yml` push workflow to succeed,
prepares dependencies and checks syntax in a separate checkout, then briefly
restarts the app. Local changes, divergent history, failed checks and network
errors leave the installed version in place. Both web and IPTV health endpoints
are checked; override their local addresses with `--health-urls` if your runtime
ports differ from saved settings.

Private data and the previous dependencies are backed up outside the repository
before installation. If startup fails, code, dependencies and data are restored;
the failed commit is skipped until a newer one arrives. An interrupted update
is recovered on the next timer run. The web app exchanges status and check
requests through private files and never receives a Docker socket or unrestricted
shell access. The optional native repair uses a fixed sudo-authorized helper in
an independent, temporary system service; routine updates do not ask for a password.

The agent runs as `watchlocal-update.timer` / `watchlocal-update.service` under
your user account. For a user/Compose installation, inspect it with:

```sh
systemctl --user status watchlocal-update.timer
journalctl --user -u watchlocal-update.service -n 50
```

For a system-service installation, use `sudo systemctl status watchlocal-update.timer`
and `sudo journalctl -u watchlocal-update.service -n 50` instead. No user lingering
is needed for that system timer.

Its host configuration, recovery runner and latest rollback backup live in
`~/.local/state/watchlocal-updater` by default (`--state` chooses another location
outside the checkout and data directory). Treat `backup/data` as private: it
contains the same account and metadata credentials as your live data. Only one
rollback snapshot is retained; it is replaced at the next installation.

If Settings reports that recovery could not finish, preserve the state directory
and resolve the host service, disk-space or local-checkout issue before starting
`watchlocal-update.service` again. The saved transaction is recovered before any
new update is attempted. A commit that was rolled back is not retried by
**Check now**; publish a corrected commit to `main` instead. To uninstall the
schedule, run `systemctl --user disable --now watchlocal-update.timer`, or
`sudo systemctl disable --now watchlocal-update.timer` for a system installation.
The latter's narrow restart permission is in `/etc/sudoers.d/watchlocal-updater`;
remove it too when uninstalling the system updater.


## Saved data

The server creates `data/` on first launch. It holds accounts, server settings,
signing secret, catalog, and metadata caches. Accounts and settings are saved in
`data/iptv.json`; passwords are stored there so IPTV connection links can be
shown and copied. An optional TMDB credential is stored in the same private file,
separately from playback providers, and is sent only to TMDB. The directory is
excluded from Git. Keep it private and back it up.

Existing single-account installations migrate automatically. The existing login
becomes the owner, and `data/iptv.pre-users.json` keeps a one-time backup of the
original account file. Existing catalogs and pinned titles are retained.

Profiles and playback positions are saved in `data/watch-progress.json`. Older
account-wide watch history moves into a **Main** profile automatically, with the
original history kept in `data/watch-progress.pre-profiles.json`. Back up these
files along with the rest of `data/` to preserve everyone's place.

`data/`, `config.json`, and environment files are excluded from Git. Additional
catalog settings and cache details are documented in [IPTV.md](../IPTV.md#local-data-and-configuration).
