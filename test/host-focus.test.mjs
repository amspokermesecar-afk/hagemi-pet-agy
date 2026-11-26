import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostFocusChecker, matchesHostProcess, queryForegroundProcess } from '../sidecars/pet/lib/host-focus.mjs';

test('matchesHostProcess identifies Antigravity and allowed overlay PIDs', () => {
  assert.equal(matchesHostProcess({ pid: 100, name: 'Antigravity' }), true);
  assert.equal(matchesHostProcess({ pid: 101, name: 'antigravity.exe' }), true);
  assert.equal(matchesHostProcess({ pid: 202, name: 'electron' }, { allowedPids: [202] }), true);
  assert.equal(matchesHostProcess({ pid: 303, name: 'chrome' }, { allowedPids: [202] }), false);
  assert.equal(matchesHostProcess(null), null);
  assert.equal(matchesHostProcess({ pid: 0, name: '' }), null);
});

test('queryForegroundProcess parses Windows, macOS and Linux responses safely', async () => {
  const win = await queryForegroundProcess({
    platform: 'win32',
    execFn: async () => ({ stdout: '4321|Antigravity\r\n' }),
  });
  assert.deepEqual(win, { pid: 4321, name: 'Antigravity' });

  const mac = await queryForegroundProcess({
    platform: 'darwin',
    execFn: async () => ({ stdout: 'Antigravity\n' }),
  });
  assert.deepEqual(mac, { pid: 0, name: 'Antigravity' });

  const linux = await queryForegroundProcess({
    platform: 'linux',
    execFn: async () => ({ stdout: '9001\n' }),
    readFileFn: async () => 'antigravity\n',
  });
  assert.deepEqual(linux, { pid: 9001, name: 'antigravity' });

  const failed = await queryForegroundProcess({
    platform: 'win32',
    execFn: async () => { throw new Error('boom'); },
  });
  assert.equal(failed, null);
});

test('HostFocusChecker caches results, deduplicates concurrent calls, and expires after TTL', async () => {
  let clock = 1000;
  let calls = 0;
  let active = { pid: 100, name: 'Antigravity' };
  const checker = new HostFocusChecker({
    ttlMs: 3000,
    now: () => clock,
    getAllowedPids: () => [555],
    queryFn: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return active;
    },
  });

  const [a, b] = await Promise.all([checker.isFocused(), checker.isFocused()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(calls, 1, 'concurrent calls share one OS check');

  clock += 1000;
  assert.equal(await checker.isFocused(), true);
  assert.equal(calls, 1, 'cached within TTL');

  clock += 3000;
  active = { pid: 999, name: 'notepad' };
  assert.equal(await checker.isFocused(), false);
  assert.equal(calls, 2, 're-queried after TTL expiry');

  clock += 3500;
  active = { pid: 555, name: 'electron' };
  assert.equal(await checker.isFocused(), true, 'overlay PID counts as focused');
});
