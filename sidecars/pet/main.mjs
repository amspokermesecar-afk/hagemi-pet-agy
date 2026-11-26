// Sidecar entry point: watches Antigravity, decides how she feels, and tells the pet.
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, Budget, ModelResolver } from './lib/brain.mjs';
import { RendererBridge } from './lib/cdp.mjs';
import { DesktopBridge } from './lib/desktop-bridge.mjs';
import { DesktopHost } from './lib/desktop-host.mjs';
import { ambientTriggers, chooseState, classifyTurnEnd, festival, isLate, modelFamily, REACTIONS, timeOfDay } from './lib/director.mjs';
import { HostFocusChecker } from './lib/host-focus.mjs';
import { fill, resolveLanguage, UI } from './lib/lines.mjs';
import { LanguageServer } from './lib/ls-client.mjs';
import { Monitor } from './lib/monitor.mjs';
import { buildNotification } from './lib/notify.mjs';
import { evaluateQuotaSchedule, shouldHoverRefreshQuota } from './lib/polling.mjs';
import { formatDuration, isResetSoon, levelForModel, parseQuota, quotaEvents, quotaRows, summarize } from './lib/quota.mjs';
import { readArt } from './lib/renderer-source.mjs';
import { SettingsStore } from './lib/settings.mjs';
import { Updater, UPDATE_INTERVAL_MS } from './lib/updater.mjs';

const MINUTE = 60000;
const log = message => console.log(`[hagemi] ${message}`);

