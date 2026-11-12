import { Quaternion, Vector3 } from 'three';
import { DEBUG_COLORS, dot } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { rotateBoneInModel } from '../../engine/ik/twoBone';
import { fbm, springAt } from '../../engine/procedural/noise';
import type { LabActor } from '../../engine/labActor';

const D2R = Math.PI / 180;
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const rot = (axis: Vector3, deg: number) => new Quaternion().setFromAxisAngle(axis, deg * D2R);

/** Upper bounds (deg) per layer at amount 1 — used for the amplitude tests and readout. */
export const MAX_DEG = { breathing: 4, sway: 4, nervous: 6, shoulders: 6, head: 8, follow: 10 };

/** Per-layer procedural angles (deg) at time t — pure function of t, params and seed. */
export function secondaryAngles(params: Params, t: number) {
  const seed = Math.round(Number(params.seed));
  const nf = Number(params.noiseFreq);
  const na = Number(params.noiseAmp);
  const br = Number(params.breathing) * Math.sin(t * Math.PI * 2 * Number(params.breathFreq));
  const swayAmt = Number(params.sway);
  const sway = { roll: swayAmt * fbm(seed, 1, t * 0.35) * MAX_DEG.sway, yaw: swayAmt * fbm(seed, 2, t * 0.3) * MAX_DEG.sway * 0.6 };
  const nerv = Number(params.nervous);
  const nervous = { a: nerv * fbm(seed, 3, t * 2.4 * nf) * MAX_DEG.nervous * na, b: nerv * fbm(seed, 4, t * 2.9 * nf) * MAX_DEG.nervous * na };
  const sh = Number(params.shoulders);
  const shoulders = { l: sh * (0.5 + 0.5 * br) * MAX_DEG.shoulders * 0.5 + sh * fbm(seed, 5, t * 0.8 * nf) * MAX_DEG.shoulders * 0.5 * na, r: sh * (0.5 + 0.5 * br) * MAX_DEG.shoulders * 0.5 + sh * fbm(seed, 6, t * 0.8 * nf) * MAX_DEG.shoulders * 0.5 * na };
  const hd = Number(params.head);
  const head = { yaw: hd * fbm(seed, 7, t * 0.6 * nf) * MAX_DEG.head * na, pitch: hd * fbm(seed, 8, t * 0.5 * nf) * MAX_DEG.head * 0.5 * na };
  // follow-through: the head lags behind the body sway through a damped spring (overshoots, then settles)
  const fol = Number(params.follow);
  const follow = fol > 0 ? fol * (springAt((x) => -fbm(seed, 2, x * 0.3) * MAX_DEG.sway * 0.6 * swayAmt, t, 40, 5) + fbm(seed, 2, t * 0.3) * MAX_DEG.sway * 0.6 * swayAmt) * 2 : 0;
  return { breathing: br * MAX_DEG.breathing, sway, nervous, shoulders, head, follow: Math.max(-MAX_DEG.follow, Math.min(MAX_DEG.follow, follow)) };
}

export function applySecondary(actor: LabActor, params: Params, t: number) {
  const a = secondaryAngles(params, t);
  rotateBoneInModel(actor, 'DEF-hips', rot(Z, a.sway.roll).multiply(rot(Y, a.sway.yaw)));
  rotateBoneInModel(actor, 'DEF-spine.002', rot(X, -a.breathing * 0.5));
  rotateBoneInModel(actor, 'DEF-spine.003', rot(X, -a.breathing * 0.5));
  rotateBoneInModel(actor, 'DEF-shoulder.L', rot(Z, a.shoulders.l));
  rotateBoneInModel(actor, 'DEF-shoulder.R', rot(Z, -a.shoulders.r));
  rotateBoneInModel(actor, 'DEF-spine.003', rot(Y, a.nervous.a * 0.4));
  rotateBoneInModel(actor, 'DEF-hand.L', rot(X, a.nervous.b));
  rotateBoneInModel(actor, 'DEF-hand.R', rot(X, -a.nervous.a));
  rotateBoneInModel(actor, 'DEF-head', rot(Y, a.head.yaw + a.nervous.b * 0.6 + a.follow).multiply(rot(X, a.head.pitch)));
  return a;
}

