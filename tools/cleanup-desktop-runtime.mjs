#!/usr/bin/env node
// Cleans up the standalone Electron desktop overlay runtime downloaded into sidecar_data,
// while preserving the user's data/ directory (settings.json, budget.json, rollback metadata).
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveSidecarPaths(env = process.env, home = homedir()) {
  const geminiDir = env.ANTIGRAVITY_GEMINI_DIR || join(home, '.gemini');
  const appDataDir = resolve(geminiDir, env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(appDataDir, 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data');
  const baseDir = resolve(dataDir, '..');
  return {
    baseDir,
    dataDir: resolve(dataDir),
    runtimeDir: join(baseDir, 'electron-runtime'),
    profileDir: join(baseDir, 'electron-profile'),
  };
}

export function cleanupDesktopRuntime({ env = process.env, home = homedir(), includeProfile = false, dryRun = false } = {}) {
  const paths = resolveSidecarPaths(env, home);
  const targets = [paths.runtimeDir];
  if (includeProfile) targets.push(paths.profileDir);

  const removed = [];
  const skipped = [];
  for (const dir of targets) {
    if (!existsSync(dir)) {
      skipped.push(dir);
      continue;
    }
    if (!dryRun) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    removed.push(dir);
  }
  return { paths, removed, skipped, dryRun };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const includeProfile = args.has('--all') || args.has('--include-profile');
  const dryRun = args.has('--dry-run');
  const result = cleanupDesktopRuntime({ includeProfile, dryRun });
  if (result.removed.length === 0) {
    console.log(`Nothing to clean under ${result.paths.baseDir}. Settings in ${result.paths.dataDir} were kept untouched.`);
  } else {
    const verb = dryRun ? 'Would remove' : 'Removed';
    for (const dir of result.removed) console.log(`${verb}: ${dir}`);
    console.log(`Preserved user settings in: ${result.paths.dataDir}`);
  }
}
