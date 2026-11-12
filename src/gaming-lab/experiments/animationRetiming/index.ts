import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { estimateClipSpeed } from '../../engine/locomotion/gait';
import type { LabActor } from '../../engine/labActor';
import { Vector3 } from 'three';

export const EASINGS: Record<string, (u: number) => number> = {
  linear: (u) => u,
  'ease-in': (u) => u * u * u,
  'ease-out': (u) => 1 - (1 - u) ** 3,
  'ease-in-out': (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
};

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const WALK = 'Walk_Loop';
let lastActor: LabActor | null = null;

/** Duration (s) of the original action. Walks use distance / natural clip speed. */
export function originalDuration(params: Params, actor: LabActor | null = lastActor) {
  if (params.clip === WALK) {
    const v = actor ? estimateClipSpeed(actor, WALK) : 1.2;
    return Number(params.distance) / Math.max(0.1, v);
  }
  return actor?.sampler(String(params.clip)).duration ?? 1;
}

/**
 * Time-warp function: lab time t (0..T) -> source time s (0..D). Monotonic and continuous.
 * `uniform`: s = D·t/T. `eased`: s = D·ease(t/T). `phased`: anticipation → main → hold → follow-through.
 */
export function timeMap(t: number, D: number, params: Params): number {
  const T = Math.max(0.05, Number(params.target));
  const ease = EASINGS[String(params.easing)] ?? EASINGS.linear;
  const method = String(params.method);
  if (method === 'uniform') return D * clamp01(t / T);
  if (method === 'eased') return D * ease(clamp01(t / T));
  let A = Number(params.anticipation);
  let H = Number(params.hold);
  let F = Number(params.follow);
  const extra = A + H + F;
  if (extra > T - 0.1) {
    const k = (T - 0.1) / Math.max(1e-6, extra);
    A *= k;
    H *= k;
    F *= k;
  }
  const M = T - A - H - F;
  const a = 0.25 * D;
  const b = 0.75 * D;
  if (t <= A) return A > 0 ? a * EASINGS['ease-in-out'](t / A) : 0;
  const tm = t - A;
  if (tm <= M) return (A > 0 ? a : 0) + (b - (A > 0 ? a : 0)) * ease(clamp01(tm / M));
  if (tm <= M + H) return b;
  const tf = tm - M - H;
  return F > 0 ? b + (D - b) * EASINGS['ease-out'](clamp01(tf / F)) : D;
}

/** Inverse of a monotonic time map by bisection (used for keyframe markers). */
export function inverseTimeMap(s: number, D: number, params: Params) {
  let lo = 0;
  let hi = Number(params.target);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (timeMap(mid, D, params) < s) lo = mid;
    else hi = mid;
  }
  return hi;
}

function keyTimes(actor: LabActor, clip: string) {
  const c = actor.rig.clips.find((k) => k.name === clip);
  const times = c?.tracks.find((tr) => tr.name.includes('upper_arm') || tr.name.includes('spine'))?.times ?? [];
  return Array.from(times);
}

