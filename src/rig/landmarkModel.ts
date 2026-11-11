import { Quaternion, Vector3 } from 'three';
import { BONES } from './rigSpec';
import type { ModelTransform } from './rigDefinition';
import { LANDMARK_COUNT, LM } from '../tracking/landmarks';

type Fk = Map<string, ModelTransform>;

interface Anchor {
  bone: string;
  /** Offset in rest model-space axes (raw units); follows the bone's rotation. */
  offset?: [number, number, number];
}

const mirror = (o: [number, number, number]): [number, number, number] => [-o[0], o[1], o[2]];

const face = (x: number, y: number, z: number): Anchor => ({ bone: BONES.head, offset: [x, y, z] });

/**
 * Where each MediaPipe landmark sits on the mannequin, expressed as a bone head plus an optional offset.
 * Used both to derive the retargeter's rest directions and to synthesise landmark sequences from clips,
 * so the two stay consistent by construction.
 */
const HEEL: [number, number, number] = [0, -0.075, -0.045];
const TOE_TIP: [number, number, number] = [0, 0, 0.075];
const ANCHORS: Anchor[] = (() => {
  const a: Anchor[] = new Array(LANDMARK_COUNT);
  a[LM.nose] = face(0, 0.11, 0.105);
  a[LM.leftEyeInner] = face(0.016, 0.14, 0.09);
  a[LM.leftEye] = face(0.032, 0.14, 0.088);
  a[LM.leftEyeOuter] = face(0.046, 0.14, 0.08);
  a[LM.rightEyeInner] = face(-0.016, 0.14, 0.09);
  a[LM.rightEye] = face(-0.032, 0.14, 0.088);
  a[LM.rightEyeOuter] = face(-0.046, 0.14, 0.08);
  a[LM.leftEar] = face(0.078, 0.12, 0.0);
  a[LM.rightEar] = face(-0.078, 0.12, 0.0);
  a[LM.mouthLeft] = face(0.025, 0.07, 0.09);
  a[LM.mouthRight] = face(-0.025, 0.07, 0.09);
  a[LM.leftShoulder] = { bone: BONES.upperArmL };
  a[LM.rightShoulder] = { bone: BONES.upperArmR };
  a[LM.leftElbow] = { bone: BONES.forearmL };
  a[LM.rightElbow] = { bone: BONES.forearmR };
  a[LM.leftWrist] = { bone: BONES.handL };
  a[LM.rightWrist] = { bone: BONES.handR };
  a[LM.leftPinky] = { bone: BONES.pinky1L };
  a[LM.rightPinky] = { bone: BONES.pinky1R };
  a[LM.leftIndex] = { bone: BONES.index1L };
  a[LM.rightIndex] = { bone: BONES.index1R };
  a[LM.leftThumb] = { bone: BONES.thumb3L };
  a[LM.rightThumb] = { bone: BONES.thumb3R };
  a[LM.leftHip] = { bone: BONES.thighL };
  a[LM.rightHip] = { bone: BONES.thighR };
  a[LM.leftKnee] = { bone: BONES.shinL };
  a[LM.rightKnee] = { bone: BONES.shinR };
  a[LM.leftAnkle] = { bone: BONES.footL };
  a[LM.rightAnkle] = { bone: BONES.footR };
  a[LM.leftHeel] = { bone: BONES.footL, offset: HEEL };
  a[LM.rightHeel] = { bone: BONES.footR, offset: mirror(HEEL) };
  a[LM.leftFootIndex] = { bone: BONES.toeL, offset: TOE_TIP };
  a[LM.rightFootIndex] = { bone: BONES.toeR, offset: mirror(TOE_TIP) };
  return a;
})();

const tmpQ = new Quaternion();
const tmpRestInv = new Quaternion();

/** Model-space positions (raw rig units) of all 33 landmarks for a posed skeleton. */
export function rigLandmarks(fk: Fk, restFk: Fk): Vector3[] {
  return ANCHORS.map(({ bone, offset }) => {
    const t = fk.get(bone);
    if (!t) throw new Error(`Rig is missing bone ${bone}`);
    const p = t.position.clone();
    if (offset) {
      const rest = restFk.get(bone)!;
      tmpRestInv.copy(rest.quaternion).invert();
      tmpQ.multiplyQuaternions(t.quaternion, tmpRestInv);
      p.add(new Vector3(...offset).applyQuaternion(tmpQ));
    }
    return p;
  });
}
