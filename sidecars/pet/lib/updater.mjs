// Source-only updates from the public upstream. Git does the final fast-forward, so local work
// and divergent history are never replaced. Nothing is installed by a background check.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const DEFAULT_REPO_SLUG = 'amspokermesecar-afk/hagemi-pet-agy';
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const UPDATE_REPO = `https://github.com/${DEFAULT_REPO_SLUG}.git`;
const SHA = /^[a-f0-9]{40}$/;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const SENSITIVE_PATTERNS = [
  /^sidecars\/pet\/main\.mjs$/,
  /^sidecars\/pet\/sidecar\.json$/,
  /^sidecars\/pet\/desktop\//,
  /^sidecars\/pet\/lib\/(?:ls-client|updater|desktop-host|desktop-bridge|host-focus)\.mjs$/,
  /^tools\//,
  /^\.github\/workflows\//,
  /^(?:package|package-lock|plugin)\.json$/,
];

export function parseRepoSlug(raw) {
  const value = String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_SLUG.test(value) || value.includes('..')) return DEFAULT_REPO_SLUG;
  return value;
}

export function classifyUpdateRisk(files = []) {
  const list = Array.isArray(files) ? files.map(f => (typeof f === 'string' ? f : f?.filename || '')).filter(Boolean) : [];
  const sensitiveFiles = list.filter(name => SENSITIVE_PATTERNS.some(pattern => pattern.test(name)));
  return {
    riskLevel: sensitiveFiles.length > 0 ? 'high' : 'low',
    sensitiveFiles,
    totalFiles: list.length,
  };
}

export async function runGit(root, args) {
  const { stdout } = await exec('git', ['-C', root, ...args], {
    windowsHide: true, timeout: 120000, maxBuffer: 1 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
  });
  return stdout.trim();
}

export class Updater {
  constructor({
    root,
    installedRoot,
    repoSlug = process.env.HAGEMI_UPDATE_REPO || DEFAULT_REPO_SLUG,
    stateFile = null,
    getCooldownHours = () => 0,
    now = Date.now,
    git = runGit,
    fetchFn = fetch,
    onChange = () => {},
    onInstalled = () => {},
    log = () => {},
  }) {
    this.root = resolve(root);
    this.isInstalled = this.root === resolve(installedRoot);
    this.repoSlug = parseRepoSlug(repoSlug);
    this.repoUrl = `https://github.com/${this.repoSlug}.git`;
    this.apiUrl = `https://api.github.com/repos/${this.repoSlug}`;
    this.webUrl = `https://github.com/${this.repoSlug}`;
    this.stateFile = stateFile;
    this.getCooldownHours = getCooldownHours;
    this.now = now;
    this.git = args => git(this.root, args);
    this.fetch = fetchFn;
    this.onChange = onChange;
    this.onInstalled = onInstalled;
    this.log = log;
    this.state = {
      phase: 'idle',
      currentVersion: '',
      currentSha: '',
      latestSha: '',
      canInstall: false,
      reason: '',
      commitCount: 0,
      summary: '',
      commitDate: '',
      verified: false,
      compareUrl: '',
      riskLevel: 'low',
      sensitiveFiles: [],
      totalFiles: 0,
      inCooldown: false,
      cooldownRemainingHours: 0,
      rollbackSha: '',
      canRollback: false,
    };
    this.pending = null;
    this.checkedAt = 0;
    this.lastCheckManual = false;
  }