const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
const appDataDir = resolve(geminiDir, process.env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(appDataDir, 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data');

// The host starts sidecars inside the plugin folder, and on Windows the current directory of a
// running process cannot be removed. Move out so the plugin can be updated or uninstalled.
try { mkdirSync(dataDir, { recursive: true }); process.chdir(dataDir); } catch { /* Stays put; only updates are affected. */ }

const settings = new SettingsStore(join(dataDir, 'settings.json'));
const budget = new Budget(join(dataDir, 'budget.json'));
const ls = new LanguageServer({
  onFatalDisconnect: error => {
    log(`language server connection invalidated (${error.status || error.code || error.message}); exiting so host can restart with fresh token`);
    shutdown();
  },
});
const models = new ModelResolver(ls);

let appLanguage = 'en';
let facts = { running: 0, subagents: 0, category: null, idleMs: 0, quietMs: 0, connected: false };
let quota = { level: null, mood: 'ok', buckets: [], resetInMs: null };
let allBuckets = [];
let presence = { visible: true, focused: true, locked: false, idleMs: 0, desktop: false };
let selectedModel = null;
let activeSince = null, lastToolAt = 0;
let lastFactsJson = '', lastLoggedState = null, lastState = null;

const language = () => resolveLanguage(settings.value.language, appLanguage);
const ui = () => UI[language()];
const quotaOptions = () => ({ lowAt: settings.value.quota.lowAt, criticalAt: settings.value.quota.criticalAt, resetSoonMs: settings.value.quota.resetSoonMin * MINUTE });

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = new RendererBridge({ onMessage: onPetMessage, log });
let desktopBackoffIndex = 0;
let desktopNextTryAt = 0;
const DESKTOP_BACKOFF_MS = [5000, 15000, 60000, 60000, 60000];
const DESKTOP_PAUSE_MS = 5 * MINUTE;
const desktopBridge = new DesktopBridge({ onMessage: onPetMessage, log });
const desktopHost = new DesktopHost({
  dataDir,
  pluginRoot,
  log,
  onExit: code => {
    if (stopping) return;
    if (code === 0) {
      desktopBackoffIndex = 0;
      desktopNextTryAt = Date.now() + 5000;
      return;
    }
    if (desktopBackoffIndex >= DESKTOP_BACKOFF_MS.length) {
      desktopNextTryAt = Date.now() + DESKTOP_PAUSE_MS;
      desktopBackoffIndex = 0;
    } else {
      desktopNextTryAt = Date.now() + DESKTOP_BACKOFF_MS[desktopBackoffIndex++];
    }
  },
});

function sendTo(session, message) {
  if (session?.desktop) desktopBridge.post(session, message);
  else bridge.post(session, message);
}

function broadcastAll(message) {
  bridge.broadcast(message);
  desktopBridge.broadcast(message);
}

const updater = new Updater({
  root: pluginRoot,
  installedRoot: join(geminiDir, 'config', 'plugins', 'hagemi-pet-agy'),
  stateFile: join(dataDir, 'last-good-sha.json'),
  getCooldownHours: () => settings.value.updateCooldownHours,
  log,
  onChange: update => broadcastAll({ t: 'update', update }),
  onInstalled: () => {
    broadcastAll({ t: 'react', state: 'happy', gesture: 'hop', burst: 'sparkles' });
    // The host's restart_policy: always brings her back with the new modules and renderer.
    setTimeout(shutdown, 1500);
  },
});
updater.local().then(local => updater.publish(local));
const hostFocus = new HostFocusChecker({
  getAllowedPids: () => [desktopHost.pid],
});

async function resolveHostFocus() {
  if (!presence.visible) return false;
  if (presence.desktop || (bridge.sessions.size === 0 && desktopHost.running)) {
    const focused = await hostFocus.isFocused();
    if (typeof focused === 'boolean') return focused;
  }
  return !!presence.focused;
}

const brain = new Brain({
  ls, budget, models, log,
  getSettings: () => settings.value,
  getLanguage: language,
  getPresence: () => presence,
  isHostFocused: resolveHostFocus,
  // Comments are paid for by their own model, not by the one selected for the agent.
  getQuotaLevel: () => levelForModel(allBuckets, models.resolve(settings.value.ai.model)?.label || settings.value.ai.model),
  say: (result, trigger) => {
    broadcastAll({ t: 'say', text: result.text, mood: result.mood, ai: result.ai, force: trigger === 'greet' });
    if (process.env.HAGEMI_DEBUG) log(`${trigger}${result.ai ? ' (ai)' : ''}: ${result.text}`);
  },
});

function hudRows() {
  const strings = ui(), rows = quotaRows(quota.buckets, strings, language());
  rows.push({ label: strings.hud_agents, value: facts.subagents ? fill(strings.hud_subagents, facts) : facts.running ? fill(strings.hud_running, facts) : strings.hud_idle });
  const usage = budget.usage;
  if (settings.value.ai.enabled) rows.push({ label: strings.hud_comments, value: `${usage.calls}/${settings.value.ai.maxPerDay} · ~${usage.tokens}` });
  if (!facts.connected) rows.push({ label: 'Antigravity', value: strings.hud_unavailable });
  return rows;
}

const lastNotified = new Map();
let recentWorkResult = null;
async function dispatchNotification(event) {
  const cfg = settings.value?.notifications || {};
  let focused = presence.visible && presence.focused;
  if (event?.type !== 'test' && cfg.enabled !== false && cfg.whenFocused === false) {
    focused = await resolveHostFocus();
  }
  const notification = buildNotification(event, {
    language: language(),
    settings: settings.value,
    focused,
  });
  if (!notification) return false;
  if (event.type !== 'test') {
    const key = `${notification.conversationId || 'global'}|${notification.kind}`;
    const now = Date.now();
    if (now - (lastNotified.get(key) || 0) < 5000) return false;
    lastNotified.set(key, now);
  }
  desktopBridge.broadcast({ t: 'notify', notification });
  return true;
}

function workBadgeForState(state, strings) {
  if (!settings.value.workStatusEnabled) return null;
  if (facts.waiting) {
    return {
      tone: 'waiting',
      label: strings.work_waiting,
      conversationId: facts.waitingId || facts.primaryId || null,
      title: facts.waitingTitle || facts.title || '',
    };
  }
  if (facts.running > 0) {
    const keyMap = {
      thinking: 'work_thinking',
      deepthink: 'work_thinking',
      reading: 'work_reading',
      writing: 'work_writing',
      running: 'work_running',
      searching: 'work_searching',
      drawing: 'work_drawing',
      delegating: 'work_delegating',
      compacting: 'work_compacting',
      busy: 'work_busy',
      swamped: 'work_busy',
    };
    const labelKey = keyMap[state] || 'work_thinking';
    return {
      tone: 'work',
      label: strings[labelKey] || strings.work_thinking,
      conversationId: facts.primaryId || null,
      title: facts.title || '',
    };
  }
  if (recentWorkResult && Date.now() < recentWorkResult.until) {
    return {
      tone: recentWorkResult.tone,
      label: strings[recentWorkResult.labelKey] || strings.work_done,
      conversationId: recentWorkResult.conversationId,
      title: recentWorkResult.title,
    };
  }
  return null;
}

function publishFacts(force = false) {
  // She naps when neither the agents nor you have done anything for a while.
  const idleMs = Math.min(facts.idleMs || 0, presence.visible ? presence.idleMs : Infinity);
  const effectiveFacts = settings.value.workStatusEnabled
    ? { ...facts, idleMs }
    : { waiting: false, running: 0, subagents: 0, category: null, idleMs, quietMs: 0, connected: facts.connected };
  const state = chooseState(effectiveFacts, quota, { resetSoon: isResetSoon(quota, quotaOptions()) });
  if (lastState === 'sleeping' && state !== 'sleeping') moment('wake');
  lastState = state;
  const message = {
    t: 'facts', state, quota: quota.mood === 'empty' ? 'critical' : quota.mood, late: isLate(new Date()),
    subagents: settings.value.workStatusEnabled ? facts.subagents : 0,
    stashLevel: quota.level, stashLabel: quota.level == null ? '' : `${Math.round(quota.level * 100)}%`,
    hud: hudRows(),
    workBadge: workBadgeForState(state, ui()),
  };
  const json = JSON.stringify(message);
  if (process.env.HAGEMI_DEBUG && state !== lastLoggedState) {
    lastLoggedState = state;
    log(`state: ${state} (running ${facts.running}, subagents ${facts.subagents}, tool ${facts.lastTool || '-'}, category ${facts.category || '-'})`);
  }
  if (force || json !== lastFactsJson) {
    lastFactsJson = json;
    broadcastAll(message);
  } else broadcastAll({ t: 'heartbeat' });
}

function act(trigger) {
  const reaction = REACTIONS[trigger]?.react;
  if (reaction) broadcastAll({ t: 'react', ...reaction });
}

function context(extra = {}) {
  return {
    running: facts.running, subagents: facts.subagents, lastTool: facts.lastTool, toolCount: facts.toolCount, title: facts.title,
    userText: facts.userText, agentText: facts.agentText, quotaPercent: quota.level == null ? null : Math.round(quota.level * 100), model: selectedModel?.label,
    ...extra,
  };
}

// Say and act together: the reaction plays even when she stays quiet.
function moment(trigger, extra = {}, options = {}) {
  act(trigger);
  brain.consider(trigger, context(extra), options).catch(error => log(`remark failed: ${error.message}`));
}

function onEvent(event) {
  if (process.env.HAGEMI_DEBUG) log(`event: ${event.type}${event.name ? ` ${event.name}` : ''}${event.termination ? ` ${event.termination}` : ''}${event.isSubagent ? ' (subagent)' : ''}`);
  switch (event.type) {
    case 'turn_start':
      if (!activeSince) activeSince = Date.now();
      lastToolAt = Date.now();
      moment('turn_start');
      break;
    case 'turn_end': {
      const trigger = classifyTurnEnd(event);
      recentWorkResult = {
        tone: trigger === 'turn_error' || trigger === 'turn_maxed' ? 'error' : 'done',
        labelKey: trigger === 'turn_error' || trigger === 'turn_maxed' ? 'work_error' : 'work_done',
        conversationId: event.id || null,
        title: event.title || '',
        until: Date.now() + 10000,
      };
      setTimeout(() => publishFacts(), 10500).unref?.();
      schedulePostTurnQuotaRefresh();
      dispatchNotification({ ...event, type: trigger, agentText: event.agentText }).catch(error => log(`notify failed: ${error.message}`));
      moment(trigger, {
        title: event.title, toolCount: event.toolCount, durationMin: Math.round((event.durationMs || 0) / MINUTE),
        userText: event.userText, agentText: event.agentText, vars: { count: event.toolCount || 0 },
      });
      break;
    }
    case 'waiting_start':
      dispatchNotification({ type: 'waiting_start', id: event.id, title: event.title }).catch(error => log(`notify failed: ${error.message}`));
      break;
    case 'tool':
      lastToolAt = Date.now();
      if (event.category === 'drawing') moment('drawing');
      break;
    case 'step_error':
      moment('step_error');
      break;
    case 'compact':
      moment('compact');
      break;
    case 'context_big':
      moment('context_big', { title: event.title });
      break;
    case 'subagent_start': {
      const count = facts.subagents + 1;
      moment(count >= 3 ? 'subagent_many' : 'subagent_start', { vars: { count } });
      break;
    }
    case 'subagent_done':
      if (facts.subagents <= 1) moment('subagent_done');
      break;
    default:
      break;
  }
}

let previousRunning = 0, previousWaiting = false;
const monitor = new Monitor({
  ls, brainDir: join(appDataDir, 'brain'), onEvent,
  getPresence: () => presence,
  onFacts(next) {
    const now = Date.now();
    facts = { ...next, quietMs: lastToolAt ? now - lastToolAt : 0 };
    if (next.waiting && !previousWaiting) moment('waiting');
    previousWaiting = next.waiting;
    if (next.running === 2 && previousRunning < 2) moment('busy');
    if (next.running >= 3 && previousRunning < 3) moment('swamped', { vars: { count: next.running } });
    previousRunning = next.running;
    if (next.running || next.subagents) activeSince ||= now;
    else if (next.idleMs > 10 * MINUTE) activeSince = null;
    if (next.longestRunMs > 12 * MINUTE && !monitor.longRunWarned) { monitor.longRunWarned = true; moment('long_run', { durationMin: Math.round(next.longestRunMs / MINUTE) }); }
    if (!next.running) monitor.longRunWarned = false;
    publishFacts();
  },
});
monitor.onError = error => {
  if (facts.connected) log(`monitor: ${error.message}`);
  facts = { ...facts, connected: false };
};

let lastQuotaPollAt = 0;
let quotaPollInFlight = null;
let quotaTimer = null;
let turnQuotaTimer = null;

async function pollQuota() {
  if (quotaPollInFlight) return quotaPollInFlight;
  quotaPollInFlight = (async () => {
    try {
      const response = await ls.call('RetrieveUserQuotaSummary');
      const now = Date.now();
      lastQuotaPollAt = now;
      allBuckets = parseQuota(response, now);
      const next = summarize(allBuckets, selectedModel?.label || 'gemini', quotaOptions(), now);
      for (const event of quotaEvents(quota, next, quotaOptions())) {
        if (event.type === 'quota_ok') continue;
        moment(event.type, { vars: { left: event.type === 'reset_soon' ? formatDuration(event.resetInMs, language()) : `${Math.round(event.level * 100)}%` } });
      }
      quota = next;
      publishFacts();
    } catch (error) { log(`quota: ${error.message}`); }
  })().finally(() => {
    quotaPollInFlight = null;
    scheduleQuotaCheck();
  });
  return quotaPollInFlight;
}

function scheduleQuotaCheck() {
  clearTimeout(quotaTimer);
  if (stopping) return;
  const plan = evaluateQuotaSchedule({
    now: Date.now(),
    lastPollAt: lastQuotaPollAt,
    resetInMs: quota.resetInMs,
    idleMs: presence.idleMs,
    locked: presence.locked,
    visible: presence.visible,
  });
  quotaTimer = setTimeout(() => {
    const check = evaluateQuotaSchedule({
      now: Date.now(),
      lastPollAt: lastQuotaPollAt,
      resetInMs: quota.resetInMs,
      idleMs: presence.idleMs,
      locked: presence.locked,
      visible: presence.visible,
    });
    if (check.shouldPoll) pollQuota();
    else scheduleQuotaCheck();
  }, plan.nextCheckMs);
  quotaTimer.unref?.();
}

function schedulePostTurnQuotaRefresh() {
  clearTimeout(turnQuotaTimer);
  turnQuotaTimer = setTimeout(() => {
    turnQuotaTimer = null;
    pollQuota();
  }, 2000);
  turnQuotaTimer.unref?.();
}

// Which model the user has picked: she has opinions about the competition.
async function pollModel() {
  try {
    const state = await readFile(join(appDataDir, 'antigravity_state.pbtxt'), 'utf8');
    const id = state.match(/last_selected_agent_model:\s*(\S+)/)?.[1];
    if (!id) return;
    await models.refresh();
    const label = models.labelOf(id);
    if (!label) return;
    const next = { id, label, family: modelFamily(label) };
    const previous = selectedModel;
    selectedModel = next;
    if (previous && previous.id !== next.id) {
      if (next.family === 'claude' || next.family === 'gpt') moment(`model_rival_${next.family}`);
      else if (next.family === 'gemini' && previous.family !== 'gemini') moment('model_back');
    }
  } catch { /* The state file format is the app's own; she just goes without opinions. */ }
}

function greet() {
  const now = new Date();
  const fest = festival(now);
  const scene = fest || `greet_${timeOfDay(now)}`;
  broadcastAll({ t: 'react', state: scene, ms: 4200, gesture: 'hop', burst: 'sparkles' });
  brain.consider('greet', {}, { line: scene }).catch(() => {});
}

function ambient() {
  for (const trigger of ambientTriggers({
    now: Date.now(), active: facts.running > 0, activeSinceMs: activeSince ? Date.now() - activeSince : 0,
    lastRemarkAgoMs: Date.now() - brain.lastBubbleAt, idleMs: Math.min(facts.idleMs || 0, presence.idleMs || 0),
  })) {
    moment(trigger, { vars: { name: `${new Date().getHours()}:00` } });
    break;
  }
}

let greeted = false;
function onPetMessage(message, session) {
  switch (message.type) {
    case 'ready':
      if (session?.desktop) desktopBackoffIndex = 0;
      sendTo(session, { t: 'hello', settings: settings.value, ui: ui() });
      sendTo(session, { t: 'update', update: updater.state });
      lastFactsJson = '';
      publishFacts(true);
      sendModelChoices(session);
      if (!greeted) { greeted = true; setTimeout(greet, 900); }
      break;
    case 'panelOpened':
      sendTo(session, { t: 'update', update: updater.state });
      break;
    case 'update_check':
      updater.check({ manual: message.manual !== false });
      break;
    case 'update_install':
      updater.install();
      break;
    case 'update_rollback':
      updater.rollback();
      break;
    case 'art':
      sendTo(session, { t: 'art', name: message.name, data: readArt(message.name) });
      break;
    case 'settings': {
      const beforeLang = settings.value.language;
      const beforeMode = settings.value.renderMode;
      settings.patch(message.patch);
      if (settings.value.language !== beforeLang) broadcastAll({ t: 'settings', settings: settings.value, ui: ui() });
      if (settings.value.renderMode !== beforeMode) syncDesktopFallback();
      publishFacts();
      break;
    }
    case 'hud_hover':
      monitor.wake();
      if (shouldHoverRefreshQuota({ now: Date.now(), lastPollAt: lastQuotaPollAt })) pollQuota();
      break;
    case 'presence': {
      const wasLockedOrDeepIdle = presence.locked || presence.idleMs >= 2 * MINUTE;
      presence = {
        visible: !!message.visible,
        focused: !!message.focused,
        locked: !!message.locked,
        idleMs: Number(message.idleMs) || 0,
        desktop: !!message.desktop || !!session?.desktop,
      };
      if (message.language) appLanguage = message.language;
      if (wasLockedOrDeepIdle && !presence.locked && presence.idleMs < 30000) {
        monitor.wake();
        scheduleQuotaCheck();
      }
      break;
    }
    case 'remount':
      if (!session?.desktop) bridge.remount(session);
      break;
    case 'talk':
      monitor.wake();
      brain.consider('talk', context(), { force: true, line: 'talk_offline' }).catch(() => {});
      break;
    case 'activity':
      if (message.kind === 'roam' || message.kind === 'play') {
        brain.consider(message.kind, {}, { force: true }).catch(() => {});
      }
      break;
    case 'notify_test':
      dispatchNotification({ type: 'test', id: facts.primaryId || null, title: facts.title || '' }).catch(error => log(`notify failed: ${error.message}`));
      break;
    case 'focus_conversation':
      bridge.focusConversation(message.conversationId);
      if (!session?.desktop) {
        desktopBridge.broadcast({ t: 'focus_conversation', conversationId: message.conversationId || null, title: message.title || '' });
      }
      break;
    case 'notification_clicked':
      bridge.focusConversation(message.conversationId);
      broadcastAll({ t: 'react', gesture: 'hop', burst: 'sparkles' });
      break;
    case 'touch': {
      const known = ['poke', 'pet', 'coax', 'annoyed', 'puffed', 'redhot', 'sulk', 'shaken', 'grab'];
      if (known.includes(message.kind)) brain.consider(message.kind, {}).catch(() => {});
      break;
    }
    case 'error':
      log(`pet error: ${String(message.message).slice(0, 400)}`);
      break;
    default:
      break;
  }
}

async function sendModelChoices(session) {
  try {
    const configs = await models.refresh();
    sendTo(session, { t: 'models', models: configs.map(c => c.label), usage: budget.usage });
  } catch { /* The picker falls back to a free-text field. */ }
}

let desktopQueue = Promise.resolve();
function syncDesktopFallback() {
  if (stopping) return desktopQueue;
  desktopQueue = desktopQueue.then(async () => {
    if (stopping) return;
    const mode = process.env.HAGEMI_NO_DESKTOP === '1' ? 'cdp' : (settings.value.renderMode || 'auto');
    await bridge.setEnabled(mode !== 'desktop');
    if (mode === 'cdp' || bridge.sessions.size > 0) {
      if (desktopHost.running || desktopBridge.server) {
        await desktopHost.stop();
        await desktopBridge.stop();
        log(mode === 'cdp' ? 'cdp-only mode, stopped desktop overlay' : 'cdp connected, stopped desktop overlay');
      }
      return;
    }
    if (!desktopHost.running && Date.now() >= desktopNextTryAt) {
      const { url } = await desktopBridge.start();
      const started = desktopHost.start(url);
      if (started) log('desktop overlay started');
      else desktopNextTryAt = Date.now() + 60000;
    }
  }).catch(error => log(`desktop overlay: ${error.message}`));
  return desktopQueue;
}

const timers = [setInterval(pollModel, 20000), setInterval(ambient, 5 * MINUTE)];
const checkUpdates = () => { if (settings.value.autoCheckUpdates) updater.check({ manual: false }); };
timers.push(setTimeout(checkUpdates, 15000), setInterval(checkUpdates, UPDATE_INTERVAL_MS));
timers.push(setTimeout(syncDesktopFallback, 1500), setInterval(syncDesktopFallback, 10000));
for (const timer of timers) timer.unref?.();
pollModel().then(pollQuota);
monitor.start();
if ((process.env.HAGEMI_NO_DESKTOP === '1' ? 'cdp' : settings.value.renderMode) !== 'desktop') {
  bridge.start();
} else {
  bridge.setEnabled(false);
}
log(`started, data in ${dataDir}`);

// Keep the process alive even when every timer above is unreferenced.
const keepAlive = setInterval(() => {}, 1 << 30);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  clearTimeout(quotaTimer);
  clearTimeout(turnQuotaTimer);
  monitor.stop();
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref?.();
  await desktopHost.stop();
  await desktopBridge.stop();
  await bridge.stop();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);

// Uninstalling while she runs fails on Windows: the app's launcher keeps the plugin folder open
// and the uninstall stops halfway, with her files gone. Leave then, so a second try succeeds.
const manifest = join(dirname(fileURLToPath(import.meta.url)), 'sidecar.json');
const orphanCheck = setInterval(() => {
  if (existsSync(manifest)) return;
  log('plugin files removed, leaving');
  shutdown();
}, 5000);
orphanCheck.unref?.();
