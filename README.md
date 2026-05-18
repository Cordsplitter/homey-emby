# Emby for Homey

A Homey Pro app that integrates [Emby](https://emby.media) media servers with Homey Flows, dashboards, and Insights.

## Features

- **9 Flow triggers** — playback started/stopped/paused/resumed (per-device and any-device), Emby available/unavailable, new content added to monitored libraries
- **11 Flow conditions** — is playing, anyone watching, media type / user / library filters, transcoding active, device online, season/episode number checks
- **5 Flow actions** — pause, resume, stop, next track, previous track
- **3 dashboard widgets** — Now Playing (single device), What's On (all sessions), Recently Added (scrollable artwork)
- **Speaker device** — full media tile with album art, play/pause/skip controls, volume control
- **Insights logs** — people watching, anyone watching, transcoding active

## Setup

1. Install the app
2. In Emby: Dashboard → Advanced → API Keys → New API Key
3. In Homey: app settings → enter host, port, API key
4. Optionally configure the "New Content Notifications" section with libraries to monitor
5. Add an Emby Player device for each playback device you want to control (something must be playing on it for it to appear in the pairing list)

## Server requirements

Works with any Emby Server reachable from your Homey Pro over HTTP or HTTPS. For HTTPS, use either Emby's built-in HTTPS port or a reverse proxy with a valid certificate (Caddy, Traefik, nginx).

## Settings

| Setting | Description |
| --- | --- |
| Host | Emby hostname or IP (e.g. `emby.example.com` or `192.168.0.50`) |
| Port | Emby port (443 / 8920 for HTTPS, 8096 for HTTP) |
| Use HTTPS | Tick if the server is HTTPS |
| API Key | Emby API key from Dashboard → Advanced → API Keys |
| Check Interval | How often to poll for newly-added content (minimum 5 minutes) |
| Monitor Libraries | Which Emby libraries to watch for new content |

## Author

David Lettice ([@Cordsplitter](https://github.com/Cordsplitter))

## License

[MIT](LICENSE)