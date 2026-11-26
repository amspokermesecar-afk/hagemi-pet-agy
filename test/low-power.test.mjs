import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RendererBridge } from '../sidecars/pet/lib/cdp.mjs';
import { LanguageServer } from '../sidecars/pet/lib/ls-client.mjs';
import { evaluateQuotaSchedule, nextCursorPollMs, nextMonitorDelayMs, shouldHoverRefreshQuota } from '../sidecars/pet/lib/polling.mjs';
import { DEFAULTS, sanitize } from '../sidecars/pet/lib/settings.mjs';

const MINUTE = 60000;

test('monitor poll delay backs off smoothly when idle or locked and stays fast when running', () => {
  assert.equal(nextMonitorDelayMs({ running: 1, idleMs: 10 * MINUTE, locked: true }), 2000);
  assert.equal(nextMonitorDelayMs({ running: 0, idleMs: 30_000, locked: false }), 4000);
  assert.equal(nextMonitorDelayMs({ running: 0, idleMs: 2 * MINUTE, locked: false }), 15000);
  assert.equal(nextMonitorDelayMs({ running: 0, idleMs: 5 * MINUTE, locked: false }), 30000);
  assert.equal(nextMonitorDelayMs({ running: 0, idleMs: 0, locked: true }), 30000);
});

test('quota schedule pauses when idle/locked/hidden and speeds up near reset', () => {
  const now = 10_000_000;
  assert.equal(evaluateQuotaSchedule({ now, lastPollAt: 0, locked: true }).shouldPoll, false);
  assert.equal(evaluateQuotaSchedule({ now, lastPollAt: 0, visible: false }).shouldPoll, false);
  assert.equal(evaluateQuotaSchedule({ now, lastPollAt: 0, idleMs: 5 * MINUTE }).shouldPoll, false);

  const fresh = evaluateQuotaSchedule({ now, lastPollAt: now - 2 * MINUTE, resetInMs: 60 * MINUTE });
  assert.equal(fresh.shouldPoll, false);
  assert.equal(fresh.nextCheckMs, 8 * MINUTE);

  const stale = evaluateQuotaSchedule({ now, lastPollAt: now - 10 * MINUTE, resetInMs: 60 * MINUTE });
  assert.equal(stale.shouldPoll, true);
  assert.equal(stale.nextCheckMs, 10 * MINUTE);

  const nearReset = evaluateQuotaSchedule({ now, lastPollAt: now - 65_000, resetInMs: 3 * MINUTE });
  assert.equal(nearReset.shouldPoll, true);
  assert.equal(nearReset.nextCheckMs, MINUTE);

  assert.equal(shouldHoverRefreshQuota({ now, lastPollAt: now - 10_000 }), false);
  assert.equal(shouldHoverRefreshQuota({ now, lastPollAt: now - 30_000 }), true);
});

test('cursor poll policy stops while hidden/locked and backs off while stationary', () => {
  assert.equal(nextCursorPollMs({ hidden: true }), null);
  assert.equal(nextCursorPollMs({ locked: true }), null);
  assert.equal(nextCursorPollMs({ followCursor: true, idleSec: 0, stillMs: 0 }), 33);
  assert.equal(nextCursorPollMs({ followCursor: true, idleSec: 0, stillMs: 2000 }), 250);
  assert.equal(nextCursorPollMs({ followCursor: false, idleSec: 0, stillMs: 0 }), 100);
  assert.equal(nextCursorPollMs({ followCursor: false, idleSec: 0, stillMs: 2000 }), 300);
  assert.equal(nextCursorPollMs({ followCursor: true, idleSec: 45, stillMs: 0 }), 500);
});

test('RendererBridge backs off CDP probing after consecutive misses and supports disabling', async () => {
  const bridge = new RendererBridge({
    onMessage() {},
    profile: join(import.meta.dirname, '__missing_profile_dir__'),
    interval: 3000,
    backoffInterval: 60000,
    backoffAfterMisses: 3,
  });
  assert.equal(bridge.nextInterval(), 3000);
  await bridge.tick();
  await bridge.tick();
  assert.equal(bridge.nextInterval(), 3000);
  await bridge.tick();
  assert.equal(bridge.nextInterval(), 60000, 'backs off after 3 consecutive misses');
  await bridge.setEnabled(false);
  assert.equal(bridge.health.state, 'disabled');
});

test('LanguageServer triggers onFatalDisconnect after consecutive fatal host errors and resets on success', async () => {
  let fatalCalls = 0;
  let shouldFail = true;
  const ls = new LanguageServer({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:12345', ANTIGRAVITY_CSRF_TOKEN: 'secret' },
    fatalThreshold: 3,
    onFatalDisconnect: () => { fatalCalls++; },
    transport: async () => {
      if (shouldFail) {
        const err = new Error('unauthorized');
        err.status = 401;
        throw err;
      }
      return { ok: true };
    },
  });

  await assert.rejects(() => ls.call('GetStatus'));
  await assert.rejects(() => ls.call('GetStatus'));
  assert.equal(fatalCalls, 0);

  // A successful response resets the consecutive counter.
  shouldFail = false;
  assert.deepEqual(await ls.call('GetStatus'), { ok: true });
  shouldFail = true;

  await assert.rejects(() => ls.call('GetStatus'));
  await assert.rejects(() => ls.call('GetStatus'));
  assert.equal(fatalCalls, 0);
  await assert.rejects(() => ls.call('GetStatus'));
  assert.equal(fatalCalls, 1, 'triggers once threshold is reached');
  await assert.rejects(() => ls.call('GetStatus'));
  assert.equal(fatalCalls, 1, 'only triggers once');
});

test('renderMode setting defaults to auto and validates allowed values', () => {
  assert.equal(DEFAULTS.renderMode, 'auto');
  assert.equal(sanitize({ renderMode: 'desktop' }).renderMode, 'desktop');
  assert.equal(sanitize({ renderMode: 'cdp' }).renderMode, 'cdp');
  assert.equal(sanitize({ renderMode: 'invalid' }).renderMode, 'auto');
});

test('electron-main adapts cursor polling and listens for screen lock/unlock', () => {
  const root = join(import.meta.dirname, '..');
  const mainSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'electron-main.cjs'), 'utf8');
  const preloadSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'preload.cjs'), 'utf8');
  const hostSrc = readFileSync(join(root, 'sidecars', 'pet', 'lib', 'desktop-host.mjs'), 'utf8');
  const petSrc = readFileSync(join(root, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  assert.match(mainSrc, /lock-screen/);
  assert.match(mainSrc, /hagemi:cursor-tracking/);
  assert.match(mainSrc, /hagemi:idle-state/);
  assert.match(preloadSrc, /setCursorTracking:/);
  assert.match(preloadSrc, /getIdleState:/);
  assert.match(hostSrc, /stdio:\s*\['ignore',\s*'pipe',\s*'ignore'\]/, 'suppresses where.exe stderr noise');
  assert.match(petSrc, /case 'notify':/, 'supports Web Notification fallback in CDP mode');
});
