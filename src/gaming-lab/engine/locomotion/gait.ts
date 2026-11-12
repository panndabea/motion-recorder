import { Vector3 } from 'three';
import type { LabActor } from '../labActor';

export const FEET = {
  left: { foot: 'DEF-foot.L', toe: 'DEF-toe.L' },
  right: { foot: 'DEF-foot.R', toe: 'DEF-toe.R' },
} as const;

const speedCache = new WeakMap<LabActor, Map<string, number>>();

/** Model-space position of a bone for clip `clip` at time t (overwrites the actor pose). */
export function sampleBone(actor: LabActor, clip: string, t: number, bone: string) {
  actor.sampleClip(clip, t);
  return actor.fk().get(bone)!.position.clone();
}

/**
 * Natural forward speed (m/s) of an in-place locomotion clip, measured from the feet: while a foot is planted
 * (near its lowest height) it moves backwards relative to the hips exactly as fast as the body should move forward.
 */
export function estimateClipSpeed(actor: LabActor, clip: string, samples = 120): number {
  let cache = speedCache.get(actor);
  if (!cache) speedCache.set(actor, (cache = new Map()));
  const hit = cache.get(clip);
  if (hit !== undefined) return hit;
  const d = actor.sampler(clip).duration;
  const vels: number[] = [];
  const dt = d / samples;
  for (const side of [FEET.left.foot, FEET.right.foot]) {
    const pts: Vector3[] = [];
    for (let i = 0; i <= samples; i++) pts.push(sampleBone(actor, clip, i * dt, side));
    const low = Math.min(...pts.map((p) => p.y)) + 0.03 / actor.scale;
    for (let i = 0; i < samples; i++) if (pts[i].y < low && pts[i + 1].y < low) vels.push(-(pts[i + 1].z - pts[i].z) / dt);
  }
  // mean planted-foot backward velocity over the contact phase = average travel speed
  const speed = vels.length ? Math.max(0, (vels.reduce((a, b) => a + b, 0) / vels.length) * actor.scale) : 0;
  cache.set(clip, speed);
  return speed;
}

export const smoothstep = (x: number) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
