import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readArt } from '../sidecars/pet/lib/renderer-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'sidecars', 'pet', 'art');

function loadRendererModules(files, now = () => 0) {
  const context = { HAGEMI: { STAGE: { w: 700, h: 640, cx: 350 } }, performance: { now }, Math };
  vm.createContext(context);
  for (const file of files) {
    vm.runInContext(readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', file), 'utf8'), context);
  }
  return context.HAGEMI;
}

test('rollActivity distributes weights and folds turn/roam into play when fixed', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  assert.equal(HAGEMI.rollActivity(0.1), 'idle');
  assert.equal(HAGEMI.rollActivity(0.25), 'turn');
  assert.equal(HAGEMI.rollActivity(0.5), 'roam');
  assert.equal(HAGEMI.rollActivity(0.9), 'play');

  for (const roll of [0.25, 0.5, 0.9]) {
    assert.equal(HAGEMI.rollActivity(roll, { fixed: true }), 'play');
  }
  assert.equal(HAGEMI.rollActivity(0.1, { fixed: true }), 'idle');
});

test('calm work states permit gentle roaming while urgent or tired states stay put', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  assert.equal(HAGEMI.isCalmWorkState('idle'), false);
  assert.equal(HAGEMI.canRoamInState('idle'), true);
  for (const workState of ['thinking', 'deepthink', 'reading', 'writing', 'running', 'searching', 'drawing', 'delegating', 'busy']) {
    assert.equal(HAGEMI.isCalmWorkState(workState), true, `expected calm work state: ${workState}`);
    assert.equal(HAGEMI.canRoamInState(workState), true, `expected roam allowed in: ${workState}`);
  }
  for (const blockedState of ['asking', 'sleeping', 'exhausted', 'sulk', 'swamped', 'tired', 'compacting']) {
    assert.equal(HAGEMI.isCalmWorkState(blockedState), false, `unexpected calm work state: ${blockedState}`);
    assert.equal(HAGEMI.canRoamInState(blockedState), false, `expected roam blocked in: ${blockedState}`);
  }
});

test('pet.js checks reducedMotion.matches rather than bare MediaQueryList truthiness', () => {
  const petSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  assert.equal(/!reducedMotion\b(?!\.matches)/.test(petSrc), false);
  assert.match(petSrc, /!reducedMotion\.matches/);
});

test('planRoam respects viewport bounds, turns around at edges, and skips narrow screens', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  const turnLeft = HAGEMI.planRoam({
    x: 1180, y: 500, viewW: 1200, viewH: 800, spriteW: 180, spriteH: 225,
    facing: 1, styleName: 'stroll', random: () => 0.5,
  });
  assert.ok(turnLeft);
  assert.equal(turnLeft.dir, -1);
  assert.ok(turnLeft.targetX < turnLeft.startX);

  const floatPlan = HAGEMI.planRoam({
    x: 500, y: 400, viewW: 1200, viewH: 800, spriteW: 180, spriteH: 225,
    facing: 1, styleName: 'float', random: () => 0.9,
  });
  assert.ok(floatPlan);
  assert.equal(floatPlan.state, 'roamFloat');
  assert.notEqual(floatPlan.targetY, floatPlan.startY);

  const tooNarrow = HAGEMI.planRoam({
    x: 50, y: 200, viewW: 100, viewH: 400, spriteW: 180, spriteH: 225,
  });
  assert.equal(tooNarrow, null);
});

test('sampleRoam honors lead, smooth travel, and tail settling', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  const plan = HAGEMI.planRoam({
    x: 300, y: 400, viewW: 1200, viewH: 800, spriteW: 180, spriteH: 225,
    facing: 1, styleName: 'trot', random: () => 0.5,
  });
  assert.ok(plan);

  const atLead = HAGEMI.sampleRoam(plan, plan.leadSec * 0.5);
  assert.equal(atLead.x, plan.startX);
  assert.equal(atLead.vx, 0);
  assert.equal(atLead.stage, 'lead');
  assert.ok(atLead.stageProgress > 0 && atLead.stageProgress < 1);
  assert.equal(atLead.travelProgress, 0);
  assert.equal(atLead.done, false);

  const mid = HAGEMI.sampleRoam(plan, plan.leadSec + plan.travelSec * 0.5);
  assert.ok(mid.x > plan.startX && mid.x < plan.targetX);
  assert.ok(mid.vx > 0);
  assert.equal(mid.stage, 'travel');
  assert.ok(Math.abs(mid.travelProgress - 0.5) < 1e-6);
  assert.equal(mid.done, false);

  const atTail = HAGEMI.sampleRoam(plan, plan.leadSec + plan.travelSec + plan.tailSec * 0.5);
  assert.equal(atTail.x, plan.targetX);
  assert.equal(atTail.vx, 0);
  assert.equal(atTail.stage, 'tail');
  assert.equal(atTail.travelProgress, 1);
  assert.equal(atTail.done, false);

  const settled = HAGEMI.sampleRoam(plan, plan.totalSec);
  assert.equal(settled.x, plan.targetX);
  assert.equal(settled.vx, 0);
  assert.equal(settled.stage, 'tail');
  assert.equal(settled.stageProgress, 1);
  assert.equal(settled.done, true);
});

