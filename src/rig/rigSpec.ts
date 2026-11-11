import { PropertyBinding } from 'three';

/** Identifier written into every motion file; recordings only apply to this rig. */
export const RIG_ID = 'quaternius-ual-mannequin';
export const RIG_DISPLAY_NAME = 'Quaternius Universal Animation Library – Mannequin (CC0)';

export const MANNEQUIN_URL = `${import.meta.env?.BASE_URL ?? '/'}models/mannequin.glb`;

/** The raw asset is ~1.83 units tall; the viewport scales it to this height (metres). */
export const TARGET_HEIGHT = 1.75;

/** three.js strips `.`, `:`, `/`, `[`, `]` from node names (e.g. `DEF-spine.001` -> `DEF-spine001`). */
export function toThreeName(gltfName: string): string {
  return PropertyBinding.sanitizeNodeName(gltfName);
}

/** Original glTF node names of the bones the retargeter drives. */
export const BONES = {
  root: 'root',
  hips: 'DEF-hips',
  spine1: 'DEF-spine.001',
  spine2: 'DEF-spine.002',
  spine3: 'DEF-spine.003',
  neck: 'DEF-neck',
  head: 'DEF-head',
  shoulderL: 'DEF-shoulder.L',
  upperArmL: 'DEF-upper_arm.L',
  forearmL: 'DEF-forearm.L',
  handL: 'DEF-hand.L',
  shoulderR: 'DEF-shoulder.R',
  upperArmR: 'DEF-upper_arm.R',
  forearmR: 'DEF-forearm.R',
  handR: 'DEF-hand.R',
  thighL: 'DEF-thigh.L',
  shinL: 'DEF-shin.L',
  footL: 'DEF-foot.L',
  toeL: 'DEF-toe.L',
  thighR: 'DEF-thigh.R',
  shinR: 'DEF-shin.R',
  footR: 'DEF-foot.R',
  toeR: 'DEF-toe.R',
  pinky1L: 'DEF-f_pinky.01.L',
  index1L: 'DEF-f_index.01.L',
  thumb3L: 'DEF-thumb.03.L',
  pinky1R: 'DEF-f_pinky.01.R',
  index1R: 'DEF-f_index.01.R',
  thumb3R: 'DEF-thumb.03.R',
} as const;

/** Bones whose local rotation is written by the retargeter and stored in recordings. */
export const DRIVEN_BONES: readonly string[] = [
  BONES.hips,
  BONES.spine1,
  BONES.spine2,
  BONES.spine3,
  BONES.neck,
  BONES.head,
  BONES.upperArmL,
  BONES.forearmL,
  BONES.handL,
  BONES.upperArmR,
  BONES.forearmR,
  BONES.handR,
  BONES.thighL,
  BONES.shinL,
  BONES.footL,
  BONES.thighR,
  BONES.shinR,
  BONES.footR,
];

/** Bone that receives the (vertical, grounded) root translation track. */
export const ROOT_MOTION_BONE = BONES.hips;