export const animationRetiming: Experiment = {
  id: 'retiming',
  title: 'Animation Retiming / Time Warping',
  duration: (p) => Math.max(Number(p.target), originalDuration(p)) + 0.8,
  toggleKey: 'enabled',
  camera: 'side',
  defaults: { enabled: true, clip: 'PickUp_Table', target: 5, method: 'phased', easing: 'ease-in-out', anticipation: 1, hold: 1, follow: 1, walkMode: 'time-scale', distance: 3, showKeys: true, showCurve: true },
  controls: [
    { key: 'enabled', label: 'Retiming on', type: 'toggle' },
    { key: 'clip', label: 'Action', type: 'select', options: ['PickUp_Table', 'Interact', 'Punch_Jab', 'Sitting_Enter', WALK] },
    { key: 'target', label: 'Target duration (s)', type: 'range', min: 0.3, max: 12, step: 0.1 },
    { key: 'method', label: 'Method', type: 'select', options: ['uniform', 'eased', 'phased'] },
    { key: 'easing', label: 'Easing curve', type: 'select', options: Object.keys(EASINGS) },
    { key: 'anticipation', label: 'Anticipation duration (s)', type: 'range', min: 0, max: 4, step: 0.1 },
    { key: 'hold', label: 'Hold duration (s)', type: 'range', min: 0, max: 4, step: 0.1 },
    { key: 'follow', label: 'Follow-through duration (s)', type: 'range', min: 0, max: 4, step: 0.1 },
    { key: 'walkMode', label: 'Walk retiming', type: 'select', options: ['time-scale', 'gait repetition'] },
    { key: 'distance', label: 'Walk distance (m)', type: 'range', min: 1, max: 6, step: 0.1 },
    { key: 'showKeys', label: 'Show keyframes', type: 'toggle' },
    { key: 'showCurve', label: 'Show time mapping curve', type: 'toggle' },
  ],
  presets: [
    { name: 'Normal action', params: { clip: 'PickUp_Table', method: 'uniform', target: 0.83 } },
    { name: 'Slow and careful', params: { clip: 'PickUp_Table', method: 'phased', target: 8, easing: 'ease-in-out', anticipation: 2, hold: 1.5, follow: 2 } },
    { name: 'Fast and exaggerated', params: { clip: 'Interact', method: 'phased', target: 1.4, easing: 'ease-in', anticipation: 0.5, hold: 0.3, follow: 0.3 } },
    { name: 'Walk 3 m in 8 s (time-scale)', params: { clip: WALK, walkMode: 'time-scale', target: 8, method: 'uniform' } },
    { name: 'Walk 3 m in 8 s (gait repetition)', params: { clip: WALK, walkMode: 'gait repetition', target: 8, method: 'uniform' } },
  ],
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    lastActor = actor;
    const clip = String(params.clip);
    const D = originalDuration(params, actor);
    const T = enabled ? Number(params.target) : D;
    const s = enabled ? timeMap(Math.min(t, T), D, params) : Math.min(t, D);
    const walk = clip === WALK;
    let rate = D / T;
    if (walk) {
      const v = estimateClipSpeed(actor, WALK);
      const dist = Number(params.distance);
      const gait = enabled && params.walkMode === 'gait repetition';
      // time-scale: the cycle itself is slowed (s from the warp); gait repetition: natural cadence, more cycles
      const clipTime = gait ? Math.min(t, T) : s;
      actor.sampleClip(WALK, clipTime);
      const progress = gait ? Math.min(1, t / T) : s / D;
      actor.position.set(0, 0, -dist / 2 + dist * progress);
      const rootSpeed = dist / T;
      state.slide = gait ? Math.abs(v - rootSpeed) : 0;
      rate = gait ? 1 : D / T;
      state.readout = {
        'Natural walk speed': `${v.toFixed(2)} m/s`,
        'Root speed': `${rootSpeed.toFixed(2)} m/s`,
        'Cycle playback rate': `${rate.toFixed(2)}×`,
        'Foot slide (planted foot speed)': gait ? `${(state.slide as number).toFixed(2)} m/s` : '0 (cycle slowed with root)',
      };
    } else {
      actor.sampleClip(clip, Math.min(s, D - 1e-4));
      state.readout = {};
    }
    state.sourceTime = s;
    state.readout = {
      'Original duration': `${D.toFixed(2)} s`,
      'Retimed duration': `${T.toFixed(2)} s`,
      'Average playback rate': `${(D / T).toFixed(2)}×`,
      'Source time': `${s.toFixed(2)} s`,
      ...(state.readout as Record<string, string>),
    };
    if (debug && walk) {
      const d = Number(params.distance);
      line(debug, [new Vector3(0, 0.01, -d / 2), new Vector3(0, 0.01, d / 2)], DEBUG_COLORS.original);
      dot(debug, actor.position.clone().setY(0.02), DEBUG_COLORS.modified, 0.03);
    }
  },
  chart: (params, t) => {
    const D = originalDuration(params);
    const T = Number(params.target);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 160; i++) {
      const x = (i / 160) * T;
      pts.push([x, timeMap(x, D, params)]);
    }
    const keys = params.showKeys && lastActor && params.clip !== WALK ? keyTimes(lastActor, String(params.clip)) : [];
    return {
      title: 'Time mapping: lab time → source time',
      xLabel: 'lab time s',
      yLabel: 'source s',
      series: params.showCurve
        ? [
            { name: 'retimed', color: '#ff9f1c', points: pts },
            { name: 'original (1×)', color: '#888888', points: [[0, 0], [D, D]], dashed: true },
          ]
        : [],
      markers: keys.map((k) => ({ x: inverseTimeMap(k, D, params), y: k, color: '#4dd2ff' })),
      cursorX: Math.min(t, T),
    };
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