test('WALK_POSES exist as art, limbs, and rig entries and planRoam scales strides by sprite width', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  const rig = JSON.parse(readFileSync(join(ART, 'rig.json'), 'utf8'));
  assert.deepEqual([...HAGEMI.WALK_POSES], ['walk_1']);
  for (const name of HAGEMI.WALK_POSES) {
    assert.ok(existsSync(join(ART, `${name}.webp`)), `missing ${name}.webp`);
    const wl = rig[name]?.walkLegs;
    assert.ok(wl, `missing walkLegs entry for ${name}`);
    assert.ok(wl.hipL[0] > wl.hipR[0], `${name}: 3/4-right far hipL.x (${wl.hipL[0]}) must sit right of near hipR.x (${wl.hipR[0]})`);
    assert.ok(Math.abs(wl.restL) < 0.18 && Math.abs(wl.restR) < 0.18, `${name}: neutral rest angles expected, got (${wl.restL}, ${wl.restR})`);
    assert.ok(wl.kneeL[0] >= wl.rectL[0] && wl.kneeL[0] <= wl.rectL[0] + wl.rectL[2], `${name}: kneeL out of rectL bounds`);
    assert.ok(wl.kneeR[0] >= wl.rectR[0] && wl.kneeR[0] <= wl.rectR[0] + wl.rectR[2], `${name}: kneeR out of rectR bounds`);
    // Ensure both opposite half-strides keep clear foot separation without collapsing.
    for (const sinPhase of [1, -1]) {
      const targetL = 0.03 - sinPhase * 0.38;
      const targetR = 0.03 + sinPhase * 0.38;
      const footLX = wl.hipL[0] + 96 * Math.sin(targetL) - sinPhase * 5.5;
      const footRX = wl.hipR[0] + 96 * Math.sin(targetR) + sinPhase * 5.5;
      assert.ok(Math.abs(footRX - footLX) >= 60, `${name}: half-step (sin=${sinPhase}) collapsed (${footLX.toFixed(1)} vs ${footRX.toFixed(1)})`);
    }
    for (const part of ['leg_l', 'leg_r', 'leg_cut']) {
      const key = `limbs/${name}_${part}`;
      assert.ok(existsSync(join(ART, `${key}.webp`)), `missing ${key}.webp`);
      assert.ok(readArt(key), `readArt failed for ${key}`);
    }
  }
  assert.equal(readArt('other/idle'), null);

  const smallPlan = HAGEMI.planRoam({
    x: 200, y: 400, viewW: 2000, viewH: 1000, spriteW: 135, spriteH: 175,
    facing: 1, styleName: 'stroll', random: () => 0.5,
  });
  const largePlan = HAGEMI.planRoam({
    x: 200, y: 400, viewW: 2000, viewH: 1000, spriteW: 295, spriteH: 380,
    facing: 1, styleName: 'stroll', random: () => 0.5,
  });
  assert.ok(smallPlan && largePlan);
  assert.ok(smallPlan.stridePx > 0);
  assert.ok(largePlan.stridePx > smallPlan.stridePx);
  assert.ok(largePlan.targetX - largePlan.startX > smallPlan.targetX - smallPlan.startX);
});