export const secondaryMotion: Experiment = {
  id: 'secondary-motion',
  title: 'Procedural Secondary Motion',
  duration: () => 8,
  toggleKey: 'enabled',
  defaults: { enabled: true, base: 'static pose', breathing: 0.6, breathFreq: 0.25, sway: 0.5, nervous: 0, shoulders: 0.4, head: 0.4, follow: 0, noiseFreq: 1, noiseAmp: 1, seed: 7 },
  controls: [
    { key: 'enabled', label: 'Secondary motion on', type: 'toggle' },
    { key: 'base', label: 'Base', type: 'select', options: ['static pose', 'Idle_Loop', 'Walk_Loop'] },
    { key: 'breathing', label: 'Breathing amount', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'breathFreq', label: 'Breathing frequency (Hz)', type: 'range', min: 0.1, max: 1, step: 0.01 },
    { key: 'sway', label: 'Body sway', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'nervous', label: 'Nervousness', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'shoulders', label: 'Shoulder motion', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'head', label: 'Head motion', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'follow', label: 'Follow-through (spring)', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'noiseFreq', label: 'Noise frequency', type: 'range', min: 0.2, max: 3, step: 0.05 },
    { key: 'noiseAmp', label: 'Noise amplitude', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'seed', label: 'Random seed', type: 'range', min: 1, max: 99, step: 1 },
  ],
  presets: [
    { name: 'Calm breathing', params: { base: 'static pose', breathing: 0.8, breathFreq: 0.22, sway: 0.3, nervous: 0, shoulders: 0.3, head: 0.2, follow: 0 } },
    { name: 'Nervous', params: { base: 'static pose', breathing: 0.7, breathFreq: 0.5, sway: 0.4, nervous: 0.9, shoulders: 0.8, head: 0.8, noiseFreq: 1.8, follow: 0.3 } },
    { name: 'Swaying with follow-through', params: { base: 'static pose', breathing: 0.4, sway: 1, nervous: 0, head: 0, follow: 1 } },
    { name: 'Walk + nervous', params: { base: 'Walk_Loop', nervous: 0.7, head: 0.6, breathing: 0.3, sway: 0.2 } },
  ],
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    const base = String(params.base);
    actor.sampleClip(base === 'static pose' ? 'Idle_Loop' : base, base === 'static pose' ? 0 : t);
    if (!enabled) {
      state.readout = { 'Added motion': 'none' };
      return;
    }
    const a = applySecondary(actor, params, t);
    state.angles = a;
    state.readout = {
      Breathing: `${a.breathing.toFixed(1)}°`,
      'Sway roll / yaw': `${a.sway.roll.toFixed(1)}° / ${a.sway.yaw.toFixed(1)}°`,
      'Head yaw / pitch': `${a.head.yaw.toFixed(1)}° / ${a.head.pitch.toFixed(1)}°`,
      'Follow-through': `${a.follow.toFixed(1)}°`,
      Seed: String(Math.round(Number(params.seed))),
    };
    if (debug) {
      const fk = actor.fk();
      for (const b of ['DEF-hips', 'DEF-spine.003', 'DEF-head', 'DEF-shoulder.L', 'DEF-shoulder.R']) dot(debug, actor.modelToWorld(fk.get(b)!.position), DEBUG_COLORS.modified, 0.018);
    }
  },
  chart: (params, t) => {
    const pts = (f: (x: number) => number) => Array.from({ length: 121 }, (_, i) => [(i / 120) * 8, f((i / 120) * 8)] as [number, number]);
    return {
      title: 'Procedural signals over the 8 s loop (deg)',
      xLabel: 'time s',
      yLabel: 'deg',
      series: [
        { name: 'breathing', color: '#4dd2ff', points: pts((x) => secondaryAngles(params, x).breathing) },
        { name: 'sway roll', color: '#3ddc84', points: pts((x) => secondaryAngles(params, x).sway.roll) },
        { name: 'head yaw', color: '#c77dff', points: pts((x) => secondaryAngles(params, x).head.yaw) },
        { name: 'follow-through', color: '#ffd24d', points: params.follow ? pts((x) => secondaryAngles(params, x).follow) : [] },
      ],
      cursorX: t,
    };
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
