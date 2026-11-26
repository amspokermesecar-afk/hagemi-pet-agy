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
let win = null;

function focusAntigravity(payload = {}) {
  const rawId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
  const safeId = /^[a-zA-Z0-9_-]{4,128}$/.test(rawId) ? rawId : '';
  const deepUrl = safeId ? `antigravity://conversation/${encodeURIComponent(safeId)}` : 'antigravity://open';
  shell.openExternal(deepUrl).catch(() => shell.openExternal('antigravity://').catch(() => {}));
}

function syncBounds() {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setResizable(true);
  win.setBounds(area);
  win.setResizable(false);
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

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  // Adaptive global OS cursor polling: stops while hidden/locked and backs off while stationary.
  let lastCursorX = null;
  let lastCursorY = null;
  let lastCursorMoveAt = Date.now();
  let cursorFollow = true;
  let petHidden = false;
  let systemLocked = false;
  let cursorTimer = null;

  function computeCursorDelay(now) {
    if (petHidden || systemLocked) return null;
    const idleSec = powerMonitor.getSystemIdleTime();
    if (idleSec >= 30) return 500;
    const stillMs = Math.max(0, now - lastCursorMoveAt);
    if (!cursorFollow) return stillMs > 1500 ? 300 : 100;
    return stillMs > 1500 ? 250 : 33;
  }

  function scheduleCursorPoll(overrideMs = null) {
    clearTimeout(cursorTimer);
    cursorTimer = null;
    if (!win || win.isDestroyed()) return;
    const delay = overrideMs != null ? overrideMs : computeCursorDelay(Date.now());
    if (delay == null) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (!win || win.isDestroyed()) return;
      const now = Date.now();
      try {
        const pt = screen.getCursorScreenPoint();
        const bounds = win.getBounds();
        const cx = Math.round(pt.x - bounds.x);
        const cy = Math.round(pt.y - bounds.y);
        if (lastCursorX === null || Math.abs(cx - lastCursorX) >= 1 || Math.abs(cy - lastCursorY) >= 1) {
          lastCursorX = cx;
          lastCursorY = cy;
          lastCursorMoveAt = now;
          win.webContents.send('hagemi:cursor', { x: cx, y: cy });
        }
      } catch { /* Ignore transient display query errors. */ }
      scheduleCursorPoll();
    }, delay);
    cursorTimer.unref?.();
  }

  powerMonitor.on('lock-screen', () => { systemLocked = true; scheduleCursorPoll(); });
  powerMonitor.on('suspend', () => { systemLocked = true; scheduleCursorPoll(); });
  powerMonitor.on('unlock-screen', () => { systemLocked = false; lastCursorMoveAt = Date.now(); scheduleCursorPoll(50); });
  powerMonitor.on('resume', () => { systemLocked = false; lastCursorMoveAt = Date.now(); scheduleCursorPoll(50); });
  scheduleCursorPoll(33);
  win.on('closed', () => clearTimeout(cursorTimer));

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
  ipcMain.handle('hagemi:idle-state', () => ({
    idleSec: powerMonitor.getSystemIdleTime(),
    locked: systemLocked || powerMonitor.getSystemIdleState(60) === 'locked',
  }));
  ipcMain.on('hagemi:cursor-tracking', (_event, payload = {}) => {
    if (typeof payload.followCursor === 'boolean') cursorFollow = payload.followCursor;
    if (typeof payload.hidden === 'boolean') petHidden = payload.hidden;
    if (!petHidden && !systemLocked) lastCursorMoveAt = Date.now();
    scheduleCursorPoll(petHidden || systemLocked ? null : 50);
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
