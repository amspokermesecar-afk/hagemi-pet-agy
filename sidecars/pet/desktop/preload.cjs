const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__hagemiDesktop', {
  setInteractive: interactive => ipcRenderer.send('hagemi:hit', !!interactive),
  getIdleSec: () => ipcRenderer.invoke('hagemi:idle'),
  notify: payload => ipcRenderer.send('hagemi:notify', payload),
  focusConversation: payload => ipcRenderer.send('hagemi:focus-conversation', payload),
  onCursorMove: cb => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('hagemi:cursor', (_event, payload) => cb(payload));
  },
  onNotificationClicked: cb => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('hagemi:notification-clicked', (_event, payload) => cb(payload));
  },
});
