<p align="center">
  <img src="docs/branding/readme-hero.webp" alt="watch.local — Any stream on any screen" width="100%">
</p>

<p align="center">
  Movies, series, live TV, and sports. One app on your home network.<br>
  Watch in your browser or connect your favourite IPTV player.
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="docs/SETUP.md">Server setup</a>
</p>

## Install

You'll need **[Node.js 24+](https://nodejs.org/en/download)**, npm, and Git. Starting with a fresh Pi? [Install the dependencies first.](docs/SETUP.md#raspberry-pi-and-linux)

```sh
git clone https://github.com/JackHars/watch.local.git
cd watch.local
npm ci
npm start
```

Create your username and password in the terminal, then open **[watch.local:8091](http://watch.local:8091)** on your home network. You can also use the server's IP address and port `8091`. No API key is needed to get started.

Profiles keep everyone's watch history separate, and Continue Watching picks up where you left off. For an IPTV app, copy the **Xtream Codes**, **M3U**, or **XMLTV** details from **Settings → IPTV connections**.

Keep the host running while you watch. [Run it at boot on a Pi or Linux server.](docs/SETUP.md#run-at-boot)

### Local discovery

The app advertises `watch.local` over mDNS on compatible home networks—no router changes needed. Enable **Settings → General → Web interface on port 80** and restart to use **[http://watch.local](http://watch.local)** without a port number. IPTV stays on port `8091`. [Network and Docker setup →](docs/SETUP.md#local-discovery)

### Automatic updates

[Install the host updater](docs/SETUP.md#automatic-updates), then enable **Settings → Updates → Automatic updates**. It follows `main`, waits for GitHub checks to pass, and restarts the server after installing an update.

## How it works

<img src="docs/branding/stream-flow.svg" alt="Resolve public web-player streams, verify the media, then relay it to your screen." width="100%">

watch.local reverse-engineers public web players to resolve their streams on demand. It reproduces the player's requests, decodes source responses, and finds the underlying HLS playlists. Video and audio are checked before playback; failed sources fall through to the next enabled source.

A Node.js server relays playlists, media, and supported subtitles through local signed URLs to the web player or an Xtream/M3U client. Videos aren't stored as a downloaded library. Availability depends on the upstream streams.

Settings, profiles, and watch history stay in your private `data/` directory. LAN access is open by default; enable **Require login on LAN** in General settings if you want sign-in. IPTV clients always need credentials.

<p align="center">
  <a href="docs/SETUP.md">Setup &amp; backups</a> · <a href="IPTV.md">IPTV / API reference</a> · <a href="THIRD_PARTY_NOTICES.md">Credits</a>
</p>
