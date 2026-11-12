import { Quaternion, Vector3 } from 'three';
import { solveTwoBone } from '../../../director/animation/ikController';
import type { LabActor } from '../labActor';

export interface LimbChain {
  parent: string;
  upper: string;
  lower: string;
  end: string;
}

export const LIMBS = {
  armR: { parent: 'DEF-shoulder.R', upper: 'DEF-upper_arm.R', lower: 'DEF-forearm.R', end: 'DEF-hand.R' },
  armL: { parent: 'DEF-shoulder.L', upper: 'DEF-upper_arm.L', lower: 'DEF-forearm.L', end: 'DEF-hand.L' },
  legR: { parent: 'DEF-hips', upper: 'DEF-thigh.R', lower: 'DEF-shin.R', end: 'DEF-foot.R' },
  legL: { parent: 'DEF-hips', upper: 'DEF-thigh.L', lower: 'DEF-shin.L', end: 'DEF-foot.L' },
} as const satisfies Record<string, LimbChain>;

export interface LimbSolve {
  reached: boolean;
  /** Model-space positions after solving. */
  root: Vector3;
  mid: Vector3;
  end: Vector3;
  /** Upper + lower bone length (model units). */
  reach: number;
  upperLength: number;
  lowerLength: number;
}

/**
 * Analytic two-bone IK on the real mannequin chain (law of cosines, see director ikController).
 * `targetModel` and `poleModel` are model-space; `strength` slerps between FK pose and IK solution.
 */
export function solveLimb(actor: LabActor, chain: LimbChain, targetModel: Vector3, poleModel: Vector3, strength = 1): LimbSolve {
  const fk = actor.fk();
  const parent = fk.get(chain.parent)!;
  const upper = fk.get(chain.upper)!;
  const upperQ = actor.rot(chain.upper);
  const lowerQ = actor.rot(chain.lower);
  const lowerOffset = actor.pose.translations.get(chain.lower)!.clone();
  const effOffset = actor.pose.translations.get(chain.end)!.clone();
  const res = solveTwoBone({
    root: upper.position.clone(),
    parentRotation: parent.quaternion.clone(),
    upperLocal: upperQ.clone(),
    lowerLocal: lowerQ.clone(),
    lowerOffset,
    effectorOffset: effOffset,
    target: targetModel,
    pole: poleModel,
  });
  const w = Math.min(1, Math.max(0, strength));
  upperQ.slerp(res.upperLocal, w).normalize();
  lowerQ.slerp(res.lowerLocal, w).normalize();
  const after = actor.fk();
  return {
    reached: res.reached,
    root: after.get(chain.upper)!.position.clone(),
    mid: after.get(chain.lower)!.position.clone(),
    end: after.get(chain.end)!.position.clone(),
    reach: lowerOffset.length() + effOffset.length(),
    upperLength: lowerOffset.length(),
    lowerLength: effOffset.length(),
  };
}

/** Rotates `bone` (local) so that its model-space rotation is pre-multiplied by `delta` (model space). */
export function rotateBoneInModel(actor: LabActor, bone: string, delta: Quaternion, fk = actor.fk()) {
  const parentName = actor.def.bones.find((b) => b.name === bone)!.parent;
  const parentRot = parentName ? fk.get(parentName)!.quaternion : new Quaternion();
  const world = parentRot.clone().multiply(actor.rot(bone));
  actor.rot(bone).copy(parentRot.clone().invert().multiply(delta.clone().multiply(world)).normalize());
}
