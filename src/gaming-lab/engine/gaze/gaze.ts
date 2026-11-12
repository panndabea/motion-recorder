import { Quaternion, Vector3 } from 'three';
import { rotateBoneInModel } from '../ik/twoBone';
import type { LabActor } from '../labActor';

export interface GazeJoint {
  bone: string;
  /** Share of the yaw/pitch this joint takes (relative weight). */
  weight: number;
}

export interface GazeLimits {
  /** Max total horizontal angle (rad) of the whole chain. */
  maxYaw: number;
  maxPitch: number;
}

const D2R = Math.PI / 180;
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

/** Yaw/pitch (rad) of a model-space direction relative to the mannequin's forward (+Z). */
export function yawPitch(dir: Vector3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(dir.x, dir.z), pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) };
}

export function clampAngles(yaw: number, pitch: number, limits: GazeLimits) {
  return {
    yaw: Math.max(-limits.maxYaw, Math.min(limits.maxYaw, yaw)),
    pitch: Math.max(-limits.maxPitch, Math.min(limits.maxPitch, pitch)),
  };
}

/**
 * Deterministic smoothing: re-simulates a rate-limited, exponentially smoothed follower from t = 0
 * at a fixed step, so the result depends only on t (scrubbing and split-screen agree).
 */
export function simulateFollower(target: (t: number) => { yaw: number; pitch: number }, t: number, smoothing: number, maxSpeedDeg: number, dt = 1 / 60) {
  let { yaw, pitch } = target(0);
  const steps = Math.floor(t / dt);
  const alpha = smoothing <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(1e-3, smoothing));
  const maxStep = maxSpeedDeg * D2R * dt;
  for (let i = 1; i <= steps + 1; i++) {
    const time = Math.min(t, i * dt);
    const goal = target(time);
    const step = i <= steps ? 1 : (t - steps * dt) / dt;
    const lim = maxStep * step;
    const dy = Math.max(-lim, Math.min(lim, (goal.yaw - yaw) * alpha));
    const dp = Math.max(-lim, Math.min(lim, (goal.pitch - pitch) * alpha));
    yaw += dy;
    pitch += dp;
  }
  return { yaw, pitch };
}

/**
 * Distributes yaw/pitch over the chain (torso → neck → head). Each joint gets weight/Σweight of the
 * total, applied as a model-space delta Ry(yaw·w)·Rx(−pitch·w) pre-multiplied onto its current world rotation.
 */
export function applyGaze(actor: LabActor, joints: GazeJoint[], yaw: number, pitch: number) {
  const total = joints.reduce((s, j) => s + Math.max(0, j.weight), 0);
  if (total <= 0) return;
  for (const j of joints) {
    const w = Math.max(0, j.weight) / total;
    if (w === 0) continue;
    const delta = new Quaternion().setFromAxisAngle(Y, yaw * w).multiply(new Quaternion().setFromAxisAngle(X, -pitch * w));
    rotateBoneInModel(actor, j.bone, delta);
  }
}

/** Head forward in model space: the rest-pose forward (+Z) carried by the head's rotation change from rest. */
export function headForward(actor: LabActor, head = 'DEF-head') {
  const cur = actor.fk().get(head)!.quaternion;
  const rest = actor.restFk().get(head)!.quaternion;
  return new Vector3(0, 0, 1).applyQuaternion(cur.clone().multiply(rest.clone().invert())).normalize();
}
