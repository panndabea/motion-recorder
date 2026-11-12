import { Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { estimateClipSpeed, FEET } from '../../engine/locomotion/gait';
import { applyLegIk, rootAt, simulateFootLock, type FootLockConfig, type FootLockSim } from '../../engine/locomotion/footLock';
import type { LabActor } from '../../engine/labActor';

const DURATION = 4;
const COLORS = { planted: DEBUG_COLORS.planted, transition: DEBUG_COLORS.transition, swing: DEBUG_COLORS.swing };

export function footLockConfig(actor: LabActor, params: Params, enabled: boolean): FootLockConfig {
  const natural = estimateClipSpeed(actor, String(params.clip));
  return {
    clip: String(params.clip),
    playback: Number(params.playback),
    rootSpeed: natural * Number(params.rootFactor),
    threshold: Number(params.threshold) / 100,
    lock: { left: enabled && Boolean(params.lockLeft), right: enabled && Boolean(params.lockRight) },
    strength: Number(params.strength),
    release: Number(params.release),
    duration: DURATION,
    strideWarp: enabled && Boolean(params.strideWarp),
    naturalSpeed: natural,
  };
}

/** Cached simulation per actor + parameter set (re-simulated only when parameters change). */
export function footLockSim(actor: LabActor, cfg: FootLockConfig, state: Record<string, unknown>): FootLockSim {
  const key = JSON.stringify(cfg);
  if (state.simKey !== key) {
    state.sim = simulateFootLock(actor, cfg);
    state.simKey = key;
  }
  return state.sim as FootLockSim;
}

export const footLocking: Experiment = {
  id: 'foot-locking',
  title: 'Foot Locking / Foot IK',
  duration: () => DURATION,
  toggleKey: 'enabled',
  camera: 'side',
  defaults: { enabled: true, clip: 'Walk_Loop', playback: 0.8, rootFactor: 0.5, threshold: 3, lockLeft: true, lockRight: true, strideWarp: false, strength: 1, release: 0.15, showContacts: true, showTrajectories: true },
  controls: [
    { key: 'enabled', label: 'Foot locking on', type: 'toggle' },
    { key: 'clip', label: 'Locomotion clip', type: 'select', options: ['Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop', 'Crouch_Fwd_Loop'] },
    { key: 'playback', label: 'Playback speed (×)', type: 'range', min: 0.2, max: 2, step: 0.05 },
    { key: 'rootFactor', label: 'Root movement speed (× natural)', type: 'range', min: 0, max: 2, step: 0.05 },
    { key: 'threshold', label: 'Foot plant threshold (cm)', type: 'range', min: 0.5, max: 10, step: 0.5 },
    { key: 'lockLeft', label: 'Left foot lock', type: 'toggle' },
    { key: 'lockRight', label: 'Right foot lock', type: 'toggle' },
    { key: 'strideWarp', label: 'Stride warping (match steps to root speed)', type: 'toggle' },
    { key: 'strength', label: 'IK correction strength', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'release', label: 'Release blend (s)', type: 'range', min: 0, max: 0.5, step: 0.01 },
    { key: 'showContacts', label: 'Show foot contacts', type: 'toggle' },
    { key: 'showTrajectories', label: 'Show foot trajectories', type: 'toggle' },
  ],
  presets: [
    { name: 'Normal walk', params: { playback: 1, rootFactor: 1, strideWarp: false } },
    { name: 'Slowed walk', params: { playback: 0.8, rootFactor: 0.5, strideWarp: false } },
    { name: 'Root too slow', params: { playback: 1, rootFactor: 0.5, strideWarp: false } },
    { name: 'Incorrect root speed', params: { playback: 1, rootFactor: 1.25, strideWarp: false } },
    { name: 'Root far too fast (limit)', params: { playback: 0.6, rootFactor: 1.5, strideWarp: true } },
  ],
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    const cfg = footLockConfig(actor, params, enabled);
    const sim = footLockSim(actor, cfg, state);
    const i = Math.min(sim.frames.length - 1, Math.max(0, Math.round(t / sim.dt)));
    const frame = sim.frames[i];
    actor.sampleClip(cfg.clip, t * cfg.playback);
    actor.position.copy(rootAt(cfg, t));
    actor.heading = 0;
    if (enabled) applyLegIk(actor, { left: frame.left.target, right: frame.right.target }, cfg.strength);
    const steps = sim.frames.length;
    state.readout = {
      'Planted-foot slide (whole loop)': `${(sim.slideBaseline * 100).toFixed(1)} cm without → ${((enabled ? sim.slideLocked : sim.slideBaseline) * 100).toFixed(1)} cm`,
      'Root vs. feet speed': `${cfg.rootSpeed.toFixed(2)} vs ${(estimateClipSpeed(actor, cfg.clip) * cfg.playback).toFixed(2)} m/s`,
      'Left foot': `${frame.left.state}${frame.left.locked ? ' · locked' : ''}`,
      'Right foot': `${frame.right.state}${frame.right.locked ? ' · locked' : ''}`,
    };
    state.frameIndex = i;
    if (!debug) return;
    const fk = actor.fk();
    for (const side of ['left', 'right'] as const) {
      const f = frame[side];
      const p = actor.modelToWorld(fk.get(FEET[side].foot)!.position);
      if (params.showContacts) {
        dot(debug, new Vector3(p.x, 0.01, p.z), COLORS[f.state], 0.045);
        if (f.locked) dot(debug, new Vector3(f.target.x, 0.012, f.target.z), DEBUG_COLORS.target, 0.02);
      }
      if (params.showTrajectories) {
        const from = Math.max(0, i - Math.round(1.2 / sim.dt));
        const pts = sim.frames.slice(from, i + 1).map((fr) => (enabled ? fr[side].achieved : fr[side].animated).clone().setY(0.012));
        line(debug, pts, side === 'left' ? DEBUG_COLORS.chain : DEBUG_COLORS.modified);
      }
    }
    void steps;
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
