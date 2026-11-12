import type { MotionData } from '../../recording/motionFormat';
import { sampleMotion } from '../../recording/motionPlayback';

/** Largest local-rotation difference (degrees) between two takes, sampled at 41 points. */
export function maxPoseDeltaDeg(a: MotionData, b: MotionData): number {
  let max = 0;
  for (let i = 0; i <= 40; i++) {
    const t = (a.duration * i) / 40;
    const pa = sampleMotion(a, t);
    const pb = sampleMotion(b, t);
    for (const [bone, q] of pa.rotations) {
      const other = pb.rotations.get(bone);
      if (other) max = Math.max(max, (q.angleTo(other) * 180) / Math.PI);
    }
  }
  return max;
}
