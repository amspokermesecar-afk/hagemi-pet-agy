import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, sanitize } from '../sidecars/pet/lib/settings.mjs';
import { cleanupDesktopRuntime } from '../tools/cleanup-desktop-runtime.mjs';

test('desktop display and always-on-top level defaults and validation', () => {
  assert.equal(DEFAULTS.desktopDisplay, 'primary');
  assert.equal(DEFAULTS.alwaysOnTopLevel, 'floating');

  assert.equal(sanitize({ desktopDisplay: 'cursor' }).desktopDisplay, 'cursor');
  assert.equal(sanitize({ desktopDisplay: '2528732444' }).desktopDisplay, '2528732444');
  assert.equal(sanitize({ desktopDisplay: '../evil' }).desktopDisplay, 'primary');

  assert.equal(sanitize({ alwaysOnTopLevel: 'normal' }).alwaysOnTopLevel, 'normal');
  assert.equal(sanitize({ alwaysOnTopLevel: 'screen-saver' }).alwaysOnTopLevel, 'screen-saver');
  assert.equal(sanitize({ alwaysOnTopLevel: 'invalid' }).alwaysOnTopLevel, 'floating');
});

test('electron-main and preload expose multi-monitor and configurable topmost level', () => {
  const root = join(import.meta.dirname, '..');
  const mainSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'electron-main.cjs'), 'utf8');
  const preloadSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'preload.cjs'), 'utf8');
  assert.match(mainSrc, /hagemi:displays/);
  assert.match(mainSrc, /hagemi:window-prefs/);
  assert.match(mainSrc, /getAllDisplays/);
  assert.match(mainSrc, /let topLevelPref = 'floating'/);
  assert.match(preloadSrc, /listDisplays:/);
  assert.match(preloadSrc, /setWindowPrefs:/);
});

test('cleanupDesktopRuntime removes electron-runtime while preserving user settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'hagemi-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const runtimeDir = join(root, 'electron-runtime');
  const profileDir = join(root, 'electron-profile');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), '{"language":"zhs"}');
  writeFileSync(join(runtimeDir, 'stub.bin'), 'electron');
  writeFileSync(join(profileDir, 'cache.dat'), 'cache');

  const env = { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir };
  const dry = cleanupDesktopRuntime({ env, dryRun: true });
  assert.deepEqual(dry.removed, [runtimeDir]);
  assert.equal(existsSync(runtimeDir), true, 'dry run does not delete files');

  const res = cleanupDesktopRuntime({ env });
  assert.deepEqual(res.removed, [runtimeDir]);
  assert.equal(existsSync(runtimeDir), false, 'electron-runtime removed');
  assert.equal(existsSync(profileDir), true, 'electron-profile kept unless --all');
  assert.equal(readFileSync(join(dataDir, 'settings.json'), 'utf8'), '{"language":"zhs"}', 'settings preserved');

  const resAll = cleanupDesktopRuntime({ env, includeProfile: true });
  assert.deepEqual(resAll.removed, [profileDir]);
  assert.equal(existsSync(profileDir), false, 'electron-profile removed with includeProfile');
  assert.equal(readFileSync(join(dataDir, 'settings.json'), 'utf8'), '{"language":"zhs"}', 'settings still preserved');
});
