import { Matrix4, Quaternion, Vector3 } from 'three';

/** Rigid attachment: stores the object transform in the hand frame at grip time. */
export function attachmentOffset(handWorld: Matrix4, objectWorld: Matrix4) {
  return handWorld.clone().invert().multiply(objectWorld);
}

/** World transform of an attached object: hand(t) · offset. */
export function attachedWorld(handWorld: Matrix4, offset: Matrix4) {
  return handWorld.clone().multiply(offset);
}

/** Position/rotation (no scale) of a matrix. */
export function decompose(m: Matrix4) {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { position: p, quaternion: q };
}
