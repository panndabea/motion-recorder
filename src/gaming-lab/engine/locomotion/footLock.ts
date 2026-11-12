import { Quaternion, Vector3 } from 'three';
import { LIMBS, solveLimb } from '../ik/twoBone';
import type { LabActor } from '../labActor';
import { FEET, smoothstep } from './gait';

export type ContactState = 'planted' | 'transition' | 'swing';

export interface FootLockConfig {
  /** Clip playback rate. */
  playback: number;
  /** Root speed in m/s. */
  rootSpeed: number;
  /** Height above the foot's lowest point (m) under which it counts as planted. */
  threshold: number;
  lock: { left: boolean; right: boolean };
  strength: number;
  /** Blend-out time after the lock is released (s). */
  release: number;
  duration: number;
  clip: string;
  /** Stride warping: scale horizontal foot offsets from the hips by root speed / animated speed. */
  strideWarp: boolean;
  /** Natural speed of the clip at playback 1 (m/s). */
  naturalSpeed: number;
}

export interface FootFrame {
  animated: Vector3;
  target: Vector3;
  achieved: Vector3;
  state: ContactState;
  locked: boolean;
}

export interface FootLockSim {
  dt: number;
  frames: { left: FootFrame; right: FootFrame }[];
  /** Total horizontal displacement of feet while planted (m), without/with locking. */
  slideBaseline: number;
  slideLocked: number;
}

export function rootAt(cfg: FootLockConfig, t: number) {
  return new Vector3(0, 0, -1.6 + cfg.rootSpeed * t);
}

/** Lowest model-space height of each foot over the clip (planted reference). */
function footFloor(actor: LabActor, clip: string) {
  const d = actor.sampler(clip).duration;
  const out = { left: Infinity, right: Infinity };
  for (let i = 0; i <= 60; i++) {
    actor.sampleClip(clip, (i / 60) * d);
    const fk = actor.fk();
    out.left = Math.min(out.left, fk.get(FEET.left.foot)!.position.y);
    out.right = Math.min(out.right, fk.get(FEET.right.foot)!.position.y);
  }
  return out;
}

/** Poses the actor for time t (animated, no locking) and returns world foot positions + contact states. */
function animatedFeet(actor: LabActor, cfg: FootLockConfig, t: number, floor: { left: number; right: number }) {
  actor.sampleClip(cfg.clip, t * cfg.playback);
  actor.position.copy(rootAt(cfg, t));
  actor.heading = 0;
  const fk = actor.fk();
  const res = {} as Record<'left' | 'right', { pos: Vector3; state: ContactState }>;
  const hips = actor.modelToWorld(fk.get('DEF-hips')!.position);
  const animatedSpeed = cfg.naturalSpeed * cfg.playback;
  const k = cfg.strideWarp && animatedSpeed > 1e-3 ? cfg.rootSpeed / animatedSpeed : 1;
  for (const side of ['left', 'right'] as const) {
    const p = fk.get(FEET[side].foot)!.position;
    const h = (p.y - floor[side]) * actor.scale;
    const state: ContactState = h < cfg.threshold ? 'planted' : h < cfg.threshold * 2 ? 'transition' : 'swing';
    const pos = actor.modelToWorld(p);
    if (k !== 1) pos.z = hips.z + (pos.z - hips.z) * k;
    res[side] = { pos, state };
  }
  return res;
}

/** Applies leg IK so the feet reach world targets, keeping the animated foot orientation. */
export function applyLegIk(actor: LabActor, targets: Partial<Record<'left' | 'right', Vector3>>, strength: number) {
  for (const side of ['left', 'right'] as const) {
    const target = targets[side];
    if (!target) continue;
    const chain = side === 'left' ? LIMBS.legL : LIMBS.legR;
    const footWorld = actor.fk().get(chain.end)!.quaternion.clone();
    solveLimb(actor, chain, actor.worldToModel(target), new Vector3(0, 0, 1), strength);
    const shinWorld = actor.fk().get(chain.lower)!.quaternion;
    actor.rot(chain.end).copy(new Quaternion().copy(shinWorld).invert().multiply(footWorld).normalize());
  }
}

/**
 * Deterministic foot-lock simulation over the whole loop at a fixed step. When a foot becomes planted its
 * world position is anchored; while planted the IK target stays on the anchor; when contact ends (or the
 * leg would over-stretch) the offset to the animated foot blends out over `release` seconds.
 */
export function simulateFootLock(actor: LabActor, cfg: FootLockConfig, dt = 1 / 60): FootLockSim {
  const floor = footFloor(actor, cfg.clip);
  const n = Math.ceil(cfg.duration / dt) + 1;
  const frames: FootLockSim['frames'] = [];
  const lockState = {
    left: { anchor: null as Vector3 | null, offset: new Vector3(), releaseT: Infinity, gaveUp: false },
    right: { anchor: null as Vector3 | null, offset: new Vector3(), releaseT: Infinity, gaveUp: false },
  };
  const maxStretch = (actor.pose.translations.get(LIMBS.legL.lower)!.length() + actor.pose.translations.get(LIMBS.legL.end)!.length()) * actor.scale * 0.995;
  let slideBaseline = 0;
  let slideLocked = 0;
  let prev: FootLockSim['frames'][number] | null = null;
  for (let i = 0; i < n; i++) {
    const t = Math.min(cfg.duration, i * dt);
    const feet = animatedFeet(actor, cfg, t, floor);
    const fk = actor.fk();
    const frame = {} as FootLockSim['frames'][number];
    const targets: Partial<Record<'left' | 'right', Vector3>> = {};
    for (const side of ['left', 'right'] as const) {
      const s = lockState[side];
      const { pos, state } = feet[side];
      const hip = actor.modelToWorld(fk.get((side === 'left' ? LIMBS.legL : LIMBS.legR).upper)!.position);
      let locked = false;
      let target = pos.clone();
      if (cfg.lock[side]) {
        if (state !== 'planted') s.gaveUp = false;
        if (state === 'planted' && !s.gaveUp) {
          if (!s.anchor) s.anchor = pos.clone();
          const anchored = new Vector3(s.anchor.x, pos.y, s.anchor.z);
          if (anchored.distanceTo(hip) < maxStretch) {
            target = anchored;
            locked = true;
            s.offset.copy(anchored).sub(pos);
            s.releaseT = t;
          }
        }
        if (!locked) {
          if (!cfg.strideWarp && state === 'planted' && !s.gaveUp) target = pos.clone();
          s.anchor = state === 'planted' ? s.anchor : null;
          const w = 1 - smoothstep((t - s.releaseT) / Math.max(1e-3, cfg.release));
          if (w > 0 && Number.isFinite(s.releaseT)) target = pos.clone().add(s.offset.clone().multiplyScalar(w));
          if (state === 'planted' && s.anchor) {
            // leg would over-stretch: give up this contact until the foot lifts again
            s.anchor = null;
            s.gaveUp = true;
          }
        }
      }
      targets[side] = target;
      frame[side] = { animated: pos, target, achieved: target.clone(), state, locked };
    }
    applyLegIk(actor, targets, cfg.strength);
    const fk2 = actor.fk();
    for (const side of ['left', 'right'] as const) {
      frame[side].achieved = actor.modelToWorld(fk2.get(FEET[side].foot)!.position);
      if (prev && prev[side].state === 'planted' && frame[side].state === 'planted') {
        const h = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
        slideBaseline += h(frame[side].animated, prev[side].animated);
        slideLocked += h(frame[side].achieved, prev[side].achieved);
      }
    }
    frames.push(frame);
    prev = frame;
  }
  return { dt, frames, slideBaseline, slideLocked };
}
