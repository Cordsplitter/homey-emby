'use strict';

module.exports = {

  async getItems({ homey, query }) {
    const libraryFilter = (query.library || '').trim().toLowerCase();
    const limit = parseInt(query.limit, 10) || 10;

    if (!homey.app._apiKey) return { items: [] };

    // Find matching library IDs
    let parentIds = [];
    if (libraryFilter && homey.app._libraries) {
      const matched = homey.app._libraries.filter(function(lib) {
        return lib.Name.toLowerCase() === libraryFilter;
      });
      parentIds = matched.map(function(lib) { return lib.ItemId; });
    }

    const isSecure = homey.app._isSecure();
    const protocol = isSecure ? 'https' : 'http';
    const host     = homey.app._host;
    const port     = homey.app._port;
    const apiKey   = homey.app._apiKey;

    const http  = require('http');
    const https = require('https');
    const lib   = isSecure ? https : http;

    const portStr = (isSecure && port == 443) || (!isSecure && port == 80) ? '' : ':' + port;
    const baseUrl = `${protocol}://${host}${portStr}`;

    const fetchItems = (parentId) => new Promise((resolve, reject) => {
      let path = `/Items?SortBy=DateCreated&SortOrder=Descending&Recursive=true&IsNotFolder=true&IncludeItemTypes=Movie,Episode,Audio,MusicAlbum&Limit=${limit}&Fields=PrimaryImageAspectRatio,DateCreated,ProductionYear,Type,ImageTags&api_key=${apiKey}`;
      if (parentId) path += `&ParentId=${parentId}`;

      const req = lib.request(
        { hostname: host, port, path, method: 'GET' },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`Emby returned status ${res.statusCode}`));
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse error')); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Recently-added request timeout')));
      req.end();
    });

    try {
      let results;
      if (parentIds.length > 0) {
        results = await fetchItems(parentIds[0]);
      } else {
        results = await fetchItems(null);
      }

      const items = (results.Items || []).map(function(item) {
        const imageId = item.SeriesId || item.Id;
        const tag = (item.ImageTags && item.ImageTags.Primary)
                 || item.SeriesPrimaryImageTag
                 || item.ParentPrimaryImageTag
                 || null;
        const tagParam = tag ? `&tag=${tag}` : '';
        const imageUrl = `${baseUrl}/Items/${imageId}/Images/Primary?api_key=${apiKey}&maxWidth=300&quality=85${tagParam}`;
        return {
          id:        item.Id,
          title:     item.SeriesName || item.Name || '',
          mediaType: item.Type === 'Episode' ? 'TV Show' : (item.Type || ''),
          year:      item.ProductionYear || '',
          imageUrl,
        };
      });

      return { items };
    } catch (err) {
      homey.app.log('Recently added fetch error:', err.message);
      return { items: [] };
    }
  },

};