import { Quaternion, Vector3 } from 'three';
import type { RigDefinition } from '../../../rig/rigDefinition';
import { rotateBoneInModel } from '../ik/twoBone';
import type { LabActor } from '../labActor';

export type BlendMode = 'override' | 'additive';

/** All bones in the subtrees rooted at `roots` (inclusive). */
export function boneMask(def: RigDefinition, roots: readonly string[]): Set<string> {
  const out = new Set<string>(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of def.bones) {
      if (b.parent && out.has(b.parent) && !out.has(b.name)) {
        out.add(b.name);
        grew = true;
      }
    }
  }
  return out;
}

export const MASK_ROOTS = {
  upperBody: ['DEF-spine.001'],
  leftArm: ['DEF-shoulder.L'],
  rightArm: ['DEF-shoulder.R'],
  lowerBody: ['DEF-thigh.L', 'DEF-thigh.R'],
} as const;

export type RotationMap = Map<string, Quaternion>;

export function cloneRotations(src: RotationMap): RotationMap {
  return new Map([...src].map(([k, q]) => [k, q.clone()]));
}

const ID = new Quaternion();

/**
 * Layer blend on local rotations. Override: out = slerp(base, layer, w).
 * Additive: out = base · slerp(I, ref⁻¹ · layer, w) — only the layer's *change* from its reference pose is added.
 * Bones outside `mask` keep the base rotation.
 */
export function blendLayer(base: RotationMap, layer: RotationMap, mask: Set<string> | null, weight: number, mode: BlendMode, reference?: RotationMap): RotationMap {
  const w = Math.min(1, Math.max(0, weight));
  const out = cloneRotations(base);
  for (const [bone, q] of layer) {
    if (mask && !mask.has(bone)) continue;
    const b = out.get(bone);
    if (!b) continue;
    if (mode === 'override') b.slerp(q, w).normalize();
    else {
      const ref = reference?.get(bone) ?? ID;
      const delta = ref.clone().invert().multiply(q);
      b.multiply(new Quaternion().slerp(delta, w)).normalize();
    }
  }
  return out;
}

/** Smoothstep crossfade weight for a transition starting at `start` lasting `duration` seconds. */
export function crossfadeWeight(t: number, start: number, duration: number) {
  if (duration <= 0) return t >= start ? 1 : 0;
  const x = Math.min(1, Math.max(0, (t - start) / duration));
  return x * x * (3 - 2 * x);
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const D2R = Math.PI / 180;
const q = (axis: Vector3, deg: number) => new Quaternion().setFromAxisAngle(axis, deg * D2R);

/** Procedural upper-body pose modifiers, applied in model space on top of the current pose. */
export const PROCEDURAL_LAYERS: Record<string, (actor: LabActor, t: number) => void> = {
  'Wave (procedural)': (actor, t) => {
    rotateBoneInModel(actor, 'DEF-upper_arm.R', q(Z, -75).multiply(q(Y, 20)));
    const fk = actor.fk();
    rotateBoneInModel(actor, 'DEF-forearm.R', q(Z, -35 + Math.sin(t * Math.PI * 2 * 1.6) * 28), fk);
  },
  'Raised arm (procedural)': (actor) => {
    rotateBoneInModel(actor, 'DEF-upper_arm.L', q(Z, 80));
  },
  'Look left (procedural)': (actor) => {
    rotateBoneInModel(actor, 'DEF-neck', q(Y, 25));
    rotateBoneInModel(actor, 'DEF-head', q(Y, 30));
  },
  'Bent torso (procedural)': (actor) => {
    rotateBoneInModel(actor, 'DEF-spine.002', q(X, 18));
    rotateBoneInModel(actor, 'DEF-spine.003', q(X, 14));
  },
  'Nervous shoulders (procedural)': (actor, t) => {
    const s = Math.sin(t * Math.PI * 2 * 2.2);
    rotateBoneInModel(actor, 'DEF-shoulder.L', q(Z, 7 * Math.max(0, s)));
    rotateBoneInModel(actor, 'DEF-shoulder.R', q(Z, -7 * Math.max(0, -s)));
    rotateBoneInModel(actor, 'DEF-head', q(Y, Math.sin(t * 2.9) * 12));
  },
};
