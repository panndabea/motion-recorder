import { Quaternion, Vector3 } from 'three';

export interface TwoBoneInput {
  /** Model-space position of the upper bone (shoulder joint). */
  root: Vector3;
  /** Model-space rotation of the upper bone's parent. */
  parentRotation: Quaternion;
  /** Current local rotations of upper and lower bone. */
  upperLocal: Quaternion;
  lowerLocal: Quaternion;
  /** Lower bone's offset in the upper bone's space (bone length vector). */
  lowerOffset: Vector3;
  /** End effector offset in the lower bone's space (e.g. elbow -> palm). */
  effectorOffset: Vector3;
  /** Desired model-space effector position. */
  target: Vector3;
  /** Model-space hint for the bending direction of the middle joint (elbow). */
  pole: Vector3;
}

export interface TwoBoneResult {
  upperLocal: Quaternion;
  lowerLocal: Quaternion;
  /** True if the target was within reach (not clamped). */
  reached: boolean;
  /** Achieved effector position. */
  effector: Vector3;
}

const shortestArc = (from: Vector3, to: Vector3) => new Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());

/**
 * Analytic two-bone IK (law of cosines). Bone lengths are taken from the rig, so proportions are kept;
 * unreachable targets are approached as closely as the straightened limb allows.
 */
export function solveTwoBone(input: TwoBoneInput): TwoBoneResult {
  const a = input.lowerOffset.length();
  const c = input.effectorOffset.length();
  const toTarget = input.target.clone().sub(input.root);
  const dist = toTarget.length();
  const d = Math.min(Math.max(dist, Math.abs(a - c) + 1e-4), (a + c) * 0.9995);
  const dir = dist > 1e-6 ? toTarget.clone().divideScalar(dist) : new Vector3(0, -1, 0);
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - c * c) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = input.pole.clone().sub(dir.clone().multiplyScalar(input.pole.dot(dir)));
  if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).sub(dir.clone().multiplyScalar(-dir.y));
  perp.normalize();
  const elbow = input.root.clone().add(dir.clone().multiplyScalar(a * cosA)).add(perp.multiplyScalar(a * sinA));
  const goal = input.root.clone().add(dir.clone().multiplyScalar(d));

  const upperWorld = input.parentRotation.clone().multiply(input.upperLocal);
  const curLower = input.lowerOffset.clone().applyQuaternion(upperWorld);
  const newUpperWorld = shortestArc(curLower, elbow.clone().sub(input.root)).multiply(upperWorld);

  const lowerWorld = newUpperWorld.clone().multiply(input.lowerLocal);
  const curEff = input.effectorOffset.clone().applyQuaternion(lowerWorld);
  const newLowerWorld = shortestArc(curEff, goal.clone().sub(elbow)).multiply(lowerWorld);

  const upperLocal = input.parentRotation.clone().invert().multiply(newUpperWorld).normalize();
  const lowerLocal = newUpperWorld.clone().invert().multiply(newLowerWorld).normalize();
  const effector = elbow.clone().add(input.effectorOffset.clone().applyQuaternion(newLowerWorld));
  return { upperLocal, lowerLocal, reached: dist <= (a + c) * 0.9995, effector };
}
