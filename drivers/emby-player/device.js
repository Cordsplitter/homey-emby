'use strict';

const { Device } = require('homey');

class EmbyPlayerDevice extends Device {

  async onInit() {
    this.log(`EmbyPlayerDevice initialised: ${this.getName()}`);

    this._currentArtTag = null;

    this._albumArt = await this.homey.images.createImage();
    this.setAlbumArtImage(this._albumArt).catch(this.error);

    this.registerCapabilityListener('speaker_playing', async (value) => {
      const app        = this.homey.app;
      const deviceName = this.getStoreValue('deviceName');
      try {
        const sessionId = app._getSessionId(deviceName);
        await app._sendCommand(sessionId, value ? 'Unpause' : 'Pause');
      } catch (err) { this.error(err.message); throw err; }
    });

    this.registerCapabilityListener('speaker_next', async () => {
      const app        = this.homey.app;
      const deviceName = this.getStoreValue('deviceName');
      try {
        const sessionId = app._getSessionId(deviceName, 'NextTrack');
        await app._sendGeneralCommand(sessionId, 'NextTrack');
      } catch (err) { this.error(err.message); throw err; }
    });

    this.registerCapabilityListener('speaker_prev', async () => {
      const app        = this.homey.app;
      const deviceName = this.getStoreValue('deviceName');
      try {
        const sessionId = app._getSessionId(deviceName, 'PreviousTrack');
        await app._sendGeneralCommand(sessionId, 'PreviousTrack');
      } catch (err) { this.error(err.message); throw err; }
    });

    this.registerCapabilityListener('volume_set', async (value) => {
      const app        = this.homey.app;
      const deviceName = this.getStoreValue('deviceName');
      try {
        const sessionId = app._getSessionId(deviceName);
        await app._sendCommand(sessionId, `SetVolume?Volume=${Math.round(value * 100)}`);
      } catch (err) { this.error(err.message); throw err; }
    });

    this.registerCapabilityListener('volume_mute', async (value) => {
      const app        = this.homey.app;
      const deviceName = this.getStoreValue('deviceName');
      try {
        const sessionId = app._getSessionId(deviceName);
        await app._sendCommand(sessionId, value ? 'Mute' : 'Unmute');
      } catch (err) { this.error(err.message); throw err; }
    });
  }

  // ── State update ──────────────────────────────────────────────────────────

  async updateState(state) {
    if (!state || (!state.playing && !state.paused)) {
      this._currentArtTag = null;
      await this.setCapabilityValue('speaker_playing', false).catch(this.error);
      await this.setCapabilityValue('speaker_track',   '').catch(this.error);
      await this.setCapabilityValue('speaker_artist',  '').catch(this.error);
      return;
    }

    await this.setCapabilityValue('speaker_playing', state.playing).catch(this.error);
    await this.setCapabilityValue('speaker_track',   state.title  || '').catch(this.error);
    await this.setCapabilityValue('speaker_artist',  state.user   || '').catch(this.error);

    // Re-fetch only when the actual artwork content changes (tag is a content hash).
    // Falls back to itemId for items lacking a tag (rare).
    const tagKey = state.artTag || ('id:' + (state.itemId || ''));
    if (state.itemId && tagKey !== this._currentArtTag) {
      const app      = this.homey.app;
      const imageId  = state.seriesId || state.itemId;
      const isSecure = app._isSecure();
      const protocol = isSecure ? 'https' : 'http';
      const portStr  = isSecure && app._port == 443 ? '' : ':' + app._port;
      const tagParam = state.artTag ? `&tag=${state.artTag}` : '';
      const url      = `${protocol}://${app._host}${portStr}/Items/${imageId}/Images/Art?api_key=${app._apiKey}&maxWidth=500&quality=90${tagParam}`;
      // Uncomment for debugging artwork URLs:
      // this.log('Updating album art URL:', url);
      this._albumArt.setUrl(url);
      this._albumArt.update().catch(this.error);
      this._currentArtTag = tagKey;
    }
  }

  async onDeleted() {
    this.log(`EmbyPlayerDevice deleted: ${this.getName()}`);
  }

}

module.exports = EmbyPlayerDevice;