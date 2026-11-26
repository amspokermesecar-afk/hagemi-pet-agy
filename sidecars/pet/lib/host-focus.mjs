// On-demand OS foreground window check for standalone desktop overlay mode.
// Never polls in the background; called only right before an AI call or notification
// when the caller needs to know whether Antigravity (or the pet overlay itself) is active.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const WIN32_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -Name Win32 -Namespace Hagemi -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);' -ErrorAction SilentlyContinue | Out-Null",
  '$h = [Hagemi.Win32]::GetForegroundWindow()',
  'if ($h -eq [IntPtr]::Zero) { exit 0 }',
  '$p = [uint32]0',
  '[void][Hagemi.Win32]::GetWindowThreadProcessId($h, [ref]$p)',
  'if ($p -le 0) { exit 0 }',
  '$name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName',
  'Write-Output "$p|$name"',
].join('\n');
const WIN32_ENCODED = Buffer.from(WIN32_SCRIPT, 'utf16le').toString('base64');

export function matchesHostProcess(info, { allowedPids = [] } = {}) {
  if (!info) return null;
  const pid = Number(info.pid) || 0;
  const name = String(info.name || '').trim();
  if (pid > 0 && allowedPids.includes(pid)) return true;
  if (!name && !pid) return null;
  return /\bantigravity\b|antigravity/i.test(name);
}

export async function queryForegroundProcess({ platform = process.platform, execFn = exec, readFileFn = readFile } = {}) {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN32_ENCODED],
        { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
      );
      const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
      const sep = line.indexOf('|');
      if (sep < 0) return null;
      return { pid: Number(line.slice(0, sep)) || 0, name: line.slice(sep + 1).trim() };
    }
    if (platform === 'darwin') {
      const { stdout } = await execFn(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 2000, maxBuffer: 64 * 1024 },
      );
      const name = String(stdout || '').trim();
      return name ? { pid: 0, name } : null;
    }
    if (platform === 'linux') {
      const { stdout } = await execFn('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 1500, maxBuffer: 16 * 1024 });
      const pid = Number(String(stdout || '').trim());
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const name = String(await readFileFn(`/proc/${pid}/comm`, 'utf8')).trim();
      return { pid, name };
    }
  } catch {
    // Unsupported platform, Wayland without xdotool, or transient OS query failure.
  }
  return null;
}

export class HostFocusChecker {
  constructor({
    ttlMs = 3000,
    now = Date.now,
    queryFn = queryForegroundProcess,
    getAllowedPids = () => [],
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.queryFn = queryFn;
    this.getAllowedPids = getAllowedPids;
    this.cachedAt = -Infinity;
    this.cachedValue = null;
    this.inFlight = null;
  }

  async isFocused() {
    if (this.now() - this.cachedAt < this.ttlMs) return this.cachedValue;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const info = await this.queryFn();
      const allowedPids = (this.getAllowedPids() || []).filter(n => Number.isInteger(n) && n > 0);
      const value = matchesHostProcess(info, { allowedPids });
      this.cachedValue = value;
      this.cachedAt = this.now();
      return value;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
