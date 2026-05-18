'use strict';

module.exports = {

  async getSessions({ homey }) {
    const app = homey.app;
    const playingState = app._playingState || {};
    const count = Object.values(playingState).filter(s => s.playing).length;

    const isSecure = app._isSecure();
    const protocol = isSecure ? 'https' : 'http';
    const portStr  = isSecure && app._port == 443 ? '' : ':' + app._port;
    const baseUrl  = `${protocol}://${app._host}${portStr}`;
    const auth     = `api_key=${app._apiKey}&maxWidth=120&quality=85`;

    const sessions = Object.entries(playingState)
      .filter(([, state]) => state.playing || state.paused)
      .map(([device, state]) => {
        const imageId = state.seriesId || state.itemId || null;
        let artworkUrl = null;
        let artworkUrlFallback = null;
        if (imageId && app._apiKey) {
          const artTag     = state.artTag     ? `&tag=${state.artTag}`     : '';
          const primaryTag = state.primaryTag ? `&tag=${state.primaryTag}` : '';
          artworkUrl         = `${baseUrl}/Items/${imageId}/Images/Art?${auth}${artTag}`;
          artworkUrlFallback = `${baseUrl}/Items/${imageId}/Images/Primary?${auth}${primaryTag}`;
        }
        return {
          device,
          playing:   state.playing,
          paused:    state.paused,
          title:     state.title     || '',
          mediaType: state.mediaType || '',
          user:      state.user      || '',
          artworkUrl,
          artworkUrlFallback,
        };
      });

    return { count, sessions };
  },

};