<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/branding/readme-banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/branding/readme-banner-light.svg">
    <img src="docs/branding/readme-banner-light.svg" alt="watch.local — Any stream on any screen" width="100%">
  </picture>
</p>

<p align="center">
  Movies, series, live TV, and sports. One app on your home network.<br>
  Watch in your browser or connect your favourite IPTV player.
</p>

<p align="center">
  <a href="#watch-your-way">The app</a> · <a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="docs/SETUP.md">Server setup</a>
</p>

## Watch your way

Run watch.local on a computer or Raspberry Pi, then browse from the devices already on your home network. The web interface brings movies, series, live channels, and sports into one library, with search, artwork, and a layout that fits phones and desktops.

- **Pick up where you left off.** Profiles keep watch history separate. Continue Watching resumes movies and episodes, then queues the next released episode when you finish.
- **Use the screen you prefer.** Watch in the browser, use native fullscreen playback on supported phones, or connect an IPTV app on your TV or console.
- **Keep a single channel lineup.** Matching live feeds share a card, with alternate sources available as fallbacks.

## Install

You'll need **[Node.js 24+](https://nodejs.org/en/download)**, npm, and Git. Starting with a fresh Pi? [Install the dependencies first.](docs/SETUP.md#raspberry-pi-and-linux)

```sh
git clone https://github.com/JackHars/watch.local.git
cd watch.local
npm ci
npm start
```

Create your username and password in the terminal, then open **[watch.local:8091](http://watch.local:8091)** on your home network. You can also use the server's IP address and port `8091`. No API key is needed to get started.

Keep the host running while you watch. [Run it at boot on a Pi or Linux server.](docs/SETUP.md#run-at-boot)

### Connect an IPTV app

In your player, choose **Xtream Codes** and enter the server URL, username, and password from **Settings → IPTV connections**. Prefer a playlist? The same page provides **M3U** and **XMLTV** guide links. Choose **HLS / m3u8** if the player asks for a stream format. External IPTV apps manage their own watch history.

### Local discovery

The app advertises `watch.local` over mDNS on compatible home networks—no router changes needed. Enable **Settings → General → Web interface on port 80** and restart to use **[http://watch.local](http://watch.local)** without a port number. IPTV stays on port `8091`. [Network and Docker setup →](docs/SETUP.md#local-discovery)

### Automatic updates

[Install the host updater](docs/SETUP.md#automatic-updates), then enable **Settings → Updates → Automatic updates**. It follows `main`, waits for GitHub checks to pass, and restarts the server after installing an update.

## How it works

<img src="docs/branding/stream-flow.svg" alt="Resolve public web-player streams, verify the media, then relay it to your screen." width="100%">

watch.local reverse-engineers public web players to resolve their streams on demand. It reproduces the player's requests, decodes source responses, and finds the underlying HLS playlists. Video and audio are checked before playback; failed sources fall through to the next enabled source.

You control the fallback order and enabled sources in Settings. If a movie or episode later reports a playback error, the web player tries another source and carries over your watched position. Attempts are bounded so unavailable titles don't loop forever.

A Node.js server relays playlists, media, and supported subtitles through local signed URLs to the web player or an Xtream/M3U client. Videos aren't stored as a downloaded library. Availability depends on the upstream streams.

Settings, profiles, and watch history stay in your private `data/` directory; back it up when moving or reinstalling the server. LAN access is open by default; enable **Require login on LAN** in General settings if you want sign-in. IPTV clients always need credentials.

<p align="center">
  <a href="docs/SETUP.md">Setup &amp; backups</a> · <a href="IPTV.md">IPTV / API reference</a> · <a href="THIRD_PARTY_NOTICES.md">Credits</a>
</p>
