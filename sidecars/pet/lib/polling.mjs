// Event-driven and idle-backoff scheduling policies for polling and low-power operation.
const MINUTE = 60000;

export function nextMonitorDelayMs({
  running = 0,
  idleMs = 0,
  locked = false,
  intervalRunning = 2000,
  intervalIdle = 4000,
  intervalMidIdle = 15000,
  intervalDeepIdle = 30000,
} = {}) {
  if (running > 0) return intervalRunning;
  if (locked || idleMs >= 5 * MINUTE) return intervalDeepIdle;
  if (idleMs >= 2 * MINUTE) return intervalMidIdle;
  return intervalIdle;
}

export function evaluateQuotaSchedule({
  now,
  lastPollAt = 0,
  resetInMs = null,
  idleMs = 0,
  locked = false,
  visible = true,
  fallbackMs = 10 * MINUTE,
  nearResetMs = 5 * MINUTE,
  nearResetPollMs = MINUTE,
  idleCutoffMs = 5 * MINUTE,
} = {}) {
  if (locked || !visible || idleMs >= idleCutoffMs) {
    return { shouldPoll: false, nextCheckMs: MINUTE };
  }
  const nearReset = resetInMs != null && resetInMs <= nearResetMs;
  const targetInterval = nearReset ? nearResetPollMs : fallbackMs;
  const elapsed = lastPollAt ? Math.max(0, now - lastPollAt) : Infinity;
  if (elapsed >= targetInterval) {
    return { shouldPoll: true, nextCheckMs: targetInterval };
  }
  return { shouldPoll: false, nextCheckMs: Math.max(5000, targetInterval - elapsed) };
}

export function shouldHoverRefreshQuota({ now, lastPollAt = 0, minGapMs = 30000 } = {}) {
  return !lastPollAt || (now - lastPollAt >= minGapMs);
}

export function nextCursorPollMs({
  hidden = false,
  locked = false,
  followCursor = true,
  idleSec = 0,
  stillMs = 0,
} = {}) {
  if (hidden || locked) return null;
  if (idleSec >= 30) return 500;
  if (!followCursor) return stillMs > 1500 ? 300 : 100;
  return stillMs > 1500 ? 250 : 33;
}
