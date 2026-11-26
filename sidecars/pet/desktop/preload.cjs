const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__hagemiDesktop', {
  setInteractive: interactive => ipcRenderer.send('hagemi:hit', !!interactive),
  setCursorTracking: payload => ipcRenderer.send('hagemi:cursor-tracking', payload),
  setHostMinimized: minimized => ipcRenderer.send('hagemi:host-minimized', !!minimized),
  setWindowPrefs: payload => ipcRenderer.send('hagemi:window-prefs', payload),
  listDisplays: () => ipcRenderer.invoke('hagemi:displays'),
  getIdleSec: () => ipcRenderer.invoke('hagemi:idle'),
  getIdleState: () => ipcRenderer.invoke('hagemi:idle-state'),
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
