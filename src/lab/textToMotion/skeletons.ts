import { BONES } from '../../rig/rigSpec';
import type { SourceSkeleton } from './retarget';

/** ARDY Core27 joint -> mannequin bone. Spine2 is folded into Spine3 (the mannequin has one spine bone fewer). */
export const CORE27_MAPPING: Readonly<Record<string, string>> = {
  Hips: BONES.hips,
  Spine: BONES.spine1,
  Spine1: BONES.spine2,
  Spine3: BONES.spine3,
  Neck: BONES.neck,
  Head: BONES.head,
  LeftShoulder: BONES.shoulderL,
  LeftArm: BONES.upperArmL,
  LeftForeArm: BONES.forearmL,
  LeftHand: BONES.handL,
  RightShoulder: BONES.shoulderR,
  RightArm: BONES.upperArmR,
  RightForeArm: BONES.forearmR,
  RightHand: BONES.handR,
  LeftUpLeg: BONES.thighL,
  LeftLeg: BONES.shinL,
  LeftFoot: BONES.footL,
  LeftToeBase: BONES.toeL,
  RightUpLeg: BONES.thighR,
  RightLeg: BONES.shinR,
  RightFoot: BONES.footR,
  RightToeBase: BONES.toeR,
};

/** SOMA (Kimodo) joint -> mannequin bone. Chest is the SOMA bone above Spine2; Neck2 folds into Neck1. */
export const SOMA_MAPPING: Readonly<Record<string, string>> = {
  Hips: BONES.hips,
  Spine1: BONES.spine1,
  Spine2: BONES.spine2,
  Chest: BONES.spine3,
  Neck1: BONES.neck,
  Head: BONES.head,
  LeftShoulder: BONES.shoulderL,
  LeftArm: BONES.upperArmL,
  LeftForeArm: BONES.forearmL,
  LeftHand: BONES.handL,
  RightShoulder: BONES.shoulderR,
  RightArm: BONES.upperArmR,
  RightForeArm: BONES.forearmR,
  RightHand: BONES.handR,
  LeftLeg: BONES.thighL,
  LeftShin: BONES.shinL,
  LeftFoot: BONES.footL,
  LeftToeBase: BONES.toeL,
  RightLeg: BONES.thighR,
  RightShin: BONES.shinR,
  RightFoot: BONES.footR,
  RightToeBase: BONES.toeR,
};

export function core27Skeleton(jointNames: readonly string[], parents: readonly number[], neutral: readonly (readonly [number, number, number])[]): SourceSkeleton {
  return { id: 'ardy-core27', jointNames, parents, restPositions: neutral, mapping: CORE27_MAPPING, hipsJoint: 'Hips', noAlign: ['LeftShoulder', 'RightShoulder'] };
}
