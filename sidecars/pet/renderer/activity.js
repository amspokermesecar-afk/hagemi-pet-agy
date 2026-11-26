// Autonomous idle, roaming, and play choreography inspired by dsh-pet.
// Pure planning/sampling functions so unit tests can verify trajectories without a browser.
HAGEMI.ACTIVITY_WEIGHTS = { idle: 20, turn: 10, roam: 45, play: 25 };

HAGEMI.CALM_WORK_STATES = [
  'thinking', 'deepthink', 'reading', 'writing', 'running',
  'searching', 'drawing', 'delegating', 'busy',
];
HAGEMI.isCalmWorkState = state => HAGEMI.CALM_WORK_STATES.includes(state);
HAGEMI.canRoamInState = state => state === 'idle' || HAGEMI.isCalmWorkState(state);

HAGEMI.WALK_POSES = ['walk_1'];

HAGEMI.ROAM_STYLES = {
  stroll: { name: 'stroll', state: 'roamStroll', speed: 74, minDist: 220, maxDist: 480, leadSec: 0.38, tailSec: 0.45, verticalDrift: 0, stridePx: 118 },
  trot: { name: 'trot', state: 'roamTrot', speed: 126, minDist: 280, maxDist: 560, leadSec: 0.28, tailSec: 0.45, verticalDrift: 0, stridePx: 138, burst: 'dust' },
  float: { name: 'float', state: 'roamFloat', speed: 88, minDist: 220, maxDist: 460, leadSec: 0.4, tailSec: 0.5, verticalDrift: 70, stridePx: 0, burst: 'sparkles' },
};

HAGEMI.PLAY_SCENES = [
  { id: 'sing', state: 'playSing', ms: 5600, burst: 'notes', gesture: 'nod' },
  { id: 'float', state: 'playFloat', ms: 6200, burst: 'sparkles', gesture: 'drift' },
  { id: 'dance', state: 'playDance', ms: 5400, burst: 'notes', gesture: 'bounce' },
  { id: 'hop', state: 'playHop', ms: 4600, burst: 'sparkles', gesture: 'spin' },
  { id: 'fish', state: 'playFish', ms: 5000, burst: 'fish', gesture: 'hop' },
  { id: 'peek', state: 'playPeek', ms: 4800, burst: null, gesture: 'lookAround' },
];

HAGEMI.rollActivity = function rollActivity(roll, { fixed = false, weights = HAGEMI.ACTIVITY_WEIGHTS } = {}) {
  const idle = Math.max(0, Number(weights.idle) || 0);
  const turn = fixed ? 0 : Math.max(0, Number(weights.turn) || 0);
  const roam = fixed ? 0 : Math.max(0, Number(weights.roam) || 0);
  const playBase = Math.max(0, Number(weights.play) || 0);
  const play = playBase + (fixed ? Math.max(0, Number(weights.turn) || 0) + Math.max(0, Number(weights.roam) || 0) : 0);
  const total = idle + turn + roam + play || 1;
  let r = HAGEMI.util.clamp(Number(roll) || 0, 0, 0.999999) * total;
  if (r < idle) return 'idle';
  r -= idle;
  if (r < turn) return 'turn';
  r -= turn;
  if (r < roam) return 'roam';
  return 'play';
};

HAGEMI.planRoam = function planRoam({ x, y, viewW, viewH, spriteW, spriteH, facing = 1, styleName, random = Math.random }) {
  const { clamp } = HAGEMI.util;
  const marginX = Math.max(24, spriteW * 0.25);
  const marginY = Math.max(24, spriteH * 0.24);
  const minX = marginX;
  const maxX = viewW - marginX;
  const minY = marginY;
  const maxY = Math.max(minY, viewH - marginY);
  if (maxX - minX < 60) return null;

  const stylePool = [
    HAGEMI.ROAM_STYLES.stroll,
    HAGEMI.ROAM_STYLES.stroll,
    HAGEMI.ROAM_STYLES.trot,
    HAGEMI.ROAM_STYLES.float,
  ];
  const style = (styleName && HAGEMI.ROAM_STYLES[styleName]) || stylePool[Math.floor(random() * stylePool.length)];
  const distScale = clamp((spriteW || 180) / 180, 0.72, 1.75);
  const minDist = style.minDist * distScale;
  const maxDist = style.maxDist * distScale;
  const speed = style.speed * clamp(distScale, 0.85, 1.35);
  const stridePx = style.stridePx ? style.stridePx * distScale : 0;

  let dir = facing < 0 ? -1 : 1;
  let room = dir > 0 ? maxX - x : x - minX;
  if (room < minDist) {
    dir = -dir;
    room = dir > 0 ? maxX - x : x - minX;
  }
  if (room < Math.min(48, minDist * 0.5)) return null;

  const span = Math.max(0, maxDist - minDist);
  const dist = Math.min(room, minDist + random() * span);
  const startX = clamp(x, minX, maxX);
  const startY = clamp(y, minY, maxY);
  const targetX = clamp(startX + dir * dist, minX, maxX);
  const dy = style.verticalDrift ? (random() * 2 - 1) * style.verticalDrift : 0;
  const targetY = clamp(startY + dy, minY, maxY);
  const actualDist = Math.hypot(targetX - startX, targetY - startY);
  const travelSec = Math.max(0.6, actualDist / speed);
  const totalSec = style.leadSec + travelSec + style.tailSec;

  return {
    style: style.name,
    state: style.state,
    burst: style.burst || null,
    dir,
    startX,
    startY,
    targetX,
    targetY,
    leadSec: style.leadSec,
    travelSec,
    tailSec: style.tailSec,
    totalSec,
    stridePx,
  };
};

HAGEMI.sampleRoam = function sampleRoam(plan, elapsedSec) {
  const { clamp } = HAGEMI.util;
  if (elapsedSec <= plan.leadSec) {
    const stageProgress = plan.leadSec > 0 ? clamp(elapsedSec / plan.leadSec, 0, 1) : 1;
    return { x: plan.startX, y: plan.startY, vx: 0, vy: 0, stage: 'lead', stageProgress, travelProgress: 0, done: false };
  }
  const travelElapsed = elapsedSec - plan.leadSec;
  if (travelElapsed >= plan.travelSec) {
    const tailElapsed = travelElapsed - plan.travelSec;
    const done = elapsedSec >= plan.totalSec;
    const stageProgress = done ? 1 : plan.tailSec > 0 ? clamp(tailElapsed / plan.tailSec, 0, 1) : 1;
    return { x: plan.targetX, y: plan.targetY, vx: 0, vy: 0, stage: 'tail', stageProgress, travelProgress: 1, done };
  }
  const u = clamp(travelElapsed / plan.travelSec, 0, 1);
  const s = u * u * (3 - 2 * u);
  const ds = (6 * u * (1 - u)) / plan.travelSec;
  return {
    x: plan.startX + (plan.targetX - plan.startX) * s,
    y: plan.startY + (plan.targetY - plan.startY) * s,
    vx: (plan.targetX - plan.startX) * ds,
    vy: (plan.targetY - plan.startY) * ds,
    stage: 'travel',
    stageProgress: u,
    travelProgress: u,
    done: false,
  };
};

HAGEMI.pickPlayScene = function pickPlayScene(lastId, random = Math.random) {
  const scenes = HAGEMI.PLAY_SCENES;
  const pool = scenes.length > 1 && lastId ? scenes.filter(scene => scene.id !== lastId) : scenes;
  return pool[Math.floor(random() * pool.length)];
};
