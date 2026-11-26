#!/usr/bin/env node
// Installs the standalone Electron desktop overlay runtime used when Antigravity
// runs without an exposed CDP remote-debugging port (e.g. Antigravity v2.34+).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function electronBinaryPath(runtimeDir, platform = process.platform) {
  if (platform === 'win32') return join(runtimeDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (platform === 'darwin') return join(runtimeDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return join(runtimeDir, 'node_modules', 'electron', 'dist', 'electron');
}

function resolveRuntimeDir() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const appDataDir = resolve(geminiDir, process.env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(appDataDir, 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data');
  return resolve(dataDir, '..', 'electron-runtime');
}

function installElectron(runtimeDir, extraEnv = {}) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBin, ['install', '--no-audit', '--no-fund', 'electron'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

const runtimeDir = resolveRuntimeDir();
const binary = electronBinaryPath(runtimeDir);

if (existsSync(binary)) {
  console.log(`Hagemi desktop runtime already installed at: ${runtimeDir}`);
  process.exit(0);
}

mkdirSync(dirname(runtimeDir), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const pkgPath = join(runtimeDir, 'package.json');
if (!existsSync(pkgPath)) {
  writeFileSync(pkgPath, `${JSON.stringify({ name: 'hagemi-electron-runtime', private: true }, null, 2)}\n`, 'utf8');
}

console.log(`Installing Electron desktop runtime into ${runtimeDir} ...`);
let ok = installElectron(runtimeDir);
if (!ok || !existsSync(binary)) {
  console.log('Default Electron download failed; retrying with npmmirror (https://npmmirror.com/mirrors/electron/) ...');
  ok = installElectron(runtimeDir, { ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' });
}

if (!ok || !existsSync(binary)) {
  console.error('Failed to install Electron runtime. You can retry with ELECTRON_MIRROR set manually.');
  process.exit(1);
}

console.log(`Hagemi desktop runtime installed successfully at: ${runtimeDir}`);
