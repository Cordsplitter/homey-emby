'use strict';

const Homey = require('homey');
const http  = require('http');
const https = require('https');

const POLL_INTERVAL_MS = 2_000;
const DEBUG = false;
// How long a paused session can disappear before we call it stopped.
// Many Emby clients drop the session after a few minutes of being paused.
const PAUSE_GRACE_MS = 5 * 60 * 1000;
// If a session disappears with at least this much watched, treat as finished
// rather than stopped (REST API doesn't expose PlayedToCompletion).
const FINISHED_THRESHOLD = 0.90;

class EmbyApp extends Homey.App {

  async onInit() {
    this.log('Emby app initialising...');

    // Initialise state first
    this._playingState      = {};
    this._pendingStops      = {};   // device → { state, expiresAt }
    this._sessionMap        = {};
    this._idleSince         = {};   // device → { since: ms, firedSeconds: Set<number> }
    this._idleCheckInterval = null;
    this._transcodingState  = {};
    this._onlineState       = {};
    this._activeUsers       = new Set();
    this._embyAvailable     = null;
    this._polling           = false;
    this._lastInsightUpdate = 0;
    this._libraries         = [];
    this._insightsReady     = false;

    // New content tracking
    this._lastContentCheck    = {};   // { libraryId: ISOstring }
    this._contentCheckRunning = false;

    // Flow triggers
    this._triggerStarted = this.homey.flow.getTriggerCard('playback_started');
    this._triggerStarted.registerRunListener((args, state) => {
      if (args.device && args.device.trim() !== '' && args.device.toLowerCase() !== state.device.toLowerCase()) return false;
      return true;
    });

    this._triggerStopped = this.homey.flow.getTriggerCard('playback_stopped');
    this._triggerStopped.registerRunListener((args, state) => {
      if (args.device && args.device.trim() !== '' && args.device.toLowerCase() !== state.device.toLowerCase()) return false;
      return true;
    });

    this._triggerPaused = this.homey.flow.getTriggerCard('playback_paused');
    this._triggerPaused.registerRunListener((args, state) => {
      if (args.device && args.device.trim() !== '' && args.device.toLowerCase() !== state.device.toLowerCase()) return false;
      return true;
    });

    this._triggerResumed = this.homey.flow.getTriggerCard('playback_resumed');
    this._triggerResumed.registerRunListener((args, state) => {
      if (args.device && args.device.trim() !== '' && args.device.toLowerCase() !== state.device.toLowerCase()) return false;
      return true;
    });

    this._triggerAnyStarted    = this.homey.flow.getTriggerCard('any_playback_started');
    this._triggerAnyStopped    = this.homey.flow.getTriggerCard('any_playback_stopped');
    this._triggerAvailable     = this.homey.flow.getTriggerCard('emby_available');
    this._triggerUnavailable   = this.homey.flow.getTriggerCard('emby_unavailable');
    this._triggerNewContent    = this.homey.flow.getTriggerCard('new_content_added');
    this._triggerMediaFinished = this.homey.flow.getTriggerCard('media_finished');

    this._triggerIdleFor    = this.homey.flow.getTriggerCard('playback_idle_for');
    this._triggerIdleFor.registerRunListener((args, state) => {
      if (args.device && args.device.trim() !== '' && args.device.toLowerCase() !== state.device.toLowerCase()) return false;
      const argsSeconds = args.unit === 'minutes' ? args.duration * 60 : args.duration;
      return argsSeconds === state.elapsedSeconds;
    });

    this._triggerAnyIdleFor = this.homey.flow.getTriggerCard('any_playback_idle_for');
    this._triggerAnyIdleFor.registerRunListener((args, state) => {
      const argsSeconds = args.unit === 'minutes' ? args.duration * 60 : args.duration;
      return argsSeconds === state.elapsedSeconds;
    });

    // Flow conditions
    this.homey.flow.getConditionCard('is_playing').registerRunListener((args) => {
      return this._playingState[args.device]?.playing === true;
    });

    this.homey.flow.getConditionCard('anyone_watching').registerRunListener(() => {
      return Object.values(this._playingState).some(s => s.playing);
    });

    this.homey.flow.getConditionCard('media_type_is').registerRunListener((args) => {
      return Object.values(this._playingState).some(s => s.playing && s.mediaType === args.mediaType);
    });

    this.homey.flow.getConditionCard('user_is').registerRunListener((args) => {
      return Object.values(this._playingState).some(s => s.playing && s.user.toLowerCase() === args.user.toLowerCase());
    });

    this.homey.flow.getConditionCard('library_is').registerRunListener((args) => {
      return Object.values(this._playingState).some(s => s.playing && s.library.toLowerCase() === args.library.toLowerCase());
    });

    this.homey.flow.getConditionCard('is_transcoding').registerRunListener((args) => {
      return this._transcodingState[args.device] === true;
    });

    this.homey.flow.getConditionCard('is_user_active').registerRunListener((args) => {
      return this._activeUsers.has(args.user.toLowerCase());
    });

    this.homey.flow.getConditionCard('is_device_online').registerRunListener((args) => {
      return this._onlineState[args.device] === true;
    });

    this.homey.flow.getConditionCard('emby_is_available').registerRunListener(() => {
      return this._embyAvailable === true;
    });

    this.homey.flow.getConditionCard('season_is').registerRunListener((args) => {
      return Object.values(this._playingState).some(s => (s.playing || s.paused) && s.season === args.season);
    });

    this.homey.flow.getConditionCard('episode_is').registerRunListener((args) => {
      return Object.values(this._playingState).some(s => (s.playing || s.paused) && s.episode === args.episode);
    });

    // Flow actions
    this.homey.flow.getActionCard('playback_pause').registerRunListener(async (args) => {
      const sessionId = this._getSessionId(args.device);
      await this._sendCommand(sessionId, 'Pause');
    });

    this.homey.flow.getActionCard('playback_resume').registerRunListener(async (args) => {
      const sessionId = this._getSessionId(args.device);
      await this._sendCommand(sessionId, 'Unpause');
    });

    this.homey.flow.getActionCard('playback_stop').registerRunListener(async (args) => {
      const sessionId = this._getSessionId(args.device);
      await this._sendCommand(sessionId, 'Stop');
    });

    this.homey.flow.getActionCard('playback_next').registerRunListener(async (args) => {
      const sessionId = this._getSessionId(args.device, 'NextTrack');
      await this._sendGeneralCommand(sessionId, 'NextTrack');
    });

    this.homey.flow.getActionCard('playback_previous').registerRunListener(async (args) => {
      const sessionId = this._getSessionId(args.device, 'PreviousTrack');
      await this._sendGeneralCommand(sessionId, 'PreviousTrack');
    });

    // Widgets
    try {
      this._nowPlayingWidget = this.homey.dashboards.getWidget('now-playing');
      this._whatsOnWidget    = this.homey.dashboards.getWidget('whats-on');
      this._recentlyAddedWidget = this.homey.dashboards.getWidget('recently-added');
    } catch (err) {
      this.log('Widgets not available:', err.message);
    }

    // Settings
    this._host   = this.homey.settings.get('host')   || null;
    this._port   = this.homey.settings.get('port')   || 443;
    this._apiKey = this.homey.settings.get('apiKey') || null;

    this.homey.settings.on('set', (key) => {
      if (key === 'host')   this._host   = this.homey.settings.get('host');
      if (key === 'port')   this._port   = this.homey.settings.get('port');
      if (key === 'apiKey') this._apiKey = this.homey.settings.get('apiKey');
      if (key === 'monitoredLibraries' || key === 'contentCheckInterval') {
        this._restartContentCheck();
      }
    });

    // Cache libraries
    this._loadLibraries();
    this._librariesInterval = setInterval(() => this._loadLibraries(), 3_600_000);

    // Start polling
    this._poll();
    this._interval = setInterval(() => this._poll(), POLL_INTERVAL_MS);

    // Idle-for triggers run every second so we can support both seconds and minutes precision
    this._idleCheckInterval = setInterval(() => this._checkIdleTriggers(), 1000);

    // Start new content check
    this._startContentCheck();

    this.log('Emby app ready');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _debug(...args) {
    if (DEBUG) this.log(...args);
  }

  _markIdle(device, since) {
    // Capture last-known tokens for the idle-for trigger so flows still get device/title context
    const prev = this._playingState[device] || this._pendingStops[device]?.state || {};
    this._idleSince[device] = {
      since,
      firedSeconds: new Set(),  // which second-thresholds have already fired
      tokens: {
        device,
        title:     prev.title     || '',
        mediaType: prev.mediaType || '',
        user:      prev.user      || '',
        library:   prev.library   || '',
      },
    };
  }

  _checkIdleTriggers() {
    const now = Date.now();
    for (const [device, entry] of Object.entries(this._idleSince)) {
      const elapsedSeconds = Math.floor((now - entry.since) / 1000);
      if (elapsedSeconds < 1) continue;

      if (!entry.firedSeconds.has(elapsedSeconds)) {
        entry.firedSeconds.add(elapsedSeconds);

        // Token formatting: report in the friendlier unit
        const inMinutes = elapsedSeconds >= 60 && elapsedSeconds % 60 === 0;
        const duration  = inMinutes ? elapsedSeconds / 60 : elapsedSeconds;
        const unit      = inMinutes ? 'minutes' : 'seconds';

        const state = {
          device,
          elapsedSeconds,
        };
        const tokens = {
          ...entry.tokens,
          duration,
          unit,
        };
        this._debug(`⌚ ${device} idle for ${elapsedSeconds}s`);
        this._triggerIdleFor.trigger(tokens, state).catch(this.error);
        this._triggerAnyIdleFor.trigger(tokens, state).catch(this.error);
      }
    }
  }
  
  _isSecure() {
    const useHttps = this.homey.settings.get('useHttps');
    if (useHttps === true)  return true;
    if (useHttps === false) return false;
    // Backward-compatible fallback for installs without the setting
    return this._port === 443 || this._port === '443';
  }

  _lib() {
    return this._isSecure() ? https : http;
  }

  async _initInsights() {
    if (this._insightsReady) return;
    try {
      this._insightPeopleWatching = await this._getOrCreateLog('people_watching', {
        label: { en: 'People Watching' }, title: { en: 'People Watching' }, type: 'number', units: 'People',
      });
      this._insightAnyoneWatching = await this._getOrCreateLog('anyone_watching', {
        label: { en: 'Anyone Watching' }, title: { en: 'Anyone Watching' }, type: 'number', units: 'Yes/No',
      });
      this._insightTranscoding = await this._getOrCreateLog('transcoding_active', {
        label: { en: 'Transcoding Active' }, title: { en: 'Transcoding Active' }, type: 'number', units: 'Yes/No',
      });
      this.log('Insights initialised');
    } catch (err) {
      this.log('Insights init failed:', err.message);
    }
    this._insightsReady = true;
  }

  _getMediaType(item) {
    if (!item) return 'Unknown';
    switch (item.Type) {
      case 'Episode':    return 'TV Show';
      case 'Movie':      return 'Movie';
      case 'Audio':      return 'Music';
      case 'MusicVideo': return 'Music Video';
      default:           return item.Type || 'Unknown';
    }
  }

  _getTitle(item) {
    if (!item) return '';
    if (item.Type === 'Episode') return item.SeriesName || item.Name || '';
    return item.Name || '';
  }

  _getLibraryName(path) {
    if (!path || !this._libraries) return 'Unknown';
    for (const lib of this._libraries) {
      for (const location of lib.Locations || []) {
        if (path.toLowerCase().startsWith(location.toLowerCase())) {
          return lib.Name;
        }
      }
    }
    return 'Unknown';
  }

  _getSessionId(deviceName, requiredCommand = null) {
    const entry = this._sessionMap[deviceName];
    if (!entry) throw new Error(`No active session found for device: ${deviceName}`);
    if (!entry.supportsRemoteControl) throw new Error(`Device does not support remote control: ${deviceName}`);
    if (requiredCommand && !entry.supportedCommands.includes(requiredCommand)) {
      throw new Error(`Device does not support command: ${requiredCommand}`);
    }
    return entry.sessionId;
  }

  // ── New content checking ──────────────────────────────────────────────────

  _startContentCheck() {
    const intervalMins = parseInt(this.homey.settings.get('contentCheckInterval') || 60, 10);
    const intervalMs   = Math.max(intervalMins, 5) * 60 * 1000; // minimum 5 minutes
    this.log(`New content check interval: ${intervalMins} minutes`);
    this._contentInterval = setInterval(() => this._checkNewContent(), intervalMs);
  }

  _restartContentCheck() {
    if (this._contentInterval) clearInterval(this._contentInterval);
    this._startContentCheck();
  }

  async _checkNewContent() {
    if (this._contentCheckRunning || !this._apiKey || !this._embyAvailable) return;
    this._contentCheckRunning = true;

    try {
      const monitoredLibraries = this.homey.settings.get('monitoredLibraries') || [];
      if (monitoredLibraries.length === 0) return;

      const now = new Date().toISOString();

      for (const lib of this._libraries) {
        if (!monitoredLibraries.includes(lib.ItemId)) continue;

        const lastCheck = this._lastContentCheck[lib.ItemId] || null;

        // On first run, just record the current timestamp without firing triggers
        if (!lastCheck) {
          this._lastContentCheck[lib.ItemId] = now;
          continue;
        }

        const path = `/Items?SortBy=DateCreated&SortOrder=Descending&Recursive=true&IsNotFolder=true&Limit=20&ParentId=${lib.ItemId}&Fields=DateCreated,ProductionYear,Type&api_key=${this._apiKey}`;

        let data;
        try {
          data = await this._apiGet(path);
        } catch (err) {
          this.error(`Failed to check new content for ${lib.Name}:`, err.message);
          continue;
        }

        const items = data.Items || [];
        const newItems = items.filter(item => {
          if (!item.DateCreated) return false;
          return new Date(item.DateCreated) > new Date(lastCheck);
        });

        for (const item of newItems) {
          const title     = item.SeriesName || item.Name || 'Unknown';
          const mediaType = this._getMediaType(item);
          const year      = item.ProductionYear ? String(item.ProductionYear) : '';

          this.log(`New content in ${lib.Name}: "${title}" (${mediaType})`);

          this._triggerNewContent.trigger({
            title,
            library:   lib.Name,
            mediaType,
            year,
          }).catch(this.error);
        }

        this._lastContentCheck[lib.ItemId] = now;
      }
    } finally {
      this._contentCheckRunning = false;
    }
  }

  // ── Emby API ──────────────────────────────────────────────────────────────

  _apiGet(path) {
    return new Promise((resolve, reject) => {
      const req = this._lib().request(
        { hostname: this._host, port: this._port, path, method: 'GET' },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`Emby returned status ${res.statusCode}`));
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Failed to parse Emby response')); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Emby request timeout')));
      req.end();
    });
  }

  _getSessions() {
    return this._apiGet(`/Sessions?api_key=${this._apiKey}`);
  }

  _getLibraries() {
    return this._apiGet(`/Library/VirtualFolders?api_key=${this._apiKey}`);
  }

  _sendCommand(sessionId, command) {
    return new Promise((resolve, reject) => {
      const req = this._lib().request(
        { hostname: this._host, port: this._port, path: `/Sessions/${sessionId}/Playing/${command}?api_key=${this._apiKey}`, method: 'POST' },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Emby returned status ${res.statusCode}`));
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Emby command timeout')));
      req.end();
    });
  }

  _sendGeneralCommand(sessionId, command) {
    return new Promise((resolve, reject) => {
      const req = this._lib().request(
        { hostname: this._host, port: this._port, path: `/Sessions/${sessionId}/Command/${command}?api_key=${this._apiKey}`, method: 'POST' },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Emby returned status ${res.statusCode}`));
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Emby command timeout')));
      req.end();
    });
  }

  async _loadLibraries() {
    if (!this._apiKey) return;
    try {
      this._libraries = await this._getLibraries();
      this.log(`Loaded ${this._libraries.length} libraries`);
    } catch (err) {
      this.error('Failed to load libraries:', err.message);
    }
  }

  async _getOrCreateLog(id, options) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Insights timeout')), 3000)
    );
    try {
      return await Promise.race([this.homey.insights.createLog(id, options), timeout]);
    } catch (err) {
      if (err.message === 'Log Already Exists') {
        try {
          return await Promise.race([
            this.homey.insights.getLog(id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Insights timeout')), 3000)),
          ]);
        } catch (e) {
          this.log('Could not get existing log:', e.message);
          return null;
        }
      }
      this.log('Could not create log:', err.message);
      return null;
    }
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  async _poll() {
    if (this._polling) return;
    this._polling = true;

    try {
      if (!this._apiKey) return;
      if (!this._insightsReady) await this._initInsights();

      let sessions;
      try {
        sessions = await this._getSessions();

        if (this._embyAvailable === false) {
          this.log('Emby became available');
          this._embyAvailable = true;
          await this._triggerAvailable.trigger().catch(this.error);
          await this._loadLibraries();
        } else {
          this._embyAvailable = true;
        }
      } catch (err) {
        this.error('Failed to reach Emby:', err.message);

        if (this._embyAvailable !== false) {
          this.log('Emby became unavailable');
          this._embyAvailable = false;
          await this._triggerUnavailable.trigger().catch(this.error);

          for (const device of Object.keys(this._playingState)) {
            const prev = this._playingState[device];
            if (prev.playing || prev.paused) {
              const tokens = {
                device, count: 0,
                title: prev.title || '', mediaType: prev.mediaType || '',
                user: prev.user || '', library: prev.library || '',
              };
              this._triggerStopped.trigger(tokens, { device }).catch(this.error);
              this._triggerAnyStopped.trigger(tokens).catch(this.error);
            }
          }

          this._playingState     = {};
          this._pendingStops     = {};
          this._idleSince        = {};
          this._transcodingState = {};
          this._onlineState      = {};
          this._activeUsers      = new Set();
        }
        return;
      }

      // Reset per-poll state
      this._onlineState      = {};
      this._activeUsers      = new Set();
      this._transcodingState = {};

      const current = {};
      for (const session of sessions) {
        const device = session.DeviceName;
        const item   = session.NowPlayingItem;
        const state  = session.PlayState;

        this._sessionMap[device] = {
          sessionId:             session.Id,
          deviceId:              session.DeviceId,
          supportsRemoteControl: session.SupportsRemoteControl,
          supportedCommands:     session.SupportedCommands  || [],
          playableMediaTypes:    session.PlayableMediaTypes || [],
        };

        this._onlineState[device] = true;
        if (session.UserName) this._activeUsers.add(session.UserName.toLowerCase());
        this._transcodingState[device] = !!(session.TranscodingInfo && item);

        if (item) {
          // For episodes, Art and Primary typically live on the series, exposed
          // via Parent*/Series* tags on the episode item itself.
          const artTag     = item.ImageTags?.Art
                          || item.ParentArtImageTag
                          || null;
          const primaryTag = item.ImageTags?.Primary
                          || item.SeriesPrimaryImageTag
                          || item.ParentPrimaryImageTag
                          || null;

          // Position and runtime in seconds (Emby reports ticks; 10M ticks = 1 second)
          const positionSec = state?.PositionTicks ? Math.round(state.PositionTicks / 10_000_000) : 0;
          const runtimeSec  = item.RunTimeTicks    ? Math.round(item.RunTimeTicks    / 10_000_000) : 0;
          const progressPct = runtimeSec > 0 ? (positionSec / runtimeSec) : 0;

          current[device] = {
            playing:    state?.IsPaused === false,
            paused:     state?.IsPaused === true,
            title:      this._getTitle(item),
            mediaType:  this._getMediaType(item),
            user:       session.UserName || '',
            library:    this._getLibraryName(item.Path),
            itemId:     item.Id       || null,
            seriesId:   item.SeriesId || null,
            season:     item.ParentIndexNumber || null,
            episode:    item.IndexNumber       || null,
            artTag,
            primaryTag,
            positionSec,
            runtimeSec,
            progressPct,
          };
        }
      }

      const count = Object.values(current).filter(s => s.playing).length;

      const allDevices = new Set([
        ...Object.keys(this._playingState),
        ...Object.keys(current),
      ]);

      const now = Date.now();

      // First: any pending stops that have come back (session reappeared) get cancelled
      for (const device of Object.keys(this._pendingStops)) {
        if (current[device]) {
          this._debug(`↺  ${device} resumed from pause-disconnect — cancelling pending stop`);
          delete this._pendingStops[device];
        }
      }

      for (const device of allDevices) {
        const prev = this._playingState[device]
                  || this._pendingStops[device]?.state
                  || { playing: false, paused: false };
        const curr = current[device]            || { playing: false, paused: false };

        const tokens = {
          device, count,
          title:        curr.title     || '',
          mediaType:    curr.mediaType || '',
          user:         curr.user      || '',
          library:      curr.library   || '',
          season:       curr.season    || 0,
          episode:      curr.episode   || 0,
          episode_code: (curr.season && curr.episode)
            ? 'S' + String(curr.season).padStart(2, '0') + 'E' + String(curr.episode).padStart(2, '0')
            : '',
        };

        const prevTokens = {
          ...tokens,
          title:        prev.title     || '',
          mediaType:    prev.mediaType || '',
          user:         prev.user      || '',
          library:      prev.library   || '',
          season:       prev.season    || 0,
          episode:      prev.episode   || 0,
          episode_code: (prev.season && prev.episode)
            ? 'S' + String(prev.season).padStart(2, '0') + 'E' + String(prev.episode).padStart(2, '0')
            : '',
        };

        // Started: was idle, now playing
        if (!prev.playing && !prev.paused && curr.playing) {
          this._debug(`▶  ${device} started "${tokens.title}" (${tokens.mediaType}) [${tokens.library}] — ${tokens.user} (watching: ${count})`);
          this._triggerStarted.trigger(tokens, { device }).catch(this.error);
          this._triggerAnyStarted.trigger(tokens).catch(this.error);
          // Cancel any idle tracking — device is active again
          delete this._idleSince[device];
        }

        // Session disappeared
        if ((prev.playing || prev.paused) && !curr.playing && !curr.paused) {
          const wasPaused   = prev.paused;
          const watchedPct  = prev.progressPct || 0;
          const finished    = watchedPct >= FINISHED_THRESHOLD;

          if (finished) {
            // Fire finished + stopped immediately; don't grace-window a completed item
            this._debug(`✓  ${device} finished "${prev.title}" at ${Math.round(watchedPct * 100)}% — firing media_finished`);
            this._triggerMediaFinished.trigger(prevTokens).catch(this.error);
            this._triggerStopped.trigger(prevTokens, { device }).catch(this.error);
            this._triggerAnyStopped.trigger(prevTokens).catch(this.error);
            this._markIdle(device, now);
          } else if (wasPaused) {
            // Paused session vanished — start the grace window
            this._debug(`⏳  ${device} paused-and-vanished, waiting ${PAUSE_GRACE_MS / 60000} min before firing stopped`);
            this._pendingStops[device] = {
              state:     prev,
              tokens:    prevTokens,
              expiresAt: now + PAUSE_GRACE_MS,
            };
          } else {
            // Was actively playing — fire stopped immediately as before
            this._debug(`■  ${device} stopped "${prev.title}" at ${Math.round(watchedPct * 100)}%`);
            this._triggerStopped.trigger(prevTokens, { device }).catch(this.error);
            this._triggerAnyStopped.trigger(prevTokens).catch(this.error);
            this._markIdle(device, now);
          }
        }

        // Paused: was playing, now paused
        if (prev.playing && curr.paused) {
          this._debug(`⏸  ${device} paused "${tokens.title}"`);
          this._triggerPaused.trigger(tokens, { device }).catch(this.error);
        }

        // Resumed: was paused, now playing again
        if (prev.paused && curr.playing) {
          this._debug(`▶  ${device} resumed "${tokens.title}"`);
          this._triggerResumed.trigger(tokens, { device }).catch(this.error);
        }

        this._playingState[device] = curr;

        if (!curr.playing && !curr.paused) {
          delete this._playingState[device];
        }
      }

      // Process expired pending stops
      for (const [device, pending] of Object.entries(this._pendingStops)) {
        if (now >= pending.expiresAt) {
          this._debug(`■  ${device} stopped (after pause grace window)`);
          this._triggerStopped.trigger(pending.tokens, { device }).catch(this.error);
          this._triggerAnyStopped.trigger(pending.tokens).catch(this.error);
          delete this._pendingStops[device];
          // Backdate idle-since to when the device originally disappeared
          this._markIdle(device, pending.expiresAt - PAUSE_GRACE_MS);
        }
      }

      // Update Insights (once per minute)
      if (this._insightsReady) {
        if (now - this._lastInsightUpdate >= 60_000) {
          this._lastInsightUpdate = now;
          const anyoneWatching    = count > 0;
          const transcodingActive = Object.values(this._transcodingState).some(Boolean);
          if (this._insightPeopleWatching) await this._insightPeopleWatching.createEntry(count).catch(this.error);
          if (this._insightAnyoneWatching) await this._insightAnyoneWatching.createEntry(anyoneWatching ? 1 : 0).catch(this.error);
          if (this._insightTranscoding)    await this._insightTranscoding.createEntry(transcodingActive ? 1 : 0).catch(this.error);
        }
      }

      // Update Homey devices
      try {
        const embyDriver = this.homey.drivers.getDriver('emby-player');
        for (const device of embyDriver.getDevices()) {
          const deviceName = device.getStoreValue('deviceName');
          await device.updateState(current[deviceName] || null).catch(this.error);
        }
      } catch (err) {
        // Driver not yet initialised — skip
      }

      // Notify widgets
      try {
        if (this._nowPlayingWidget) this._nowPlayingWidget.emit('state_update', {});
        if (this._whatsOnWidget)    this._whatsOnWidget.emit('state_update', {});
        if (this._recentlyAddedWidget) this._recentlyAddedWidget.emit('state_update', {});
      } catch (err) {
        // widgets not available
      }

    } finally {
      this._polling = false;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  onUninit() {
    clearInterval(this._interval);
    clearInterval(this._contentInterval);
    clearInterval(this._librariesInterval);
    clearInterval(this._idleCheckInterval);
  }

}

module.exports = EmbyApp;