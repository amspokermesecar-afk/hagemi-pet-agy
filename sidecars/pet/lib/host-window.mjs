// Watches whether Antigravity desktop windows are minimized so the standalone
// desktop overlay can automatically hide itself and resume when restored.
// On Windows, runs a single lightweight PowerShell process that compiles a tiny
// Win32 EnumWindows/IsIconic helper once and only emits stdout lines on transitions.
import { spawn } from 'node:child_process';

export function classifyHostWindowState(windows = []) {
  let total = 0;
  let open = 0;
  for (const w of windows) {
    if (!w || !w.visible || w.owned || w.toolWindow) continue;
    const substantial = Boolean(w.iconic) || ((Number(w.width) || 0) >= 100 && (Number(w.height) || 0) >= 100);
    if (!substantial) continue;
    total++;
    if (!w.iconic) open++;
  }
  if (total === 0) return 'unknown';
  return open > 0 ? 'open' : 'minimized';
}

export function parseHostWindowState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'open' || value === 'minimized' || value === 'unknown') return value;
  return null;
}

function buildWin32WatcherScript(parentPid, intervalMs = 500) {
  const safePid = Math.max(0, Number(parentPid) || 0);
  const safeInterval = Math.max(200, Math.min(5000, Math.round(Number(intervalMs) || 500)));
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'public static class HagemiHostWin {',
    '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  public static string Poll() {',
    '    var pids = new HashSet<uint>();',
    '    foreach (var p in Process.GetProcessesByName("Antigravity")) { try { pids.Add((uint)p.Id); } catch {} }',
    '    if (pids.Count == 0) return "unknown";',
    '    int total = 0, open = 0;',
    '    EnumWindows((h, l) => {',
    '      uint pid;',
    '      GetWindowThreadProcessId(h, out pid);',
    '      if (!pids.Contains(pid)) return true;',
    '      if (!IsWindowVisible(h)) return true;',
    '      if (GetWindow(h, 4) != IntPtr.Zero) return true;',
    '      int ex = GetWindowLong(h, -20);',
    '      if ((ex & 0x80) != 0) return true;',
    '      bool iconic = IsIconic(h);',
    '      if (!iconic) {',
    '        RECT r;',
    '        if (!GetWindowRect(h, out r) || (r.Right - r.Left) < 100 || (r.Bottom - r.Top) < 100) return true;',
    '      }',
    '      total++;',
    '      if (!iconic) open++;',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    if (total == 0) return "unknown";',
    '    return open > 0 ? "open" : "minimized";',
    '  }',
    '}',
    '"@ | Out-Null',
    '$last = ""',
    'while ($true) {',
    safePid > 0 ? `  if (-not (Get-Process -Id ${safePid} -ErrorAction SilentlyContinue)) { break }` : '',
    '  $cur = [HagemiHostWin]::Poll()',
    '  if ($cur -ne $last) {',
    '    $last = $cur',
    '    [Console]::Out.WriteLine($cur)',
    '    [Console]::Out.Flush()',
    '  }',
    `  Start-Sleep -Milliseconds ${safeInterval}`,
    '}',
  ].filter(Boolean).join('\n');
}

export class HostWindowWatcher {
  constructor({
    parentPid = process.pid,
    intervalMs = 500,
    platform = process.platform,
    spawnFn = spawn,
    onStateChange = () => {},
    log = () => {},
  } = {}) {
    this.parentPid = parentPid;
    this.intervalMs = intervalMs;
    this.platform = platform;
    this.spawnFn = spawnFn;
    this.onStateChange = onStateChange;
    this.log = log;
    this.enabled = false;
    this.child = null;
    this.restartTimer = null;
    this.state = 'open';
    this.buffer = '';
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      this.stopChild();
      if (this.state !== 'open') {
        this.state = 'open';
        this.onStateChange('open');
      }
      return;
    }
    this.startChild();
  }

  startChild() {
    if (!this.enabled || this.child || this.platform !== 'win32') return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.buffer = '';
    const script = buildWin32WatcherScript(this.parentPid, this.intervalMs);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      const child = this.spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      this.child = child;
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', chunk => this.onData(String(chunk)));
      child.once('error', err => {
        this.log(`host window watcher error: ${err.message}`);
        if (this.child === child) this.child = null;
        this.scheduleRestart();
      });
      child.once('exit', () => {
        if (this.child === child) this.child = null;
        this.scheduleRestart();
      });
    } catch (err) {
      this.log(`host window watcher failed: ${err.message}`);
      this.scheduleRestart();
    }
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const parsed = parseHostWindowState(line);
      if (!parsed) continue;
      // Fail-open: 'unknown' keeps the pet visible so she never disappears unexpectedly.
      const effective = parsed === 'minimized' ? 'minimized' : 'open';
      if (effective !== this.state) {
        this.state = effective;
        this.onStateChange(effective);
      }
    }
  }

  scheduleRestart() {
    if (!this.enabled || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startChild();
    }, 5000);
    this.restartTimer.unref?.();
  }

  stopChild() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch { /* Already dead. */ }
  }

  stop() {
    this.enabled = false;
    this.stopChild();
  }
}
