import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffConversations, parseConversations } from '../sidecars/pet/lib/monitor.mjs';
import { buildNotification, truncate } from '../sidecars/pet/lib/notify.mjs';
import { DEFAULTS, sanitize, SettingsStore } from '../sidecars/pet/lib/settings.mjs';

test('truncate slices cleanly by code points without breaking surrogate pairs', () => {
  const emoji = '🐾'.repeat(10);
  assert.equal(truncate(emoji, 4), '🐾🐾🐾🐾…');
  assert.equal(truncate('  hello   world  ', 20), 'hello world');
});

test('buildNotification handles done, error, waiting, test, and focus/toggle gating', () => {
  const settings = DEFAULTS;

  const done = buildNotification(
    { type: 'turn_done', id: 'conv-1234', title: 'Fix login flow', agentText: 'Patched **auth.ts** and tests pass.' },
    { language: 'zhs', settings, focused: false },
  );
  assert.equal(done.kind, 'done');
  assert.equal(done.title, 'Fix login flow');
  assert.match(done.body, /Patched auth\.ts/);
  assert.equal(done.conversationId, 'conv-1234');

  const waiting = buildNotification(
    { type: 'waiting_start', id: 'conv-5678', title: 'Deploy prod' },
    { language: 'zhs', settings, focused: false },
  );
  assert.equal(waiting.kind, 'waiting');
  assert.match(waiting.title, /Deploy prod · 需要确认/);

  const err = buildNotification(
    { type: 'turn_error', id: 'conv-err', title: 'Build' },
    { language: 'en', settings, focused: false },
  );
  assert.equal(err.kind, 'error');
  assert.equal(err.title, 'Build · Task error');

  assert.equal(buildNotification({ type: 'turn_canceled', id: 'c1' }, { language: 'zhs', settings, focused: false }), null);

  const mutedFocus = { ...settings, notifications: { ...settings.notifications, whenFocused: false } };
  assert.equal(buildNotification({ type: 'turn_done', id: 'c1' }, { language: 'zhs', settings: mutedFocus, focused: true }), null);
  assert.ok(buildNotification({ type: 'test', id: 'c1' }, { language: 'zhs', settings: mutedFocus, focused: true }));

  const off = { ...settings, notifications: { ...settings.notifications, enabled: false } };
  assert.equal(buildNotification({ type: 'waiting_start', id: 'c1' }, { language: 'zhs', settings: off, focused: false }), null);
});

test('diffConversations emits waiting_start for root and subagent conversations', () => {
  const base = status => ({
    status: `CASCADE_RUN_STATUS_${status}`, stepCount: 2,
    lastModifiedTime: '2026-11-24T08:00:00Z', lastUserInputTime: '2026-11-24T08:00:00Z',
    annotations: { title: 'Root task' },
  });
  const before = parseConversations({
    trajectorySummaries: {
      root1: base('RUNNING'),
      sub1: { ...base('RUNNING'), trajectoryMetadata: { parentConversationId: 'root1' }, annotations: { title: 'Sub' } },
    },
  });
  const after = parseConversations({
    trajectorySummaries: {
      root1: { ...base('RUNNING'), waitingSteps: [{}] },
      sub1: { ...base('RUNNING'), waitingSteps: [{}], trajectoryMetadata: { parentConversationId: 'root1' }, annotations: { title: 'Sub' } },
    },
  });
  const events = diffConversations(before, after, 0);
  const waitingEvents = events.filter(e => e.type === 'waiting_start');
  assert.equal(waitingEvents.length, 2);
  assert.ok(waitingEvents.every(e => e.id === 'root1' && e.title === 'Root task'));
});

test('settings persist roamEnabled, workStatusEnabled, and notification toggles', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hagemi-notif-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  assert.equal(store.value.roamEnabled, true);
  assert.equal(store.value.workStatusEnabled, true);
  assert.equal(store.value.notifications.enabled, true);

  store.patch({ roamEnabled: false, notifications: { onWaiting: false } });
  const reloaded = new SettingsStore(file);
  assert.equal(reloaded.value.roamEnabled, false);
  assert.equal(reloaded.value.workStatusEnabled, true);
  assert.equal(reloaded.value.notifications.onDone, true);
  assert.equal(reloaded.value.notifications.onWaiting, false);

  const sanitized = sanitize({ roamEnabled: 'bad', notifications: { enabled: 123 } });
  assert.equal(sanitized.roamEnabled, true);
  assert.equal(sanitized.notifications.enabled, true);
});
