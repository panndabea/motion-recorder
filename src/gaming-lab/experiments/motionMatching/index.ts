import { Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { blendLayer, cloneRotations } from '../../engine/blending/layers';
import { buildDatabase, MM_CLIPS, poseFeatures, queryTrajectory, rankCandidates, TRAJ_T, type MMCandidate } from '../../engine/motion/motionMatching';
import type { LabActor } from '../../engine/labActor';

const DURATION = 12;
const DT = 1 / 30;
const BLEND = 0.25;
const D2R = Math.PI / 180;

/** Desired input over time: either constant or a scripted stop → walk → jog → sprint → stop profile. */
export function desiredInput(params: Params, t: number) {
  if (params.input === 'scripted') {
    const speed = t < 1.5 ? 0 : t < 4.5 ? 1.2 : t < 7 ? 2.6 : t < 9.5 ? 4.5 : 0;
    const dir = t < 6 ? 0 : 70;
    return { speed, dir: dir * D2R };
  }
  return { speed: Number(params.speed), dir: Number(params.direction) * D2R };
}

interface Step {
  t: number;
  clip: string;
  time: number;
  prevClip: string | null;
  prevTime: number;
  blend: number;
  heading: number;
  pos: Vector3;
  top: MMCandidate[];
  bestPerClip: Record<string, number>;
  searched: boolean;
}

/** Baseline without matching: pick the clip by speed thresholds and (re)start it at time 0 — no pose matching. */
function thresholdClip(speed: number) {
  return speed < 0.3 ? 'Idle_Loop' : speed < 1.8 ? 'Walk_Loop' : speed < 3.6 ? 'Jog_Fwd_Loop' : 'Sprint_Loop';
}

export function simulateMatching(actor: LabActor, params: Params, enabled: boolean): Step[] {
  const db = buildDatabase(actor);
  const speedOf = new Map(db.frames.map((f) => [f.clip, f.speed]));
  const interval = 1 / Math.max(1, Number(params.searchHz));
  let clip = 'Idle_Loop';
  let time = 0;
  let prevClip: string | null = null;
  let prevTime = 0;
  let blendStart = -Infinity;
  let heading = 0;
  const pos = new Vector3(0, 0, -2);
  let nextSearch = 0;
  let top: MMCandidate[] = [];
  let bestPerClip: Record<string, number> = {};
  const steps: Step[] = [];
  for (let i = 0; i * DT <= DURATION + 1e-9; i++) {
    const t = i * DT;
    const input = desiredInput(params, t);
    let searched = false;
    if (t >= nextSearch - 1e-9) {
      nextSearch += interval;
      searched = true;
      const rel = Math.atan2(Math.sin(input.dir - heading), Math.cos(input.dir - heading));
      if (enabled) {
        const ranked = rankCandidates(db, poseFeatures(actor, clip, time), queryTrajectory(input.speed, rel), Number(params.wPose), Number(params.wTraj));
        top = ranked.slice(0, 5);
        bestPerClip = Object.fromEntries(MM_CLIPS.map((c) => [c, ranked.find((r) => r.clip === c)!.cost]));
        const best = ranked[0];
        // continue the current clip unless the best candidate is elsewhere (different clip or far in time)
        const sameSpot = best.clip === clip && Math.abs(best.time - (time % actor.sampler(clip).duration)) < 0.2;
        if (!sameSpot) {
          prevClip = clip;
          prevTime = time;
          clip = best.clip;
          time = best.time;
          blendStart = t;
        }
      } else {
        const want = thresholdClip(input.speed);
        top = [];
        bestPerClip = {};
        if (want !== clip) {
          prevClip = clip;
          prevTime = time;
          clip = want;
          time = 0;
          blendStart = t;
        }
      }
    }
    const blend = Math.min(1, (t - blendStart) / BLEND);
    steps.push({ t, clip, time, prevClip: blend < 1 ? prevClip : null, prevTime, blend, heading, pos: pos.clone(), top, bestPerClip, searched });
    // advance: clip time, heading toward the desired direction (procedural — no turning clips), root by clip speed
    time += DT;
    prevTime += DT;
    const v = (speedOf.get(clip) ?? 0) * blend + (prevClip && blend < 1 ? (speedOf.get(prevClip) ?? 0) * (1 - blend) : 0);
    const turn = Math.atan2(Math.sin(input.dir - heading), Math.cos(input.dir - heading));
    heading += Math.max(-1, Math.min(1, turn)) * Math.min(Math.abs(turn), 120 * D2R * DT) * (v > 0.05 ? 1 : 0);
    pos.add(new Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(v * DT));
  }
  return steps;
}

function sim(actor: LabActor, params: Params, enabled: boolean, state: Record<string, unknown>) {
  const key = JSON.stringify([params, enabled]);
  if (state.key !== key) {
    state.steps = simulateMatching(actor, params, enabled);
    state.key = key;
  }
  return state.steps as Step[];
}

export const motionMatching: Experiment = {
  id: 'motion-matching',
  title: 'Motion Matching',
  duration: () => DURATION,
  toggleKey: 'enabled',
  camera: 'wide',
  defaults: { enabled: true, input: 'scripted', speed: 1.2, direction: 0, wPose: 1, wTraj: 2, searchHz: 6, showCandidates: true, showScores: true, showSelected: true },
  controls: [
    { key: 'enabled', label: 'Motion matching on', type: 'toggle' },
    { key: 'input', label: 'Input', type: 'select', options: ['scripted', 'constant'] },
    { key: 'speed', label: 'Desired speed (m/s, constant input)', type: 'range', min: 0, max: 6, step: 0.1 },
    { key: 'direction', label: 'Desired travel direction (°)', type: 'range', min: -180, max: 180, step: 5 },
    { key: 'wPose', label: 'Pose matching weight', type: 'range', min: 0, max: 5, step: 0.1 },
    { key: 'wTraj', label: 'Trajectory matching weight', type: 'range', min: 0, max: 5, step: 0.1 },
    { key: 'searchHz', label: 'Search frequency (Hz)', type: 'range', min: 1, max: 30, step: 1 },
    { key: 'showCandidates', label: 'Show candidate frames', type: 'toggle' },
    { key: 'showScores', label: 'Show matching scores', type: 'toggle' },
    { key: 'showSelected', label: 'Show selected frame', type: 'toggle' },
  ],
  presets: [
    { name: 'Stop → walk → jog → sprint', params: { input: 'scripted' } },
    { name: 'Slow walk', params: { input: 'constant', speed: 0.9, direction: 0 } },
    { name: 'Sprint and turn', params: { input: 'constant', speed: 5, direction: 90 } },
    { name: 'Trajectory only (wPose 0)', params: { input: 'scripted', wPose: 0, wTraj: 2 } },
  ],
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    const steps = sim(actor, params, enabled, state);
    if (enabled) publishChart(params, steps);
    const s = steps[Math.min(steps.length - 1, Math.max(0, Math.round(t / DT)))];
    actor.sampleClip(s.clip, s.time);
    if (s.prevClip) {
      const cur = cloneRotations(actor.pose.rotations);
      const hips = actor.pose.translations.get('DEF-hips')!.clone();
      actor.sampleClip(s.prevClip, s.prevTime);
      const mixed = blendLayer(actor.pose.rotations, cur, null, s.blend, 'override');
      for (const [b, q] of mixed) actor.rot(b).copy(q);
      actor.pose.translations.get('DEF-hips')!.lerp(hips, s.blend);
    }
    actor.position.copy(s.pos);
    actor.heading = s.heading;
    const input = desiredInput(params, t);
    const ro: Record<string, string> = {
      'Desired speed / direction': `${input.speed.toFixed(1)} m/s / ${(input.dir / D2R).toFixed(0)}°`,
      Playing: `${s.clip} @ ${s.time.toFixed(2)} s${s.prevClip ? ` (blending from ${s.prevClip})` : ''}`,
    };
    if (enabled && params.showScores) s.top.slice(0, params.showCandidates ? 4 : 1).forEach((c, i) => (ro[`#${i + 1} ${c.clip} @${c.time.toFixed(2)}`] = `${c.cost.toFixed(2)} (pose ${c.poseCost.toFixed(2)}, traj ${c.trajCost.toFixed(2)})`));
    if (!enabled) ro.Selection = 'speed thresholds, clip restarts at frame 0';
    state.readout = ro;
    state.current = s;
    if (!debug) return;
    const fwd = (a: number) => new Vector3(Math.sin(a), 0, Math.cos(a));
    const base = s.pos.clone().setY(0.02);
    line(debug, [base, ...TRAJ_T.map((f) => base.clone().add(fwd(input.dir).multiplyScalar(input.speed * f)))], DEBUG_COLORS.modified);
    if (enabled && params.showSelected && s.top[0]) {
      const v = buildDatabase(actor).frames[s.top[0].index].speed;
      line(debug, [base, ...TRAJ_T.map((f) => base.clone().add(fwd(s.heading).multiplyScalar(v * f)))], DEBUG_COLORS.chain);
    }
    dot(debug, base, DEBUG_COLORS.modified, 0.03);
  },
  chart: (params, t) => chartFor(params, t),
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};

let chartSteps: Step[] | null = null;
let chartKey = '';
/** Best cost per clip over time — shows why a clip wins. Uses the last simulation of the primary view. */
function chartFor(params: Params, t: number) {
  const colors = ['#888', '#666', '#4dd2ff', '#3ddc84', '#c77dff', '#ffd24d', '#ff4d6d'];
  const steps = chartKey === JSON.stringify([params, true]) && chartSteps ? chartSteps : [];
  return {
    title: 'Best matching cost per clip (lower wins)',
    xLabel: 'time s',
    yLabel: 'cost',
    series: MM_CLIPS.map((c, i) => ({ name: c, color: colors[i], points: steps.filter((s) => s.searched && s.bestPerClip[c] !== undefined).map((s) => [s.t, Math.min(10, s.bestPerClip[c])] as [number, number]) })),
    cursorX: t,
  };
}

/** Lets the primary view publish its simulation to the chart. */
export function publishChart(params: Params, steps: Step[]) {
  chartSteps = steps;
  chartKey = JSON.stringify([params, true]);
}