  readSavedRollback() {
    if (!this.stateFile) return '';
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      return SHA.test(parsed?.previousSha || '') ? parsed.previousSha : '';
    } catch {
      return '';
    }
  }

  writeSavedRollback(sha) {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ previousSha: sha || '', savedAt: this.now() }, null, 2));
    } catch { /* Non-fatal: rollback metadata is best-effort. */ }
  }

  publish(change) {
    this.state = { ...this.state, ...change };
    this.onChange(this.state);
    return this.state;
  }

  async local() {
    try { this.state.currentVersion = JSON.parse(await readFile(resolve(this.root, 'plugin.json'), 'utf8')).version || ''; } catch {}
    const savedRollback = this.readSavedRollback();
    try {
      // A copied plugin must not accidentally find a parent checkout and update that instead.
      const top = await this.git(['rev-parse', '--show-toplevel']);
      if (resolve(top) !== this.root) throw new Error('not the plugin checkout');
      const sha = await this.git(['rev-parse', 'HEAD']);
      if (!SHA.test(sha)) throw new Error('invalid local commit');
      const dirty = !!await this.git(['status', '--porcelain', '--untracked-files=all']);
      const rollbackSha = savedRollback && savedRollback !== sha ? savedRollback : '';
      return {
        currentSha: sha,
        canInstall: this.isInstalled && !dirty,
        reason: !this.isInstalled ? 'checkout' : dirty ? 'local_changes' : '',
        rollbackSha,
        canRollback: Boolean(this.isInstalled && !dirty && rollbackSha),
      };
    } catch {
      return {
        currentSha: '',
        canInstall: false,
        reason: this.isInstalled ? 'no_git' : 'checkout',
        rollbackSha: '',
        canRollback: false,
      };
    }
  }

  async json(url) {
    const response = await this.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hagemi-Pet-Updater' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'rate_limited' : 'network');
    return response.json();
  }

  check({ manual = true } = {}) {
    if (this.pending) return this.pending;
    if (this.state.phase === 'installed') return Promise.resolve(this.state);
    // Coalesce clicks across app windows and avoid spending GitHub's anonymous rate limit.
    // A manual check bypasses a cached background 'cooling' result so the user can review and decide.
    const cacheable = ['current', 'available', 'cooling'].includes(this.state.phase)
      && (this.state.canInstall || this.state.phase === 'current' || (!manual && this.state.phase === 'cooling'));
    if (cacheable && (!manual || this.lastCheckManual) && this.checkedAt && this.now() - this.checkedAt < 60000) {
      return Promise.resolve(this.state);
    }
    this.pending = this.checkNow({ manual }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async checkNow({ manual = true } = {}) {
    this.publish({ phase: 'checking' });
    try {
      const local = await this.local();
      const latest = await this.json(`${this.apiUrl}/commits/main`);
      if (!SHA.test(latest.sha)) throw new Error('network');

      let commitDate = latest.commit?.committer?.date || latest.commit?.author?.date || '';
      let summary = String(latest.commit?.message || '').split(/\r?\n/)[0].trim().slice(0, 120);
      let verified = Boolean(latest.commit?.verification?.verified);
      let commitCount = 0;
      let compareUrl = `${this.webUrl}/commit/${latest.sha}`;
      let risk = { riskLevel: 'low', sensitiveFiles: [], totalFiles: 0 };

      let phase = local.currentSha ? 'available' : 'manual';
      if (local.currentSha === latest.sha) {
        phase = 'current';
      } else if (local.currentSha) {
        // A different hash could also be a newer local commit or a separate branch.
        const comparison = await this.json(`${this.apiUrl}/compare/${local.currentSha}...${latest.sha}`);
        if (comparison.status === 'behind' || comparison.status === 'identical') {
          phase = 'current';
        } else if (comparison.status === 'diverged') {
          local.canInstall = false;
          local.reason = 'diverged';
        } else if (comparison.status !== 'ahead') {
          throw new Error('network');
        }
        if (phase === 'available') {
          compareUrl = typeof comparison.html_url === 'string' && comparison.html_url.startsWith('https://github.com/')
            ? comparison.html_url
            : `${this.webUrl}/compare/${local.currentSha}...${latest.sha}`;
          risk = classifyUpdateRisk(comparison.files);
          const commits = Array.isArray(comparison.commits) ? comparison.commits : [];
          commitCount = Number(comparison.ahead_by) || commits.length || 1;
          const tip = commits[commits.length - 1];
          if (!summary && tip?.commit?.message) summary = String(tip.commit.message).split(/\r?\n/)[0].trim().slice(0, 120);
          if (!commitDate && (tip?.commit?.committer?.date || tip?.commit?.author?.date)) {
            commitDate = tip.commit.committer?.date || tip.commit.author?.date || '';
          }
          if (!verified && tip?.commit?.verification?.verified) verified = true;
        }
      }

      const cooldownHours = Math.max(0, Number(this.getCooldownHours?.()) || 0);
      let inCooldown = false;
      let cooldownRemainingHours = 0;
      if (phase === 'available' && cooldownHours > 0 && commitDate) {
        const publishedMs = Date.parse(commitDate);
        if (Number.isFinite(publishedMs)) {
          const ageMs = Math.max(0, this.now() - publishedMs);
          const requiredMs = cooldownHours * HOUR_MS;
          if (ageMs < requiredMs) {
            inCooldown = true;
            cooldownRemainingHours = Math.max(1, Math.ceil((requiredMs - ageMs) / HOUR_MS));
            if (!manual) {
              phase = 'cooling';
              local.canInstall = false;
              local.reason = 'cooldown';
            }
          }
        }
      }

      this.checkedAt = this.now();
      this.lastCheckManual = manual;
      return this.publish({
        ...local,
        phase,
        latestSha: latest.sha,
        commitCount,
        summary,
        commitDate,
        verified,
        compareUrl,
        riskLevel: risk.riskLevel,
        sensitiveFiles: risk.sensitiveFiles,
        totalFiles: risk.totalFiles,
        inCooldown,
        cooldownRemainingHours,
      });
    } catch (error) {
      this.log(`update check: ${error.message}`);
      return this.publish({ phase: 'error', reason: error.message === 'rate_limited' ? 'rate_limited' : 'network', canInstall: false });
    }
  }

  install() {
    if (this.pending) return this.pending;
    if (this.state.phase !== 'available' || !this.state.canInstall || !SHA.test(this.state.latestSha)) return Promise.resolve(this.state);
    this.pending = this.installNow().finally(() => { this.pending = null; });
    return this.pending;
  }

  async installNow() {
    const target = this.state.latestSha;
    this.publish({ phase: 'installing' });
    try {
      const local = await this.local();
      if (!local.canInstall) return this.publish({ ...local, phase: 'available' });
      // Fetch the exact reviewed commit from the configured upstream, never an editable remote URL.
      await this.git(['fetch', '--no-tags', this.repoUrl, target]);
      if (await this.git(['status', '--porcelain', '--untracked-files=all'])) return this.publish({ phase: 'available', reason: 'local_changes', canInstall: false });
      try { await this.git(['merge-base', '--is-ancestor', 'HEAD', target]); }
      catch { return this.publish({ phase: 'available', reason: 'diverged', canInstall: false }); }
      this.writeSavedRollback(local.currentSha);
      await this.git(['-c', `core.hooksPath=${resolve(this.root, '.git', 'hagemi-no-hooks')}`, 'merge', '--ff-only', '--no-edit', target]);
      if (await this.git(['rev-parse', 'HEAD']) !== target) throw new Error('update did not reach the requested commit');
      const state = this.publish({
        phase: 'installed',
        currentSha: target,
        canInstall: false,
        reason: '',
        rollbackSha: local.currentSha,
        canRollback: true,
      });
      this.onInstalled();
      return state;
    } catch (error) {
      this.log(`update install: ${error.message}`);
      this.checkedAt = 0;
      return this.publish({ phase: 'error', reason: 'install_failed', canInstall: false });
    }
  }

  rollback() {
    if (this.pending) return this.pending;
    if (this.state.phase === 'installed') return Promise.resolve(this.state);
    if (!this.state.canRollback || !SHA.test(this.state.rollbackSha)) return Promise.resolve(this.state);
    this.pending = this.rollbackNow().finally(() => { this.pending = null; });
    return this.pending;
  }

  async rollbackNow() {
    const target = this.state.rollbackSha;
    this.publish({ phase: 'installing' });
    try {
      const local = await this.local();
      if (!local.canRollback || local.rollbackSha !== target) {
        return this.publish({ ...local, phase: 'error', reason: 'rollback_failed', canInstall: false });
      }
      // Only allow rolling back to a strict ancestor already present in local git history.
      try { await this.git(['merge-base', '--is-ancestor', target, 'HEAD']); }
      catch { return this.publish({ ...local, phase: 'error', reason: 'rollback_failed', canInstall: false }); }
      await this.git(['-c', `core.hooksPath=${resolve(this.root, '.git', 'hagemi-no-hooks')}`, 'reset', '--hard', target]);
      if (await this.git(['rev-parse', 'HEAD']) !== target) throw new Error('rollback did not reach previous commit');
      this.writeSavedRollback('');
      const state = this.publish({
        phase: 'installed',
        currentSha: target,
        canInstall: false,
        reason: '',
        rollbackSha: '',
        canRollback: false,
      });
      this.onInstalled();
      return state;
    } catch (error) {
      this.log(`update rollback: ${error.message}`);
      this.checkedAt = 0;
      return this.publish({ phase: 'error', reason: 'rollback_failed', canInstall: false });
    }
  }
}
