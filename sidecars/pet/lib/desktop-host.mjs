// Manages the lifecycle of the standalone transparent Electron overlay window.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_CJS = join(HERE, '..', 'desktop', 'electron-main.cjs');

function electronBinaryRelativePath(platform = process.platform) {
  if (platform === 'win32') return join('node_modules', 'electron', 'dist', 'electron.exe');
  if (platform === 'darwin') return join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return join('node_modules', 'electron', 'dist', 'electron');
}

export function findElectronExecutable({ dataDir = '', pluginRoot = '', env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (typeof env.HAGEMI_ELECTRON_PATH === 'string' && env.HAGEMI_ELECTRON_PATH.trim()) {
    candidates.push(env.HAGEMI_ELECTRON_PATH.trim().replace(/^"(.*)"$/, '$1'));
  }
  const rel = electronBinaryRelativePath(platform);
  if (dataDir) {
    candidates.push(resolve(dataDir, '..', 'electron-runtime', rel));
  }
  if (pluginRoot) {
    candidates.push(join(pluginRoot, rel));
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  try {
    const cmd = platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['electron'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }).trim();
    const first = out.split(/\r?\n/).find(line => line.trim() && existsSync(line.trim()));
    if (first) return first.trim();
  } catch {
    // Not on PATH.
  }
  return null;
}

export class DesktopHost {
  constructor({ dataDir = '', pluginRoot = '', log = () => {}, onExit = () => {} } = {}) {
    this.dataDir = dataDir;
    this.pluginRoot = pluginRoot;
    this.log = log;
    this.onExit = onExit;
    this.child = null;
    this.stopping = false;
    this.missingLogged = false;
  }

  get running() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  get pid() {
    return this.running ? (this.child?.pid || 0) : 0;
  }

  start(url) {
    if (this.running) return true;
    const exe = findElectronExecutable({ dataDir: this.dataDir, pluginRoot: this.pluginRoot });
    if (!exe) {
      if (!this.missingLogged) {
        this.missingLogged = true;
        this.log('desktop overlay: electron executable not found');
      }
      return false;
    }
    this.missingLogged = false;
    this.stopping = false;

    const env = { ...process.env };
    // Antigravity's agy-node.cmd sets ELECTRON_RUN_AS_NODE=1; clear it so Electron boots as a GUI app.
    delete env.ELECTRON_RUN_AS_NODE;

    const args = [MAIN_CJS, `--url=${url}`, `--parent-pid=${process.pid}`];
    if (this.dataDir) {
      args.push(`--user-data-dir=${resolve(this.dataDir, '..', 'electron-profile')}`);
    }

    try {
      const child = spawn(exe, args, {
        env,
        windowsHide: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.child = child;
      let errText = '';
      child.stderr?.on('data', chunk => {
        if (errText.length < 1024) errText += chunk.toString('utf8');
      });
      child.once('error', err => {
        this.log(`desktop host spawn error: ${err.message}`);
        if (this.child === child) this.child = null;
        if (!this.stopping) this.onExit(1);
      });
      child.once('exit', code => {
        if (this.child === child) this.child = null;
        if (!this.stopping) {
          if (code !== 0) {
            this.log(`desktop host exited (${code})${errText ? `: ${errText.trim().slice(0, 240)}` : ''}`);
          }
          this.onExit(code ?? 0);
        }
      });
      return true;
    } catch (err) {
      this.log(`desktop host failed to start: ${err.message}`);
      return false;
    }
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise(resolveExit => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolveExit();
      };
      child.once('exit', finish);
      try { child.kill(); } catch { /* Already dead. */ }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Already dead. */ }
        finish();
      }, 1500);
      timer.unref?.();
    });
  }
}
