// The pet's presence on screen: stage, pose loading, drag and throw, petting, bubble, menu and
// the bridge to the sidecar. It all lives in a closed shadow root so the app's UI is untouched.
HAGEMI.boot = async function boot(send, options = {}) {
  const { clamp, lerp, rand } = HAGEMI.util;
  const { STAGE, MARGIN } = HAGEMI;
  const SIZES = { xs: 130, s: 175, m: 225, l: 295, xl: 380 };
  const HOST_ID = 'hagemi-pet-host';
  const FADE_MS = 120;
  const WALK_FADE_MS = 45;
  const POSE_CACHE = 16;

  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(HAGEMI.css);
  root.adoptedStyleSheets = [sheet];

  const make = (tag, className, parent = root) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
  };
  const stage = make('div', 'stage');
  const backCanvas = make('canvas', 'layer', stage);
  const glCanvas = make('canvas', 'layer', stage);
  const frontCanvas = make('canvas', 'layer', stage);
  const hit = make('div', 'hit', stage);
  const bubble = make('div', 'bubble');
  const bubbleMark = make('span', 'mark', bubble);
  const bubbleText = make('span', 'text', bubble);
  const hud = make('div', 'hud');
  const workPill = make('button', 'work-pill');
  workPill.type = 'button';
  const menu = make('div', 'menu');
  menu.setAttribute('role', 'menu');
  const panel = make('div', 'panel');
  panel.setAttribute('role', 'dialog');

  let leaving = 0, running = true;
  const rig = HAGEMI.createRig(glCanvas, () => { if (running) { dispose(); send({ type: 'remount' }); } });
  if (!rig) { send({ type: 'error', message: 'webgl2-unavailable' }); return null; }
  const fx = HAGEMI.createFx(backCanvas, frontCanvas);
  const animator = HAGEMI.createAnimator(fx);

  let settings = {
    language: 'en', size: 'm', hidden: false, muted: false, animation: 'balanced', renderMode: 'auto',
    followCursor: true, desktopDisplay: 'primary', alwaysOnTopLevel: 'screen-saver', hideWhenHostMinimized: true,
    roamEnabled: true, workStatusEnabled: true, quotaHoverDelayMs: 650,
    notifications: { enabled: true, onDone: true, onWaiting: true, whenFocused: true }, position: null,
  };
  let ui = {};
  let updateState = { phase: 'idle' }, updateCard = null;
  let desktopDisplays = [];
  let hudRows = [];
  let workBadge = null, baseState = 'idle', facing = 1, roam = null, lastPlayId = null;
  let nextAutoAt = performance.now() + rand(5000, 9000);
  let scale = 0, pixelRatio = 0, screenRatio = 0, spriteW = 0, spriteH = 0;
  let x = 0, y = 0, vx = 0, vy = 0;
  let dragging = null;
  let lastOverPet = false, lastOverBubble = false, lastOverPanel = false, lastOverWork = false, lastInteractive = null;
  let desktopIdleSec = 0, desktopLocked = false, hostMinimized = false;
  const abort = new AbortController();
  const listen = (target, type, handler, extra = {}) => target.addEventListener(type, handler, { signal: abort.signal, ...extra });

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  animator.setReducedMotion(reducedMotion.matches);
  listen(reducedMotion, 'change', () => animator.setReducedMotion(reducedMotion.matches));

  // ---- Art: requested over the sidecar bridge, one pose at a time --------------------------
  const blobs = new Map(), pendingArt = new Map(), poses = new Map(), building = new Map();
  let current = null, previous = null, fade = 1, fadeStart = 0, fadeDuration = FADE_MS, wantedPose = null;

  function requestArt(name) {
    if (blobs.has(name)) return Promise.resolve(blobs.get(name));
    if (pendingArt.has(name)) return pendingArt.get(name).promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pendingArt.set(name, { promise, resolve });
    send({ type: 'art', name });
    return promise;
  }
  function receiveArt(name, data) {
    const entry = pendingArt.get(name);
    let blob = null;
    if (data) {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      blob = new Blob([bytes], { type: 'image/webp' });
      blobs.set(name, blob);
    }
    pendingArt.delete(name);
    entry?.resolve(blob);
  }
  const decode = blob => createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });

  async function ensurePose(name) {
    if (poses.has(name)) return poses.get(name);
    if (building.has(name)) return building.get(name);
    const job = (async () => {
      const info = HAGEMI.rigData[name];
      if (!info) return null;
      const files = await Promise.all([
        requestArt(name),
        info.blink ? requestArt(`blink/${name}`) : null,
        ...['tail', 'under', 'cut'].map(layer => (info.tailRect ? requestArt(`${layer}/${name}`) : null)),
        ...(info.walkLegs ? [`limbs/${name}_leg_l`, `limbs/${name}_leg_r`, `limbs/${name}_leg_cut`].map(requestArt) : []),
      ]);
      if (!files[0] || !running) return null;
      const layers = await Promise.all(files.map(blob => (blob ? decode(blob) : null)));
      let pose;
      try {
        const [bitmap, blinkBitmap, tailBitmap, underBitmap, cutBitmap, legLBitmap, legRBitmap, legCutBitmap] = layers;
        pose = rig.buildPose(name, bitmap, blinkBitmap, tailBitmap, underBitmap, cutBitmap, info, legLBitmap, legRBitmap, legCutBitmap);
      } finally {
        for (const layer of layers) layer?.close();
      }
      poses.set(name, pose);
      // Keep only the poses in recent use on the GPU; the compressed art stays in memory.
      if (poses.size > POSE_CACHE) for (const [other, value] of poses) {
        if (value !== current && value !== previous && other !== wantedPose) { rig.freePose(value); poses.delete(other); break; }
      }
      return pose;
    })().finally(() => building.delete(name));
    building.set(name, job);
    return job;
  }
  async function preloadClones() {
    const art = await requestArt('idle');
    if (!art || !running) return;
    fx.setCloneImage(await createImageBitmap(art, { resizeWidth: 222, resizeHeight: 256, resizeQuality: 'high' }));
  }
  function preloadWalkPoses() {
    for (const name of HAGEMI.WALK_POSES || []) {
      ensurePose(name).catch(err => send({ type: 'error', message: `pose ${name}: ${err?.message || err}` }));
    }
  }
  function usePose(name, { fast = false } = {}) {
    if (wantedPose === name || !name) return;
    wantedPose = name;
    const duration = fast ? WALK_FADE_MS : FADE_MS;
    ensurePose(name).then(pose => {
      if (!pose || wantedPose !== name || current === pose) return;
      previous = current;
      current = pose;
      fadeDuration = duration;
      fade = previous ? 0 : 1;
      fadeStart = performance.now();
      if (previous && !fast) animator.play('pop');
    }).catch(err => send({ type: 'error', message: `pose ${name}: ${err?.message || err}` }));
  }

  function applySize() {
    const height = SIZES[settings.size] || SIZES.m;
    scale = height / STAGE.h;
    screenRatio = window.devicePixelRatio || 1;
    pixelRatio = Math.min(2, screenRatio);
    spriteW = 500 * scale;
    spriteH = height;
    // The canvases are sized in whole screen pixels and shown at exactly that size: a canvas
    // stretched even a fraction of a pixel is resampled by the browser and goes soft.
    const pixelW = Math.ceil((STAGE.w + MARGIN * 2) * scale * pixelRatio), pixelH = Math.ceil((STAGE.h + MARGIN * 2) * scale * pixelRatio);
    stage.style.width = `${pixelW / pixelRatio}px`;
    stage.style.height = `${pixelH / pixelRatio}px`;
    hit.style.left = `${MARGIN * scale}px`;
    hit.style.top = `${MARGIN * scale}px`;
    hit.style.width = `${STAGE.w * scale}px`;
    hit.style.height = `${spriteH}px`;
    rig.resize(pixelW, pixelH);
    fx.resize(pixelW, pixelH);
    keepInBounds();
  }

  const viewW = () => window.innerWidth, viewH = () => window.innerHeight;
  function keepInBounds() {
    if (docked) { x = docked === 'left' ? 0 : viewW(); y = clamp(y, spriteH * 0.3, Math.max(spriteH * 0.3, viewH() - spriteH * 0.3)); return; }
    const marginX = spriteW * 0.22, marginY = spriteH * 0.2;
    x = clamp(x, marginX, Math.max(marginX, viewW() - marginX));
    y = clamp(y, marginY, Math.max(marginY, viewH() - marginY));
  }

  // Her spot is kept as a fraction of the window: a hidden window measures zero when she
  // arrives, and a resize should carry her along rather than strand her.
  let anchor = null, docked = null;
  function placeInitial() {
    const p = settings.position;
    anchor = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    docked = p && (p.dock === 'left' || p.dock === 'right') ? p.dock : null;
    settle();
  }
  function settle() {
    if (viewW() < 8 || viewH() < 8) return;
    if (!anchor) anchor = { x: 1 - (spriteW * 0.7) / viewW(), y: 1 - (spriteH * 0.62) / viewH() };
    x = anchor.x * viewW();
    y = anchor.y * viewH();
    keepInBounds();
  }

  // ---- Bubble ---------------------------------------------------------------------------
  let lastKeyAt = -1e9, lastPointerAt = performance.now();
  let speech = null, speechQueue = [];
  function placeBubble() {
    const width = bubble.offsetWidth, height = bubble.offsetHeight;
    const headX = docked === 'left' ? x + spriteW * 0.26 : docked === 'right' ? x - spriteW * 0.26 : x, top = y - spriteH * 0.52;
    let left = clamp(headX - width / 2, 8, viewW() - width - 8), topPx = top - height - 4, side = 'above';
    if (topPx < 6) {
      const roomRight = viewW() - (x + spriteW * 0.5);
      if (roomRight > width + 12) { left = x + spriteW * 0.46; side = 'right'; } else { left = Math.max(8, x - spriteW * 0.46 - width); side = 'left'; }
      topPx = clamp(y - spriteH * 0.38, 6, viewH() - height - 6);
    }
    bubble.style.transform = `translate3d(${left}px, ${topPx}px, 0)`;
    bubble.dataset.side = side;
    bubble.style.setProperty('--tail-x', `${clamp(headX - left, 18, width - 18)}px`);
  }
  function startSpeech(item) {
    const cjk = /[㐀-鿿぀-ヿ]/.test(item.text);
    speech = { ...item, chars: Array.from(item.text), shown: 0, clock: 0, step: cjk ? 0.042 : 0.019, finished: 0, hold: item.ms || clamp(1900 + item.text.length * (cjk ? 110 : 48), 2900, 9500) };
    bubbleText.textContent = '';
    bubbleMark.textContent = item.ai ? '✦' : '';
    bubble.classList.add('show');
    placeBubble();
    const mood = HAGEMI.MOODS[item.mood];
    if (mood && !sulking && !dragging && !docked) animator.override(mood, speech.hold + 600);
    animator.setTalking(true);
  }
  function stepSpeech(dt, now) {
    if (!speech) {
      // Keep quiet while someone is typing, then speak.
      if (speechQueue.length && (now - lastKeyAt > 1400 || now - speechQueue[0].queuedAt > 12000)) startSpeech(speechQueue.shift());
      return;
    }
    if (speech.shown < speech.chars.length) {
      speech.clock += dt;
      while (speech.clock >= speech.step && speech.shown < speech.chars.length) {
        speech.clock -= speech.step;
        speech.shown++;
      }
      bubbleText.textContent = speech.chars.slice(0, speech.shown).join('');
      placeBubble();
      if (speech.shown >= speech.chars.length) { speech.finished = now; animator.setTalking(false); }
    } else if (!bubble.matches(':hover') && now - speech.finished > speech.hold) {
      closeBubble();
    }
  }
  function closeBubble() {
    speech = null;
    animator.setTalking(false);
    bubble.classList.remove('show');
    syncDesktopHit(lastOverPet, false, lastOverPanel);
  }
  listen(bubble, 'click', closeBubble);

  // ---- HUD and menu ---------------------------------------------------------------------
  function renderHud() {
    hud.replaceChildren();
    for (const row of hudRows) {
      const line = make('div', 'row', hud);
      make('span', 'label', line).textContent = row.label;
      if (row.level != null) {
        const meter = make('span', 'meter', line);
        const fill = make('span', 'fill', meter);
        fill.style.width = `${Math.round(row.level * 100)}%`;
        fill.dataset.tone = row.level < 0.1 ? 'bad' : row.level < 0.25 ? 'warn' : 'ok';
      }
      make('span', 'value', line).textContent = row.value;
    }
  }
  function placeHud() {
    const width = hud.offsetWidth, height = hud.offsetHeight;
    const left = clamp(x - width / 2, 8, viewW() - width - 8);
    const below = y + spriteH * 0.52 + 6;
    const top = below + height < viewH() ? below : clamp(y - spriteH * 0.52 - height - 6, 6, viewH() - height - 6);
    hud.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }
  let hoverTimer = 0;
  function showHud() { if (hudRows.length && !dragging && !menu.classList.contains('show') && !panel.classList.contains('show')) { send({ type: 'hud_hover' }); renderHud(); hud.classList.add('show'); placeHud(); animator.setMood({ showStash: true }); syncWorkPill(); } }
  function hideHud() { hud.classList.remove('show'); animator.setMood({ showStash: false }); syncWorkPill(); }

  function pointInVisible(el, cx, cy) {
    if (!el.classList.contains('show')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
  }
  function syncDesktopHit(overPet = lastOverPet, overBubble = lastOverBubble, overPanel = lastOverPanel, overWork = lastOverWork) {
    lastOverPet = !!overPet;
    lastOverBubble = !!overBubble;
    lastOverPanel = !!overPanel;
    lastOverWork = !!overWork;
    if (!options.desktop) return;
    const hidden = stage.style.display === 'none';
    const selectOpen = panel.classList.contains('show') && root.activeElement?.tagName === 'SELECT';
    const interactive = Boolean(
      dragging ||
      menu.classList.contains('show') ||
      (!hidden && lastOverPet) ||
      (bubble.classList.contains('show') && lastOverBubble) ||
      (workPill.classList.contains('show') && lastOverWork) ||
      (panel.classList.contains('show') && (lastOverPanel || selectOpen))
    );
    if (interactive !== lastInteractive) {
      lastInteractive = interactive;
      window.__hagemiDesktop?.setInteractive(interactive);
    }
  }

  function placeWorkPill() {
    const width = workPill.offsetWidth, height = workPill.offsetHeight;
    const left = clamp(x - width / 2, 8, viewW() - width - 8);
    const below = y + spriteH * 0.5 + 4;
    const top = below + height < viewH() - 6 ? below : clamp(y - spriteH * 0.5 - height - 4, 6, viewH() - height - 6);
    workPill.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }
  function syncWorkPill() {
    const canShow = Boolean(
      workBadge &&
      settings.workStatusEnabled !== false &&
      !dragging &&
      !hud.classList.contains('show') &&
      !menu.classList.contains('show') &&
      !panel.classList.contains('show') &&
      stage.style.display !== 'none'
    );
    if (!canShow) {
      if (workPill.classList.contains('show')) {
        workPill.classList.remove('show');
        syncDesktopHit(lastOverPet, lastOverBubble, lastOverPanel, false);
      }
      return;
    }
    workPill.dataset.tone = workBadge.tone || 'work';
    workPill.textContent = workBadge.title ? `${workBadge.label} · ${workBadge.title}` : workBadge.label;
    workPill.title = ui.work_click_hint || 'Click to return to conversation';
    workPill.classList.add('show');
    placeWorkPill();
  }
  listen(workPill, 'click', () => {
    if (!workBadge) return;
    animator.play('hop');
    send({ type: 'focus_conversation', conversationId: workBadge.conversationId || null, title: workBadge.title || '' });
  });

  function stopRoam(save = false) {
    if (!roam) return;
    const stateName = roam.overrideState;
    roam = null;
    vx = 0;
    vy = 0;
    if (stateName) animator.clearOverride(stateName);
    if (save) savePosition();
  }
  function startRoam(styleName, { announce = false, fromUser = false } = {}) {
    if (docked || sulking || dragging || stage.style.display === 'none') return false;
    if (!fromUser && (settings.roamEnabled === false || !HAGEMI.canRoamInState(baseState))) return false;
    const plan = HAGEMI.planRoam({ x, y, viewW: viewW(), viewH: viewH(), spriteW, spriteH, facing, styleName });
    if (!plan) return false;
    stopRoam(false);
    facing = plan.dir;
    const overrideState = plan.state;
    roam = { plan, elapsed: 0, stage: 'lead', stageProgress: 0, overrideState, fromUser: !!fromUser };
    if (plan.state !== 'roamFloat') {
      for (const name of HAGEMI.WALK_POSES || []) {
        ensurePose(name).catch(err => send({ type: 'error', message: `pose ${name}: ${err?.message || err}` }));
      }
    }
    animator.override(overrideState, plan.totalSec * 1000 + 400);
    if (plan.burst) fx.burst(plan.burst, STAGE.cx, 400, 5);
    if (announce) send({ type: 'activity', kind: 'roam', style: plan.style });
    return true;
  }
  function startPlay(sceneId, { announce = true, fromUser = false } = {}) {
    if (docked || sulking || dragging || stage.style.display === 'none' || (!fromUser && baseState !== 'idle')) return false;
    stopRoam(false);
    const scene = (sceneId && HAGEMI.PLAY_SCENES.find(item => item.id === sceneId)) || HAGEMI.pickPlayScene(lastPlayId);
    if (!scene) return false;
    lastPlayId = scene.id;
    animator.override(scene.state, scene.ms);
    if (scene.gesture) animator.play(scene.gesture);
    if (scene.burst) fx.burst(scene.burst, STAGE.cx, 400, 6);
    if (announce) send({ type: 'activity', kind: 'play', scene: scene.id });
    return true;
  }
  function restIdle() {
    stopRoam(true);
    animator.clearOverride();
    animator.play('pop');
    nextAutoAt = performance.now() + rand(18000, 30000);
  }

  function openMenu(px, py) {
    // The status panel would open behind the menu once the hover delay ran out.
    clearTimeout(hoverTimer);
    hideHud();
    menu.replaceChildren();
    const item = (label, action, checked) => {
      const button = make('button', 'item', menu);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = (checked ? '✓ ' : '') + label;
      button.addEventListener('click', () => { closeMenu(); action(); });
    };
    const divider = () => make('div', 'divider', menu);
    item(ui.talk || 'Say something', () => send({ type: 'talk' }));
    item(ui.pat || 'Pat her head', () => petted());
    item(ui.action_roam || '🐾 Stroll around', () => startRoam(Math.random() < 0.75 ? 'stroll' : 'trot', { announce: true, fromUser: true }));
    item(ui.action_play || '✨ Play a bit', () => startPlay(undefined, { announce: true, fromUser: true }));
    item(ui.action_idle || '☁️ Rest (Idle)', () => restIdle());
    divider();
    item(ui.language_en || 'English', () => patch({ language: 'en' }), settings.language === 'en');
    item(ui.language_zhs || '简体中文', () => patch({ language: 'zhs' }), settings.language === 'zhs');
    item(ui.language_auto || 'Follow app language', () => patch({ language: 'auto' }), settings.language === 'auto');
    divider();
    for (const [key, label] of [['s', ui.size_s || 'Small'], ['m', ui.size_m || 'Medium'], ['l', ui.size_l || 'Large']]) item(label, () => patch({ size: key }), settings.size === key);
    divider();
    item(ui.mute || 'Mute comments', () => patch({ muted: !settings.muted }), settings.muted);
    item(ui.ai || 'AI comments', () => patch({ ai: { enabled: !settings.ai?.enabled } }), settings.ai?.enabled);
    item(ui.roam_enabled || 'Allow roaming', () => patch({ roamEnabled: !settings.roamEnabled }), settings.roamEnabled !== false);
    item(ui.work_status_enabled || 'Work status linkage', () => patch({ workStatusEnabled: !settings.workStatusEnabled }), settings.workStatusEnabled !== false);
    item(ui.notify_enabled || 'System notifications', () => patch({ notifications: { enabled: !(settings.notifications?.enabled !== false) } }), settings.notifications?.enabled !== false);
    item(ui.settings || 'Settings…', () => openPanel());
    item((updateState.phase === 'available' ? ui.update_available_menu : ui.update_menu) || '🐾 Check for updates…', () => { openPanel(); if (updateState.phase === 'idle' || updateState.phase === 'cooling') send({ type: 'update_check', manual: true }); });
    item(ui.hide || 'Hide for 1 hour', () => patch({ hiddenUntil: Date.now() + 3600000 }));
    menu.classList.add('show');
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.transform = `translate3d(${clamp(px, 6, viewW() - width - 6)}px, ${clamp(py, 6, viewH() - height - 6)}px, 0)`;
    syncWorkPill();
    syncDesktopHit();
  }
  function closeMenu() { menu.classList.remove('show'); syncWorkPill(); syncDesktopHit(); }
  // A closed shadow root hides its insides from the window, so clicks are told apart in two places:
  // the window only sees clicks elsewhere in the app, and the root sees which of her parts was hit.
  listen(window, 'pointerdown', event => { if (!event.composedPath().includes(host)) { closeMenu(); closePanel(); } }, { capture: true });
  listen(root, 'pointerdown', event => {
    const path = event.composedPath();
    if (!path.includes(menu)) closeMenu();
    if (!path.includes(panel) && !path.includes(menu)) closePanel();
  }, { capture: true });

  // Settings live on the pet: the app offers plugins no way to open a pane on demand.
  let modelChoices = [], usage = null;
  function renderUpdate() {
    if (!updateCard) return;
    updateCard.replaceChildren();
    const title = make('div', 'update-title', updateCard);
    make('span', 'update-paw', title).textContent = '🐾';
    make('b', '', title).textContent = ui.update_title;
    const version = [updateState.currentVersion && `v${updateState.currentVersion}`, updateState.currentSha?.slice(0, 7)].filter(Boolean).join(' · ');
    if (version) make('span', 'update-version', title).textContent = version;
    const status = make('div', 'panel-note update-status', updateCard);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = ui[`update_status_${updateState.phase}`] || ui.update_status_idle;
    if (['available', 'manual', 'cooling'].includes(updateState.phase) && updateState.latestSha) status.textContent += ` (${updateState.latestSha.slice(0, 7)})`;
    if (['available', 'cooling'].includes(updateState.phase)) {
      if (updateState.summary) {
        const meta = make('div', 'update-meta', updateCard);
        const countPrefix = updateState.commitCount > 1 ? `[+${updateState.commitCount}] ` : '';
        meta.textContent = `${countPrefix}${updateState.summary}`;
      }
      if (updateState.totalFiles > 0 || updateState.sensitiveFiles?.length) {
        const risk = make('div', 'update-risk', updateCard);
        const high = updateState.riskLevel === 'high' && updateState.sensitiveFiles?.length;
        risk.dataset.level = high ? 'high' : 'low';
        if (high) {
          const preview = updateState.sensitiveFiles.slice(0, 3).join(', ') + (updateState.sensitiveFiles.length > 3 ? '…' : '');
          risk.textContent = (ui.update_risk_high || 'Sensitive files changed ({files}).').replace('{files}', preview);
        } else {
          risk.textContent = (ui.update_risk_low || '{count} file(s) changed.').replace('{count}', String(updateState.totalFiles || 0));
        }
      }
      if (updateState.inCooldown && updateState.phase === 'available') {
        make('div', 'panel-note update-reason', updateCard).textContent = (ui.update_cooldown_note || 'Published within cooldown ({hours}h remaining).').replace('{hours}', String(updateState.cooldownRemainingHours || 1));
      }
      if (updateState.compareUrl) {
        const links = make('div', 'update-links', updateCard);
        const diffLink = make('a', 'panel-link', links);
        diffLink.href = updateState.compareUrl;
        diffLink.target = '_blank';
        diffLink.rel = 'noopener noreferrer';
        diffLink.textContent = ui.update_diff_link || 'View diff on GitHub';
        const sig = make('span', 'panel-note', links);
        sig.textContent = updateState.verified ? (ui.update_signed || 'Verified signature') : (ui.update_unsigned || 'Unsigned commit');
      }
    }
    if (updateState.reason) make('div', 'panel-note update-reason', updateCard).textContent = ui[`update_reason_${updateState.reason}`] || '';
    const button = make('button', 'update-button', updateCard);
    button.type = 'button';
    const install = updateState.phase === 'available' && updateState.canInstall;
    button.textContent = install ? ui.update_install : updateState.phase === 'checking' ? ui.update_checking : updateState.phase === 'installing' ? ui.update_installing : updateState.phase === 'installed' ? ui.update_installed : ui.update_check;
    button.disabled = ['checking', 'installing', 'installed'].includes(updateState.phase);
    button.addEventListener('click', () => send(install ? { type: 'update_install' } : { type: 'update_check', manual: true }));
    if (updateState.canRollback && updateState.rollbackSha && !['checking', 'installing', 'installed'].includes(updateState.phase)) {
      const rb = make('button', 'update-rollback', updateCard);
      rb.type = 'button';
      rb.textContent = (ui.update_rollback || '↩️ Roll back to {sha}').replace('{sha}', updateState.rollbackSha.slice(0, 7));
      rb.addEventListener('click', () => send({ type: 'update_rollback' }));
    }
  }
  function openPanel() {
    panel.replaceChildren();
    const s = settings, ai = settings.ai || {};
    const head = make('div', 'panel-head', panel);
    make('b', '', head).textContent = ui.settings_title || 'Hagemi settings';
    const close = make('button', 'panel-close', head);
    close.type = 'button';
    close.setAttribute('aria-label', ui.close || 'Close');
    close.textContent = '×';
    close.addEventListener('click', closePanel);
    updateCard = make('div', 'update-card', panel);
    renderUpdate();
    make('div', 'panel-note', panel).textContent = options.desktop
      ? (ui.mode_badge_desktop || 'Current mode: Desktop overlay')
      : (ui.mode_badge_cdp || 'Current mode: App window (CDP)');
    const section = title => { make('div', 'panel-section', panel).textContent = title; };
    const field = (label, control) => {
      const row = make('label', 'field', panel);
      make('span', '', row).textContent = label;
      row.appendChild(control);
    };
    const select = (value, options, onChange) => {
      const control = document.createElement('select');
      for (const [key, text] of options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        control.appendChild(option);
      }
      control.value = value;
      control.addEventListener('change', () => { onChange(control.value); syncDesktopHit(); });
      control.addEventListener('focus', () => syncDesktopHit());
      control.addEventListener('blur', () => syncDesktopHit());
      return control;
    };
    const check = (value, onChange) => {
      const control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = !!value;
      control.addEventListener('change', () => onChange(control.checked));
      return control;
    };
    const number = (value, min, max, onChange) => {
      const control = document.createElement('input');
      control.type = 'number';
      control.min = min;
      control.max = max;
      control.value = value;
      control.addEventListener('change', () => onChange(Number(control.value)));
      return control;
    };
    section(ui.section_pet || 'Pet');
    field(ui.language || 'Language', select(s.language, [['auto', ui.language_auto], ['en', ui.language_en], ['zhs', ui.language_zhs]], value => patch({ language: value })));
    field(ui.size || 'Size', select(s.size, [['xs', ui.size_xs], ['s', ui.size_s], ['m', ui.size_m], ['l', ui.size_l], ['xl', ui.size_xl]], value => patch({ size: value })));
    field(ui.animation || 'Animation', select(s.animation, [['smooth', ui.animation_smooth], ['balanced', ui.animation_balanced], ['saver', ui.animation_saver]], value => patch({ animation: value })));
    field(ui.renderMode || 'Display mode', select(s.renderMode || 'auto', [['auto', ui.renderMode_auto || 'Auto'], ['desktop', ui.renderMode_desktop || 'Desktop overlay only'], ['cdp', ui.renderMode_cdp || 'App window only (CDP)']], value => patch({ renderMode: value })));
    if ((s.renderMode || 'auto') === 'cdp') {
      make('div', 'panel-note', panel).textContent = ui.renderMode_cdp_hint || 'Tip: if Antigravity disables CDP later, switch back to Auto.';
    }
    field(ui.chattiness || 'Chattiness', select(s.chattiness, [['quiet', ui.chattiness_quiet], ['normal', ui.chattiness_normal], ['chatty', ui.chattiness_chatty]], value => patch({ chattiness: value })));
    field(ui.followCursor || 'Watch the cursor', check(s.followCursor, value => patch({ followCursor: value })));
    field(ui.roam_enabled || 'Allow roaming', check(s.roamEnabled !== false, value => patch({ roamEnabled: value })));
    field(ui.work_status_enabled || 'Work status linkage', check(s.workStatusEnabled !== false, value => patch({ workStatusEnabled: value })));
    field(ui.autoCheckUpdates, check(s.autoCheckUpdates, value => patch({ autoCheckUpdates: value })));
    field(ui.updateCooldownHours || 'Auto-update cooldown (hours)', number(s.updateCooldownHours ?? 24, 0, 168, value => patch({ updateCooldownHours: value })));
    field(ui.quotaHoverDelayMs || 'Quota hover delay (ms, 0 = instant)', number(s.quotaHoverDelayMs, 0, 10000, value => patch({ quotaHoverDelayMs: value })));
    field(ui.mute || 'Mute comments', check(s.muted, value => patch({ muted: value })));
    section(ui.section_desktop || 'Desktop overlay');
    if (!options.desktop) {
      make('div', 'panel-note', panel).textContent = ui.desktop_only_hint || 'Applies when running in Desktop overlay mode.';
    }
    const displayChoices = [
      ['primary', ui.desktopDisplay_primary || 'Primary monitor'],
      ['cursor', ui.desktopDisplay_cursor || 'Follow cursor monitor'],
      ...desktopDisplays.map(d => [
        d.id,
        (ui.desktopDisplay_item || 'Monitor {index} ({size})').replace('{index}', String(d.index)).replace('{size}', `${d.width}x${d.height}`),
      ]),
    ];
    field(ui.desktopDisplay || 'Monitor (desktop overlay)', select(s.desktopDisplay || 'primary', displayChoices, value => patch({ desktopDisplay: value })));
    field(ui.alwaysOnTopLevel || 'Always-on-top level', select(s.alwaysOnTopLevel || 'screen-saver', [
      ['screen-saver', ui.level_screen_saver || 'Topmost (recommended on Windows)'],
      ['floating', ui.level_floating || 'Floating'],
      ['normal', ui.level_normal || 'Normal'],
    ], value => patch({ alwaysOnTopLevel: value })));
    field(ui.hideWhenHostMinimized || 'Auto-hide when Antigravity is minimized', check(s.hideWhenHostMinimized !== false, value => patch({ hideWhenHostMinimized: value })));
    const notif = s.notifications || {};
    section(ui.section_notifications || 'System notifications');
    field(ui.notify_enabled || 'Enable system notifications', check(notif.enabled !== false, value => patch({ notifications: { enabled: value } })));
    field(ui.notify_on_done || 'Notify on task done or error', check(notif.onDone !== false, value => patch({ notifications: { onDone: value } })));
    field(ui.notify_on_waiting || 'Notify when waiting for input', check(notif.onWaiting !== false, value => patch({ notifications: { onWaiting: value } })));
    field(ui.notify_when_focused || 'Notify even while focused', check(notif.whenFocused !== false, value => patch({ notifications: { whenFocused: value } })));
    const testNotifBtn = document.createElement('button');
    testNotifBtn.type = 'button';
    testNotifBtn.className = 'panel-action';
    testNotifBtn.textContent = ui.notify_test || '🔔 Send test notification';
    testNotifBtn.addEventListener('click', () => send({ type: 'notify_test' }));
    panel.appendChild(testNotifBtn);
    section(ui.section_ai || 'AI comments');
    field(ui.ai_enabled || 'Use AI', check(ai.enabled, value => patch({ ai: { enabled: value } })));
    const choices = [...new Set([ai.model, ...modelChoices])].filter(Boolean).map(label => [label, label]);
    field(ui.ai_model || 'Model', select(ai.model, choices, value => patch({ ai: { model: value } })));
    field(ui.ai_contextLevel || 'What she can see', select(ai.contextLevel, [['minimal', ui.context_minimal], ['titles', ui.context_titles], ['snippets', ui.context_snippets]], value => patch({ ai: { contextLevel: value } })));
    field(ui.ai_sameFamilySnippetsOnly || 'Keep excerpts within same model family', check(ai.sameFamilySnippetsOnly !== false, value => patch({ ai: { sameFamilySnippetsOnly: value } })));
    field(ui.ai_minIntervalMin || 'Minutes between', number(ai.minIntervalMin, 1, 1440, value => patch({ ai: { minIntervalMin: value } })));
    field(ui.ai_maxPerHour || 'Max per hour', number(ai.maxPerHour, 0, 60, value => patch({ ai: { maxPerHour: value } })));
    field(ui.ai_maxPerDay || 'Max per day', number(ai.maxPerDay, 0, 500, value => patch({ ai: { maxPerDay: value } })));
    field(ui.ai_dailyTokenBudget || 'Daily token budget', number(ai.dailyTokenBudget, 0, 500000, value => patch({ ai: { dailyTokenBudget: value } })));
    field(ui.ai_pauseBelowQuota || 'Stop below quota %', number(Math.round((ai.pauseBelowQuota ?? 0.1) * 100), 0, 100, value => patch({ ai: { pauseBelowQuota: value / 100 } })));
    field(ui.ai_onlyWhenFocused || 'Only when focused', check(ai.onlyWhenFocused, value => patch({ ai: { onlyWhenFocused: value } })));
    const persona = document.createElement('textarea');
    persona.rows = 2;
    persona.maxLength = 600;
    persona.value = ai.personaExtra || '';
    persona.addEventListener('change', () => patch({ ai: { personaExtra: persona.value } }));
    field(ui.ai_personaExtra || 'Extra persona notes', persona);
    if (usage) {
      section(ui.section_usage || 'Usage today');
      make('div', 'panel-note', panel).textContent = (ui.usage || '{calls} AI comments, about {tokens} tokens').replace('{calls}', usage.calls).replace('{tokens}', usage.tokens);
    }
    section(ui.section_licenses || 'Credits and licenses');
    for (const key of ['license_code', 'license_art', 'license_inspired', 'license_fan']) make('div', 'panel-note', panel).textContent = ui[key] || '';
    const links = make('div', 'panel-note', panel);
    for (const [key, href] of [['license_link_crosspet', 'https://github.com/lokicorvus/crosspet'], ['license_link_art', 'https://creativecommons.org/licenses/by-nc-sa/4.0/']]) {
      const link = make('a', 'panel-link', links);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = ui[key] || href;
    }
    panel.classList.add('show');
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = x + spriteW * 0.5 + width + 10 < viewW() ? x + spriteW * 0.5 : Math.max(8, x - spriteW * 0.5 - width);
    panel.style.transform = `translate3d(${clamp(left, 8, viewW() - width - 8)}px, ${clamp(y - height / 2, 8, Math.max(8, viewH() - height - 8))}px, 0)`;
    send({ type: 'panelOpened' });
    syncWorkPill();
    syncDesktopHit();
  }
  function closePanel() { panel.classList.remove('show'); syncWorkPill(); syncDesktopHit(lastOverPet, lastOverBubble, false); }
  // Typing in the form must not reach the app's keyboard shortcuts or composer.
  for (const type of ['keydown', 'keyup', 'keypress']) listen(panel, type, event => { event.stopPropagation(); if (event.key === 'Escape') closePanel(); });

  function patch(change) {
    settings = {
      ...settings,
      ...change,
      notifications: { ...settings.notifications, ...change.notifications },
      ai: { ...settings.ai, ...change.ai },
    };
    if (change.roamEnabled === false) stopRoam(false);
    applyVisibility();
    applySize();
    syncWorkPill();
    send({ type: 'settings', patch: change });
  }
  let lastCursorTrackKey = '';
  function syncCursorTracking(hidden) {
    if (!options.desktop) return;
    const followCursor = settings.followCursor !== false;
    const key = `${followCursor ? 1 : 0}:${hidden ? 1 : 0}`;
    if (key === lastCursorTrackKey) return;
    lastCursorTrackKey = key;
    window.__hagemiDesktop?.setCursorTracking?.({ followCursor, hidden: !!hidden });
  }
  function syncDesktopWindowPrefs() {
    if (!options.desktop) return;
    window.__hagemiDesktop?.setWindowPrefs?.({
      display: settings.desktopDisplay || 'primary',
      level: settings.alwaysOnTopLevel || 'screen-saver',
    });
  }
  function refreshDisplays() {
    if (!options.desktop || !window.__hagemiDesktop?.listDisplays) return;
    window.__hagemiDesktop.listDisplays().then(list => {
      if (Array.isArray(list)) desktopDisplays = list;
    }).catch(() => {});
  }
  refreshDisplays();
  function applyVisibility() {
    syncDesktopWindowPrefs();
    const hidden = settings.hidden || (settings.hiddenUntil && Date.now() < settings.hiddenUntil);
    stage.style.display = hidden ? 'none' : 'block';
    syncCursorTracking(hidden);
    if (hidden) { stopRoam(false); closeBubble(); hideHud(); closeMenu(); closePanel(); syncWorkPill(); syncDesktopHit(false, false, false, false); }
    else { syncWorkPill(); syncDesktopHit(); }
  }

  // ---- Touch: pokes, pats, shakes, a short temper -----------------------------------------
  let annoyance = 0, rub = 0, lastRub = { x: 0, y: 0, at: 0 }, pettedUntil = 0, sulking = false;
  const inHead = py => py < y - spriteH * 0.06;
  function petted() {
    stopRoam(false);
    const now = performance.now();
    if (sulking) {
      sulking = false;
      annoyance = 0;
      animator.clearOverride('sulk');
      animator.override('coaxed', 1700, () => animator.override('forgiven', 2200));
      send({ type: 'touch', kind: 'coax' });
      return;
    }
    if (now > pettedUntil) send({ type: 'touch', kind: 'pet' });
    pettedUntil = now + 2400;
    animator.override('petted', 2400);
    if (Math.random() < 0.5) fx.burst('hearts', STAGE.cx, 400, 3);
    annoyance = Math.max(0, annoyance - 1.5);
  }
  function poked(head) {
    stopRoam(false);
    if (head) { petted(); return; }
    if (sulking) { animator.play('recoil'); return; }
    annoyance += 1;
    if (annoyance >= 7) {
      sulking = true;
      animator.override('sulk', 14000, () => { sulking = false; annoyance = 0; });
      send({ type: 'touch', kind: 'sulk' });
    } else if (annoyance >= 5.5) {
      animator.override('redhot', 2400);
      fx.burst('steam', STAGE.cx, 400);
      send({ type: 'touch', kind: 'redhot' });
    } else if (annoyance >= 4) {
      animator.override('puffed', 2600);
      animator.play('squish');
      send({ type: 'touch', kind: 'puffed' });
    } else if (annoyance >= 2.5) {
      animator.override('annoyed', 2200);
      animator.play('shake');
      send({ type: 'touch', kind: 'annoyed' });
    } else {
      animator.override('surprised', 1100);
      animator.play('gasp');
      send({ type: 'touch', kind: 'poke' });
    }
  }

  // Click-through: the hit box only catches the pointer over painted pixels.
  function updateHitTest(event) {
    if (dragging) return;
    const hidden = stage.style.display === 'none';
    const originX = x - (STAGE.w / 2) * scale, originY = y - (STAGE.h / 2) * scale;
    const artX = (event.clientX - originX) / scale, artY = (event.clientY - originY) / scale;
    const over = !hidden && rig.opaqueAt(current, artX, artY, docked ? 1 : facing);
    const value = over ? 'auto' : 'none';
    if (hit.style.pointerEvents !== value) hit.style.pointerEvents = value;
    const overBubble = pointInVisible(bubble, event.clientX, event.clientY);
    const overPanel = pointInVisible(panel, event.clientX, event.clientY);
    const overWork = pointInVisible(workPill, event.clientX, event.clientY);
    syncDesktopHit(over, overBubble, overPanel, overWork);
  }

  let lastClickAt = 0, shakeFlips = 0, shakeSign = 0, shakeClock = 0;
  listen(hit, 'pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopRoam(false);
    hit.setPointerCapture(event.pointerId);
    clearTimeout(hoverTimer);
    dragging = { id: event.pointerId, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - x, offsetY: event.clientY - y, moved: false, at: performance.now(), px: event.clientX, py: event.clientY };
    syncWorkPill();
    syncDesktopHit(true);
    closeBubble();
    hideHud();
  });
  listen(hit, 'pointermove', event => {
    if (!dragging || event.pointerId !== dragging.id) return;
    if (!dragging.moved && Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) > 4) {
      dragging.moved = true;
      if (docked) {
        // Pulled out of the wall: she pops back to full size under the cursor.
        dragging.offsetX = 0;
        dragging.offsetY = 0;
        docked = null;
      }
      animator.override('dragged', 1e9);
      send({ type: 'touch', kind: 'grab' });
    }
    dragging.px = event.clientX;
    dragging.py = event.clientY;
  });
  const endDrag = event => {
    if (!dragging || (event.pointerId !== undefined && event.pointerId !== dragging.id)) return;
    const now = performance.now(), wasDrag = dragging.moved, heldAt = dragging.at, startY = dragging.startY;
    dragging = null;
    syncWorkPill();
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) updateHitTest(event);
    else syncDesktopHit();
    if (wasDrag) {
      animator.clearOverride('dragged');
      if (shakeFlips >= 4) {
        animator.override('dizzy', 3200);
        send({ type: 'touch', kind: 'shaken' });
      } else if (x < spriteW * 0.2 || x > viewW() - spriteW * 0.2) {
        docked = x < spriteW * 0.2 ? 'left' : 'right';
        vx = vy = 0;
        keepInBounds();
        savePosition();
      } else if (Math.hypot(vx, vy) > 1100) {
        animator.override('surprised', 700);
      }
      shakeFlips = 0;
    } else if (now - heldAt < 400) {
      const isDouble = now - lastClickAt < 320;
      lastClickAt = now;
      if (isDouble) {
        animator.override('gift', 1200);
        send({ type: 'talk' });
      } else {
        poked(inHead(startY));
      }
    }
  };
  listen(hit, 'pointerup', endDrag);
  listen(hit, 'pointercancel', endDrag);
  listen(hit, 'contextmenu', event => { event.preventDefault(); openMenu(event.clientX, event.clientY); });
  listen(hit, 'pointerenter', () => {
    clearTimeout(hoverTimer);
    if (settings.quotaHoverDelayMs === 0) showHud();
    else hoverTimer = setTimeout(showHud, settings.quotaHoverDelayMs);
  });
  listen(hit, 'pointerleave', () => { clearTimeout(hoverTimer); hideHud(); });
  listen(hit, 'pointermove', event => {
    // A slow back-and-forth over her head is a pat.
    if (dragging || !inHead(event.clientY)) return;
    const now = performance.now();
    if (now - lastRub.at > 420) { rub = 0; lastRub = { x: event.clientX, y: event.clientY, at: now }; }
    rub += Math.hypot(event.clientX - lastRub.x, event.clientY - lastRub.y);
    lastRub = { x: event.clientX, y: event.clientY, at: now };
    if (rub > 260) { rub = 120; petted(); }
  });

  let pointerX = 0, pointerY = 0;
  let gazeX = 0, gazeY = 0, gazeGoalX = 0, gazeGoalY = 0;
  listen(window, 'pointermove', event => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    lastPointerAt = performance.now();
    updateHitTest(event);
  }, { passive: true, capture: true });
  // Only the time of the keystroke is ever used; the key itself is never read.
  listen(window, 'keydown', () => { lastKeyAt = performance.now(); }, { passive: true, capture: true });
  listen(window, 'resize', () => { applySize(); settle(); refreshDisplays(); }, { passive: true });

  if (options.desktop) {
    listen(document, 'pointerleave', () => { if (!dragging) syncDesktopHit(false, false, false, false); });
    listen(window, 'blur', () => { closeMenu(); syncDesktopHit(false, false, false, false); });
    window.__hagemiDesktop?.onCursorMove?.(pos => {
      if (!running || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
      pointerX = pos.x;
      pointerY = pos.y;
      lastPointerAt = performance.now();
      if (!dragging) updateHitTest({ clientX: pos.x, clientY: pos.y });
    });
  }

  // Tell the sidecar when nobody is looking, so she does not spend tokens on an empty room.
  const pollDesktopIdle = async () => {
    if (!options.desktop) return;
    try {
      if (window.__hagemiDesktop?.getIdleState) {
        const info = await window.__hagemiDesktop.getIdleState();
        if (Number.isFinite(info?.idleSec) && info.idleSec >= 0) desktopIdleSec = info.idleSec;
        desktopLocked = !!info?.locked;
        return;
      }
      if (window.__hagemiDesktop?.getIdleSec) {
        const sec = await window.__hagemiDesktop.getIdleSec();
        if (Number.isFinite(sec) && sec >= 0) desktopIdleSec = sec;
      }
    } catch { /* Ignore IPC failure. */ }
  };
  const presence = () => {
    const localIdleMs = Math.round(performance.now() - Math.max(lastPointerAt, lastKeyAt));
    const idleMs = options.desktop ? Math.min(localIdleMs, Math.round(desktopIdleSec * 1000)) : localIdleMs;
    const focused = options.desktop ? (!document.hidden && !desktopLocked && !hostMinimized && desktopIdleSec < 300) : document.hasFocus();
    send({ type: 'presence', desktop: Boolean(options.desktop), visible: !document.hidden && !desktopLocked && !hostMinimized, focused, locked: desktopLocked, idleMs, language: navigator.language });
  };
  listen(document, 'visibilitychange', presence);
  listen(window, 'focus', presence);
  listen(window, 'blur', presence);
  const presenceTimer = setInterval(() => {
    if (options.desktop) pollDesktopIdle().then(presence);
    else presence();
  }, 15000);
  if (options.desktop) pollDesktopIdle();

  // ---- Frame loop -----------------------------------------------------------------------
  let lastFrame = performance.now(), t = rand(0, 100), raf = 0;
  let saveTimer = 0, savedAt = { x: -1, y: -1 }, lastMessageAt = performance.now();

  function savePosition() {
    savedAt = { x, y };
    anchor = { x: x / viewW(), y: y / viewH() };
    settings.position = docked ? { ...anchor, dock: docked } : anchor;
    send({ type: 'settings', patch: { position: settings.position } });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!host.isConnected) { dispose(); return; }
    if (document.hidden || stage.style.display === 'none' || desktopLocked || hostMinimized) { lastFrame = now; return; }
    const gazeMoving = Math.abs(gazeX - gazeGoalX) > 0.015 || Math.abs(gazeY - gazeGoalY) > 0.015;
    const lively = animator.busy || dragging || roam || Math.hypot(vx, vy) > 3 || speech || fade < 1 || gazeMoving;
    const baseCap = settings.animation === 'saver' ? 20 : settings.animation === 'smooth' || lively ? 0 : 30;
    const fpsCap = !lively && animator.state === 'sleeping' ? 12 : baseCap;
    if (fpsCap && now - lastFrame < 1000 / fpsCap - 2) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    t += dt;
    if (!anchor) settle();

    if (roam) {
      if (dragging || docked || sulking || stage.style.display === 'none' || (!roam.fromUser && !HAGEMI.canRoamInState(baseState))) {
        stopRoam(false);
      } else {
        roam.elapsed += dt;
        const sample = HAGEMI.sampleRoam(roam.plan, roam.elapsed);
        x = sample.x;
        y = sample.y;
        vx = sample.vx;
        vy = sample.vy;
        roam.stage = sample.stage;
        roam.stageProgress = sample.stageProgress;
        keepInBounds();
        if (sample.done) {
          stopRoam(true);
          nextAutoAt = now + (baseState === 'idle' ? rand(10000, 18000) : rand(16000, 28000));
        }
      }
    }

    if (dragging && dragging.moved) {
      const goalX = dragging.px - dragging.offsetX, goalY = dragging.py - dragging.offsetY;
      const nextX = lerp(x, goalX, 1 - Math.exp(-dt * 24)), nextY = lerp(y, goalY, 1 - Math.exp(-dt * 24));
      vx = (nextX - x) / Math.max(dt, 0.001);
      vy = (nextY - y) / Math.max(dt, 0.001);
      x = nextX;
      y = nextY;
      shakeClock += dt;
      const sign = Math.sign(vx);
      if (Math.abs(vx) > 700 && sign && sign !== shakeSign) { shakeSign = sign; shakeFlips++; shakeClock = 0; }
      if (shakeClock > 0.6) shakeFlips = 0;
    } else if (!dragging && !docked && !roam) {
      // Thrown: no gravity here, just drag and soft walls.
      x += vx * dt;
      y += vy * dt;
      const friction = Math.exp(-dt * 2.6);
      vx *= friction;
      vy *= friction;
      const minX = spriteW * 0.22, maxX = viewW() - spriteW * 0.22, minY = spriteH * 0.2, maxY = viewH() - spriteH * 0.2;
      let bumped = 0;
      if (x < minX) { bumped = Math.abs(vx); x = minX; vx = Math.abs(vx) * 0.55; }
      if (x > maxX) { bumped = Math.abs(vx); x = maxX; vx = -Math.abs(vx) * 0.55; }
      if (y < minY) { bumped = Math.max(bumped, Math.abs(vy)); y = minY; vy = Math.abs(vy) * 0.55; }
      if (y > maxY) { bumped = Math.max(bumped, Math.abs(vy)); y = maxY; vy = -Math.abs(vy) * 0.55; }
      if (bumped > 420) {
        animator.play('squish');
        if (animator.state !== 'dizzy') animator.override('oops', 800);
        fx.burst('dust', STAGE.cx, 400, 6);
      }
      if (Math.abs(vx) < 2) vx = 0;
      if (Math.abs(vy) < 2) vy = 0;
    }
    // A window dragged to a screen with another scale need not resize, so the scale is checked here.
    const ratio = window.devicePixelRatio || 1, snap = value => Math.round(value * ratio) / ratio;
    if (ratio !== screenRatio) applySize();
    // Smooth subpixel translation while actively moving to prevent frame-stepping judder; snap to whole pixels at rest.
    const tx = x - (STAGE.w / 2 + MARGIN) * scale, ty = y - (STAGE.h / 2 + MARGIN) * scale;
    stage.style.transform = roam || dragging
      ? `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`
      : `translate3d(${snap(tx)}px, ${snap(ty)}px, 0)`;

    // Persist where she was left, once she has settled.
    if (!dragging && !roam && !vx && !vy && (Math.abs(x - savedAt.x) > 1 || Math.abs(y - savedAt.y) > 1)) {
      saveTimer += dt;
      if (saveTimer > 0.6) { saveTimer = 0; savePosition(); }
    }

    // Autonomous idle, turn, roam, and play cycle; during calm background work, gently stroll while keeping the work pose.
    const autoStateReady = baseState === 'idle'
      ? ['idle', 'hum', 'float', 'stretch'].includes(animator.state)
      : (HAGEMI.isCalmWorkState(baseState) && animator.state === baseState);
    if (!roam && !dragging && !docked && !sulking && !speech
      && !menu.classList.contains('show') && !panel.classList.contains('show')
      && !reducedMotion.matches && stage.style.display !== 'none'
      && now >= nextAutoAt && !animator.busy && autoStateReady) {
      if (baseState === 'idle') {
        const kind = HAGEMI.rollActivity(Math.random(), { fixed: settings.roamEnabled === false });
        if (kind === 'turn') {
          facing = -facing;
          animator.play('pop');
          nextAutoAt = now + rand(8000, 14000);
        } else if (kind === 'roam') {
          if (!startRoam(undefined, { announce: false })) startPlay(undefined, { announce: false });
          nextAutoAt = now + rand(10000, 18000);
        } else if (kind === 'play') {
          startPlay(undefined, { announce: false });
          nextAutoAt = now + rand(12000, 20000);
        } else {
          nextAutoAt = now + rand(8000, 14000);
        }
      } else {
        if (settings.roamEnabled !== false) {
          startRoam(undefined, { announce: false });
        }
        nextAutoAt = now + rand(16000, 28000);
      }
    }

    // Docked at a window edge she watches from the wall, peeking out as the cursor nears.
    if (docked && !dragging) {
      // Only over the part of her that shows: about 290 art pixels out from the wall, 360 once she
      // leans out, so the cursor has to leave what it can see before she hides again.
      const peeking = animator.state === `dock${docked === 'left' ? 'Left' : 'Right'}Peek`;
      const reach = (peeking ? 380 : 310) * scale;
      const near = Math.abs(pointerX - x) < reach && Math.abs(pointerY - y) < spriteH * 0.5 && now - lastPointerAt < 2000;
      const dockState = `dock${docked === 'left' ? 'Left' : 'Right'}${near ? 'Peek' : ''}`;
      animator.override(dockState, 1200);
    }

    const activeFacing = docked ? 1 : facing;
    const frameData = animator.update(dt, t, {
      vx,
      vy,
      facing: activeFacing,
      roamStage: roam?.stage || null,
      stageProgress: roam?.stageProgress || 0,
      stridePx: roam?.plan?.stridePx || 0,
    });
    const { P } = frameData;
    usePose(frameData.poseName, { fast: !!frameData.fastPose });
    if (frameData.stepBeat && roam?.stage === 'travel' && (roam.plan.style === 'stroll' || roam.plan.style === 'trot')) {
      fx.burst('step', STAGE.cx - activeFacing * 28, 615, roam.plan.style === 'trot' ? 2 : 1);
    }

    // She watches the cursor when it is active, the keyboard while you type.
    const gazeFresh = settings.followCursor && now - lastPointerAt < 5000;
    const canTrackGaze = gazeFresh && !['sleeping', 'sulk', 'exhausted'].includes(frameData.activeName);
    if (canTrackGaze) {
      const rawDx = ((pointerX - x) / 240) * activeFacing;
      const rawDy = (pointerY - (y - spriteH * 0.22)) / 200;
      const tx = Math.tanh(rawDx * 1.15);
      const ty = Math.tanh(rawDy * 1.15);
      const active = frameData.activeName;
      const weight = roam && roam.stage === 'travel'
        ? 0.25
        : ['searching', 'playPeek'].includes(active)
          ? 0.55
          : ['idle', 'listening', 'hum', 'petted', 'happy', 'proud', 'dockLeft', 'dockLeftPeek', 'dockRight', 'dockRightPeek'].includes(active)
            ? 1
            : 0.78;
      gazeGoalX = tx * weight;
      gazeGoalY = ty * weight;
    } else {
      gazeGoalX = 0;
      gazeGoalY = 0;
    }
    const gazeRate = 1 - Math.exp(-dt * (canTrackGaze ? 11 : 3.5));
    gazeX = lerp(gazeX, gazeGoalX, gazeRate);
    gazeY = lerp(gazeY, gazeGoalY, gazeRate);
    if (Math.abs(gazeX) < 0.001 && gazeGoalX === 0) gazeX = 0;
    if (Math.abs(gazeY) < 0.001 && gazeGoalY === 0) gazeY = 0;
    if (gazeX || gazeY) {
      P.lookX = clamp(P.lookX + gazeX, -1.15, 1.15);
      P.lookY = clamp(P.lookY + gazeY, -1.15, 1.15);
      P.head += gazeX * 0.115 + gazeX * gazeY * 0.025;
      P.nod += gazeY * 7.5;
      P.lean = clamp(P.lean + gazeX * 0.065, -0.28, 0.28);
      P.earL += gazeY * 0.07 - gazeX * 0.03;
      P.earR += -gazeY * 0.07 - gazeX * 0.03;
      P.ahoge += gazeX * 0.08;
    }
    if (now - lastKeyAt < 1600 && frameData.activeName === 'idle') P.lookY = lerp(P.lookY, 0.85, 0.75);

    // Wall-clock, not frame count: a slow frame must not stretch the overlap into a ghost.
    if (fade < 1) {
      fade = Math.min(1, (now - fadeStart) / fadeDuration);
      if (fade >= 1) previous = null;
    }
    rig.draw(current, previous, fade, P, t, frameData.blink, pixelRatio, scale);
    fx.draw(dt, t, scale * pixelRatio, MARGIN * scale * pixelRatio, { shiftX: P.shiftX, shiftY: P.shiftY, bob: P.bob, sleeping: frameData.sleeping });

    stepSpeech(dt, now);
    if (speech) placeBubble();
    if (hud.classList.contains('show')) placeHud();
    if (workPill.classList.contains('show')) placeWorkPill();

    // Sidecar gone: say goodbye instead of haunting the window.
    if (!options.standalone && now - lastMessageAt > 90000 && !leaving) leave();
    if (leaving && now > leaving) dispose();
  }

  function leave() {
    if (leaving) return;
    leaving = performance.now() + 1250;
    stopRoam(false);
    closeBubble();
    hideHud();
    workPill.classList.remove('show');
    animator.override('bye', 1400);
    animator.play('leave');
  }

  function dispose() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    clearInterval(presenceTimer);
    clearTimeout(hoverTimer);
    abort.abort();
    rig.destroy();
    fx.clear();
    host.remove();
  }

  function mergeSettings(incoming) {
    if (!incoming) return;
    settings = {
      ...settings,
      ...incoming,
      notifications: { ...settings.notifications, ...incoming.notifications },
      ai: { ...settings.ai, ...incoming.ai },
    };
    if (settings.roamEnabled === false) stopRoam(false);
  }

  function receive(message) {
    lastMessageAt = performance.now();
    switch (message.t) {
      case 'hello':
        mergeSettings(message.settings);
        ui = message.ui || ui;
        applySize();
        placeInitial();
        applyVisibility();
        syncWorkPill();
        break;
      case 'settings':
        mergeSettings(message.settings);
        ui = message.ui || ui;
        if (panel.classList.contains('show')) { const scroll = panel.scrollTop; openPanel(); panel.scrollTop = scroll; }
        applySize();
        applyVisibility();
        syncWorkPill();
        break;
      case 'art':
        receiveArt(message.name, message.data);
        break;
      case 'update':
        updateState = message.update || updateState;
        renderUpdate();
        break;
      case 'facts':
        baseState = message.state || 'idle';
        if (roam && !roam.fromUser && !HAGEMI.canRoamInState(baseState)) stopRoam(false);
        if (!sulking) animator.setState(baseState);
        animator.setMood({ quota: message.quota || 'ok', late: !!message.late, stashLevel: message.stashLevel ?? null, stashLabel: message.stashLabel || '', subagents: message.subagents || 0 });
        hudRows = message.hud || [];
        workBadge = message.workBadge || null;
        if (hud.classList.contains('show')) { renderHud(); placeHud(); }
        syncWorkPill();
        break;
      case 'react':
        if (message.state && !sulking && !dragging && !docked) animator.override(message.state, message.ms || 2600);
        if (message.gesture) for (const name of [].concat(message.gesture)) animator.play(name);
        if (message.burst) for (const name of [].concat(message.burst)) fx.burst(name, STAGE.cx, 400);
        break;
      case 'say':
        if (settings.muted && !message.force) break;
        speechQueue.push({ text: message.text, mood: message.mood, ai: message.ai, ms: message.ms, queuedAt: performance.now() });
        if (speechQueue.length > 2) speechQueue.shift();
        break;
      case 'models':
        modelChoices = message.models || modelChoices;
        usage = message.usage || usage;
        break;
      case 'notify': {
        const n = message.notification;
        if (!n || options.desktop) break;
        const showWebNotification = () => {
          try {
            const item = new Notification(n.title || 'Hagemi Pet', { body: n.body || '' });
            item.onclick = () => {
              window.focus?.();
              send({ type: 'notification_clicked', conversationId: n.conversationId || null, title: n.conversationTitle || '' });
            };
          } catch { /* Notification blocked or unavailable. */ }
        };
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          showWebNotification();
        } else if (typeof Notification !== 'undefined' && Notification.permission === 'default' && n.kind === 'test' && typeof Notification.requestPermission === 'function') {
          Notification.requestPermission().then(perm => {
            if (perm === 'granted') showWebNotification();
            else speechQueue.push({ text: n.body || n.title || 'Notification ready', mood: 'happy', ai: false, ms: 4000, queuedAt: performance.now() });
          }).catch(() => {});
        } else if (n.kind === 'test') {
          speechQueue.push({ text: n.body || n.title || 'Notification ready', mood: 'happy', ai: false, ms: 4000, queuedAt: performance.now() });
        }
        break;
      }
      case 'host_minimized':
        hostMinimized = !!message.minimized;
        if (hostMinimized) { stopRoam(false); closeBubble(); hideHud(); closeMenu(); closePanel(); }
        presence();
        break;
      case 'heartbeat':
        applyVisibility();
        break;
      case 'bye':
        leave();
        break;
      default:
        break;
    }
  }

  document.documentElement.appendChild(host);
  hit.style.pointerEvents = 'none';
  applySize();
  placeInitial();
  usePose('idle');
  preloadClones();
  preloadWalkPoses();
  raf = requestAnimationFrame(frame);
  presence();
  send({ type: 'ready' });
  return {
    receive,
    dispose,
    animator,
    get position() { return { x, y }; },
    get pose() { return current?.name || null; },
    get hasWalkLegs() { return Boolean(current?.legs?.left && current?.legs?.right); },
  };
};
