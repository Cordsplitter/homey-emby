Integrate your Emby media server with Homey Pro. Monitor what's playing across every device on your network, control playback from Flow, get notified when new content is added to your libraries, and surface live playback information on your dashboard with three custom widgets.

FEATURES

9 Flow triggers — playback started, stopped, paused, resumed (per-device and any-device), media finished (fires when an item is watched 90% to completion), playback idle for X seconds/minutes (per-device and any-device), Emby became available/unavailable, and new content added to monitored libraries.

11 Flow conditions covering "is playing", "anyone watching", filters for media type, user, and library, transcoding active, device online, season/episode number checks, and Emby availability.

5 Flow actions — pause, resume, stop, next, previous — sent over Emby's session API to whichever device you target.

Three dashboard widgets:
- Now Playing — shows what's currently playing on a chosen device, with album art, episode info, a live progress bar that interpolates between server updates, and play/pause/stop controls.
- What's On — all currently-active sessions across all devices in one list.
- Recently Added — horizontally scrolling artwork cards for the latest additions to your libraries.

Speaker device — every paired Emby device shows up as a speaker tile in Homey with album art, play/pause/skip controls, and volume.

Insights logs for people watching, anyone watching, and transcoding active — useful for graphing your household's viewing habits over time.

SETUP

1. Install the app.
2. In Emby Server, go to Dashboard > Advanced > API Keys and create a new API Key.
3. In Homey, open the Emby app settings and enter your host, port, "Use HTTPS" if applicable, and the API key.
4. Optionally configure the "New Content Notifications" section with which libraries to monitor.
5. Add an Emby Player device through Homey's "Add a device" flow.

SERVER REQUIREMENTS

Works with any Emby Server reachable from your Homey Pro over HTTP or HTTPS. For HTTPS, use either Emby's built-in HTTPS port (typically 8920) or a reverse proxy with a valid certificate.

SUPPORT

Bug reports and feature requests: https://github.com/Cordsplitter/homey-emby/issues
Community discussion: https://community.homey.app/t/app-emby-media-server-integration-for-homey-pro/155044
Source code: https://github.com/Cordsplitter/homey-emby