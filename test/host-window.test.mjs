import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyHostWindowState, HostWindowWatcher, parseHostWindowState } from '../sidecars/pet/lib/host-window.mjs';
import { DEFAULTS, sanitize } from '../sidecars/pet/lib/settings.mjs';

test('classifyHostWindowState handles single, multi-window, helper windows, and fail-open unknown', () => {
  assert.equal(classifyHostWindowState([]), 'unknown');
  assert.equal(classifyHostWindowState([{ visible: false, iconic: true, width: 1200, height: 800 }]), 'unknown');
  assert.equal(classifyHostWindowState([{ visible: true, owned: true, iconic: true, width: 1200, height: 800 }]), 'unknown');
  assert.equal(classifyHostWindowState([{ visible: true, toolWindow: true, iconic: true, width: 1200, height: 800 }]), 'unknown');
  assert.equal(classifyHostWindowState([{ visible: true, iconic: false, width: 10, height: 10 }]), 'unknown');

  assert.equal(classifyHostWindowState([{ visible: true, iconic: false, width: 1280, height: 800 }]), 'open');
  assert.equal(classifyHostWindowState([{ visible: true, iconic: true, width: 0, height: 0 }]), 'minimized');

  assert.equal(classifyHostWindowState([
    { visible: true, iconic: true, width: 0, height: 0 },
    { visible: true, iconic: false, width: 1280, height: 800 },
  ]), 'open', 'stays visible if any Antigravity window is still open');

  assert.equal(classifyHostWindowState([
    { visible: true, iconic: true, width: 0, height: 0 },
    { visible: true, iconic: true, width: 0, height: 0 },
  ]), 'minimized', 'hides once all Antigravity windows are minimized');
});

test('parseHostWindowState normalizes valid outputs and rejects noise', () => {
  assert.equal(parseHostWindowState('open\r\n'), 'open');
  assert.equal(parseHostWindowState(' MINIMIZED '), 'minimized');
  assert.equal(parseHostWindowState('unknown'), 'unknown');
  assert.equal(parseHostWindowState('random noise'), null);
});

test('HostWindowWatcher streams state transitions, fails open on unknown, and resets on disable', () => {
  const transitions = [];
  let spawned = 0;
  let killed = 0;
  let fakeStdout = null;
  const watcher = new HostWindowWatcher({
    platform: 'win32',
    spawnFn: () => {
      spawned++;
      const child = new EventEmitter();
      fakeStdout = new EventEmitter();
      fakeStdout.setEncoding = () => {};
      child.stdout = fakeStdout;
      child.kill = () => { killed++; };
      return child;
    },
    onStateChange: state => transitions.push(state),
  });

  watcher.setEnabled(true);
  assert.equal(spawned, 1);

  // Split chunks across lines to ensure line buffering works.
  fakeStdout.emit('data', 'mini');
  fakeStdout.emit('data', 'mized\nminimized\n');
  assert.deepEqual(transitions, ['minimized']);

  // 'unknown' fails open to 'open' so the pet never gets stuck hidden.
  fakeStdout.emit('data', 'unknown\n');
  assert.deepEqual(transitions, ['minimized', 'open']);

  fakeStdout.emit('data', 'minimized\n');
  assert.deepEqual(transitions, ['minimized', 'open', 'minimized']);

  // Disabling stops the watcher process and restores visibility immediately.
  watcher.setEnabled(false);
  assert.equal(killed, 1);
  assert.deepEqual(transitions, ['minimized', 'open', 'minimized', 'open']);
});

test('hideWhenHostMinimized setting defaults to true and desktop IPC is wired', () => {
  assert.equal(DEFAULTS.hideWhenHostMinimized, true);
  assert.equal(sanitize({ hideWhenHostMinimized: false }).hideWhenHostMinimized, false);
  assert.equal(sanitize({ hideWhenHostMinimized: 'nope' }).hideWhenHostMinimized, true);

  const root = join(import.meta.dirname, '..');
  const mainSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'electron-main.cjs'), 'utf8');
  const preloadSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'preload.cjs'), 'utf8');
  const bridgeSrc = readFileSync(join(root, 'sidecars', 'pet', 'lib', 'desktop-bridge.mjs'), 'utf8');
  const petSrc = readFileSync(join(root, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  assert.match(mainSrc, /hagemi:host-minimized/);
  assert.match(mainSrc, /win\.setAlwaysOnTop\(false\);\s*win\.hide\(\)/);
  assert.match(mainSrc, /function applyTopLevel[\s\S]{0,160}hostMinimized \|\| !win\.isVisible\(\)/);
  assert.match(mainSrc, /win\.on\('blur', \(\) => \{\s*if \(hostMinimized/);
  assert.match(preloadSrc, /setHostMinimized:/);
  assert.match(bridgeSrc, /host_minimized/);
  assert.match(petSrc, /const hidden = hostMinimized \|\| settings\.hidden/);
});
