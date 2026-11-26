const { app, BrowserWindow, ipcMain, Notification, powerMonitor, screen, shell } = require('electron');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

function getArg(prefix) {
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const targetUrl = getArg('--url=');
const parentPid = Number(getArg('--parent-pid=')) || 0;
const userDataDir = getArg('--user-data-dir=');

let parsedUrl;
try {
  parsedUrl = new URL(targetUrl);
} catch {
  process.exit(1);
}
const portNum = Number(parsedUrl.port);
if (
  parsedUrl.protocol !== 'http:' ||
  parsedUrl.hostname !== '127.0.0.1' ||
  !Number.isInteger(portNum) ||
  portNum < 1 ||
  portNum > 65535
) {
  process.exit(1);
}

app.setName('Hagemi Pet');
app.setAppUserModelId('com.hagemi.pet.antigravity');
if (userDataDir) {
  app.setPath('userData', userDataDir);
}

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ICON_PATH = join(__dirname, '..', '..', '..', 'assets', 'logo.png');
const activeNotifications = new Set();
const VALID_LEVELS = new Set(['floating', 'normal', 'screen-saver']);
let win = null;
let targetDisplayPref = 'primary';
let topLevelPref = 'floating';

function focusAntigravity(payload = {}) {
  const rawId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
  const safeId = /^[a-zA-Z0-9_-]{4,128}$/.test(rawId) ? rawId : '';
  const deepUrl = safeId ? `antigravity://conversation/${encodeURIComponent(safeId)}` : 'antigravity://open';
  shell.openExternal(deepUrl).catch(() => shell.openExternal('antigravity://').catch(() => {}));
}

function resolveTargetDisplay() {
  const displays = screen.getAllDisplays();
  if (targetDisplayPref === 'cursor') {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    } catch {
      return screen.getPrimaryDisplay();
    }
  }
  if (/^\d{1,20}$/.test(targetDisplayPref)) {
    const matched = displays.find(d => String(d.id) === targetDisplayPref);
    if (matched) return matched;
  }
  return screen.getPrimaryDisplay();
}

function syncBounds() {
  if (!win || win.isDestroyed()) return;
  const area = resolveTargetDisplay().workArea;
  const cur = win.getBounds();
  if (cur.x === area.x && cur.y === area.y && cur.width === area.width && cur.height === area.height) return;
  win.setResizable(true);
  win.setBounds(area);
  win.setResizable(false);
}

function applyTopLevel() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, topLevelPref);
}

function isParentAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  applyTopLevel();
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  // Poll global OS cursor coordinates so gaze tracking stays responsive even over other windows.
  let lastCursorX = null;
  let lastCursorY = null;
  const cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      const cx = Math.round(pt.x - bounds.x);
      const cy = Math.round(pt.y - bounds.y);
      if (lastCursorX === null || Math.abs(cx - lastCursorX) >= 1 || Math.abs(cy - lastCursorY) >= 1) {
        lastCursorX = cx;
        lastCursorY = cy;
        win.webContents.send('hagemi:cursor', { x: cx, y: cy });
      }
    } catch { /* Ignore transient display query errors. */ }
  }, 33);
  cursorTimer.unref?.();
  win.on('closed', () => clearInterval(cursorTimer));

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') shell.openExternal(url);
    } catch { /* Ignore invalid external URLs. */ }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== targetUrl) event.preventDefault();
  });

  screen.on('display-metrics-changed', syncBounds);
  screen.on('display-added', syncBounds);
  screen.on('display-removed', syncBounds);

  ipcMain.on('hagemi:hit', (_event, interactive) => {
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(!interactive, { forward: true });
    }
  });

  ipcMain.handle('hagemi:idle', () => powerMonitor.getSystemIdleTime());

  ipcMain.handle('hagemi:displays', () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, index) => ({
      id: String(d.id),
      primary: d.id === primaryId,
      index: index + 1,
      width: d.workArea.width,
      height: d.workArea.height,
    }));
  });

  ipcMain.on('hagemi:window-prefs', (_event, payload = {}) => {
    const nextDisplay = typeof payload.display === 'string' && (payload.display === 'primary' || payload.display === 'cursor' || /^\d{1,20}$/.test(payload.display))
      ? payload.display
      : null;
    if (nextDisplay && nextDisplay !== targetDisplayPref) {
      targetDisplayPref = nextDisplay;
      syncBounds();
    } else if (targetDisplayPref === 'cursor') {
      syncBounds();
    }
    if (VALID_LEVELS.has(payload.level) && payload.level !== topLevelPref) {
      topLevelPref = payload.level;
      applyTopLevel();
    }
  });

  ipcMain.on('hagemi:focus-conversation', (_event, payload) => {
    focusAntigravity(payload);
  });

  ipcMain.on('hagemi:notify', (_event, payload = {}) => {
    if (!Notification.isSupported()) return;
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Hagemi Pet';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const opts = { title, body };
    if (existsSync(ICON_PATH)) opts.icon = ICON_PATH;
    const n = new Notification(opts);
    activeNotifications.add(n);
    n.once('click', () => {
      activeNotifications.delete(n);
      focusAntigravity(payload);
      if (win && !win.isDestroyed()) {
        win.webContents.send('hagemi:notification-clicked', {
          conversationId: payload.conversationId || null,
          title: payload.conversationTitle || '',
        });
      }
    });
    n.once('close', () => activeNotifications.delete(n));
    n.once('failed', () => activeNotifications.delete(n));
    n.show();
  });

  win.loadURL(targetUrl).catch(() => app.quit());

  if (parentPid > 0) {
    const timer = setInterval(() => {
      if (!isParentAlive(parentPid)) {
        clearInterval(timer);
        app.quit();
      }
    }, 2000);
    timer.unref?.();
  }
});

app.on('window-all-closed', () => app.quit());