test('behavior.js holds walk_1 smoothly during roamStroll/roamTrot with step beats and clean tail settling', () => {
  for (const walkState of ['roamStroll', 'roamTrot']) {
    let clock = 0;
    const HAGEMI = loadRendererModules(['util.js', 'behavior.js'], () => clock);
    const animator = HAGEMI.createAnimator({ burst() {}, setStash() {}, setClones() {} });
    animator.override(walkState, 5000);

    const leadFrame = animator.update(0.05, 0.05, {
      vx: 0, vy: 0, facing: 1, roamStage: 'lead', stageProgress: 0.5, stridePx: 120,
    });
    assert.equal(leadFrame.poseName, 'walk_1');

    const seenPoses = new Set();
    let stepBeats = 0;
    let maxWeight = 0;
    let maxAmp = 0;
    let prevPhase = 0;
    for (let i = 0; i < 65; i++) {
      clock += 16;
      const frame = animator.update(0.016, (i + 1) * 0.016, {
        vx: 160, vy: 0, facing: 1, roamStage: 'travel', stageProgress: i / 65, stridePx: 120,
      });
      seenPoses.add(frame.poseName);
      if (frame.stepBeat) stepBeats++;
      assert.ok(frame.P.walkPhase >= 0 && frame.P.walkPhase < 1);
      prevPhase = frame.P.walkPhase;
      maxWeight = Math.max(maxWeight, frame.P.walkWeight);
      maxAmp = Math.max(maxAmp, frame.P.walkAmp);
    }
    assert.ok(prevPhase >= 0 && prevPhase < 1);
    assert.deepEqual([...seenPoses], ['walk_1']);
    assert.ok(stepBeats >= 2, `${walkState} fired too few step beats (${stepBeats})`);
    assert.ok(maxWeight > 0.7, `${walkState} walkWeight too low (${maxWeight})`);
    assert.ok(maxAmp > 0.35, `${walkState} walkAmp too low (${maxAmp})`);

    const earlyTail = animator.update(0.05, 1.5, {
      vx: 0, vy: 0, facing: 1, roamStage: 'tail', stageProgress: 0.25, stridePx: 120,
    });
    assert.equal(earlyTail.poseName, 'walk_1');

    const lateTail = animator.update(0.05, 2.0, {
      vx: 0, vy: 0, facing: 1, roamStage: 'tail', stageProgress: 0.75, stridePx: 120,
    });
    assert.equal(lateTail.poseName, 'idle');
  }
});

test('pet.js removes 60fps throttling during lively motion and keeps subpixel transform during travel', () => {
  const petSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  assert.match(petSrc, /lively\s*\?\s*0\s*:\s*30/);
  assert.match(petSrc, /roam\s*\|\|\s*dragging\s*\?\s*`translate3d/);
});

test('pet.js passes explicit limb arguments to rig.buildPose matching rig.js signature', () => {
  const petSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  const rigSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'rig.js'), 'utf8');
  const params = 'name, bitmap, blinkBitmap, tailBitmap, underBitmap, cutBitmap, info, legLBitmap, legRBitmap, legCutBitmap';
  assert.equal(/rig\.buildPose\([^)]*\.\.\.layers/.test(petSrc), false);
  assert.ok(petSrc.includes(`rig.buildPose(${params})`), 'pet.js must pass explicit layers + info to rig.buildPose');
  assert.ok(rigSrc.includes(`function buildPose(${params})`), 'rig.js buildPose signature must match pet.js call');
});

test('pickPlayScene avoids repeating the same scene back to back', () => {
  const HAGEMI = loadRendererModules(['util.js', 'activity.js']);
  for (const prev of HAGEMI.PLAY_SCENES) {
    const next = HAGEMI.pickPlayScene(prev.id, () => 0);
    assert.notEqual(next.id, prev.id);
  }
});

test('behavior.js defines roam/play states and preserves follow-through when facing left', () => {
  let clock = 0;
  const HAGEMI = loadRendererModules(['util.js', 'behavior.js'], () => clock);
  for (const name of ['roamStroll', 'roamTrot', 'roamFloat', 'playSing', 'playFloat', 'playDance', 'playHop', 'playFish', 'playPeek']) {
    assert.ok(HAGEMI.STATES[name], `missing state ${name}`);
  }
  const animator = HAGEMI.createAnimator({ burst() {}, setStash() {}, setClones() {} });
  let frame;
  for (let i = 0; i < 15; i++) {
    clock += 16;
    frame = animator.update(0.016, i * 0.016, { vx: -320, vy: 0, facing: -1 });
  }
  assert.equal(frame.P.facing, -1);
  // Moving left while facing left means localVx is positive, so hair trails backward (+localVx -> negative sway).
  assert.ok(frame.P.hairSwayL < 0);
});

test('rig.js and pet.js couple iris-lead gaze with head, nod, and lean smoothly', () => {
  const rigSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'rig.js'), 'utf8');
  const petSrc = readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', 'pet.js'), 'utf8');
  assert.match(rigSrc, /eyeL:\s*eyes\[0\],\s*eyeR:\s*eyes\[1\]/);
  assert.match(rigSrc, /W\.eyes\[i\]\s*=\s*Math\.max/);
  assert.match(rigSrc, /if\s*\(W\.eyes\[i\]\)/);
  assert.match(petSrc, /onCursorMove/);
  assert.match(petSrc, /let gazeX\s*=\s*0,\s*gazeY\s*=\s*0,\s*gazeGoalX\s*=\s*0,\s*gazeGoalY\s*=\s*0/);
  assert.match(petSrc, /P\.head\s*\+=\s*gazeX/);
  assert.match(petSrc, /P\.nod\s*\+=\s*gazeY/);
  assert.match(petSrc, /P\.lean\s*=\s*clamp\(P\.lean\s*\+\s*gazeX/);
});
