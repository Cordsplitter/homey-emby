'use strict';

module.exports = {

  async getState({ homey, query }) {
    const app = homey.app;
    const device = query.device;
    if (!device) return { idle: true };

    const state   = app._playingState[device];
    const session = app._sessionMap[device];

    if (!state || (!state.playing && !state.paused)) {
      return { idle: true };
    }

    const imageId = state.seriesId || state.itemId || null;
    let artworkUrl = null;
    let artworkUrlFallback = null;
    if (imageId && app._apiKey) {
      const isSecure = app._isSecure();
      const protocol = isSecure ? 'https' : 'http';
      const portStr  = isSecure && app._port == 443 ? '' : ':' + app._port;
      const base     = `${protocol}://${app._host}${portStr}/Items/${imageId}/Images`;
      const auth     = `api_key=${app._apiKey}&maxWidth=200&quality=85`;
      const artTag     = state.artTag     ? `&tag=${state.artTag}`     : '';
      const primaryTag = state.primaryTag ? `&tag=${state.primaryTag}` : '';
      artworkUrl         = `${base}/Art?${auth}${artTag}`;
      artworkUrlFallback = `${base}/Primary?${auth}${primaryTag}`;
    }

    return {
      idle:                  false,
      playing:               state.playing,
      paused:                state.paused,
      title:                 state.title     || '',
      mediaType:             state.mediaType || '',
      user:                  state.user      || '',
      season:                state.season    || null,
      episode:               state.episode   || null,
      positionSec:           state.positionSec || 0,
      runtimeSec:            state.runtimeSec  || 0,
      artworkUrl,
      artworkUrlFallback,
      supportsRemoteControl: session ? session.supportsRemoteControl : false,
    };
  },

  async sendCommand({ homey, body }) {
    const { device, command } = body;
    if (!device || !command) throw new Error('Missing device or command');

    const session = homey.app._sessionMap[device];
    if (!session) throw new Error(`No session found for device: ${device}`);
    if (!session.supportsRemoteControl) throw new Error('Device does not support remote control');

    const validCommands = ['Pause', 'Unpause', 'Stop'];
    if (!validCommands.includes(command)) throw new Error(`Invalid command: ${command}`);

    await homey.app._sendCommand(session.sessionId, command);
    return { success: true };
  },

};