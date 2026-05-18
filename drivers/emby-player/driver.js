'use strict';

const { Driver } = require('homey');

class EmbyPlayerDriver extends Driver {

  async onInit() {
    this.log('EmbyPlayerDriver initialised');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      const app = this.homey.app;

      if (!app._apiKey) {
        throw new Error('Emby is not configured. Please set host, port, and API key in app settings first.');
      }

      // Fetch all devices that have ever connected to Emby
      let devices;
      try {
        const response = await app._apiGet(`/Devices?api_key=${app._apiKey}`);
        devices = response.Items || [];
      } catch (err) {
        throw new Error(`Could not connect to Emby: ${err.message}`);
      }

      if (devices.length === 0) {
        throw new Error('No devices found on Emby. Open Emby on at least one client first.');
      }

      // Sort by most recently active
      devices.sort((a, b) => {
        const da = new Date(a.DateLastActivity || 0).getTime();
        const db = new Date(b.DateLastActivity || 0).getTime();
        return db - da;
      });

      return devices.map((dev) => {
        const lastUser = dev.LastUserName ? ` · ${dev.LastUserName}` : '';
        const appName  = dev.AppName ? ` (${dev.AppName})` : '';
        return {
          name: `${dev.Name}${appName}${lastUser}`,
          data: {
            id: dev.Id || dev.Name,
          },
          store: {
            deviceName: dev.Name,
          },
        };
      });
    });
  }

}

module.exports = EmbyPlayerDriver;