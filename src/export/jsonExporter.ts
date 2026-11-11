import type { MotionData } from '../recording/motionFormat';

export function serializeMotion(motion: MotionData): string {
  return JSON.stringify(motion);
}

export function motionFileName(motion: MotionData) {
  return `${motion.name.trim().replace(/[^\w.-]+/g, '_') || 'motion'}.motion.json`;
}
