import type { Experiment } from '../engine/experiment';
import { animationLayers } from './animationLayers';
import { gazeController } from './gazeController';
import { inverseKinematics } from './inverseKinematics';

/** Order shown in the concept explorer. */
export const EXPERIMENTS: Experiment[] = [inverseKinematics, animationLayers, gazeController];

export const PLANNED: { id: string; title: string }[] = [
  { id: 'inverse-kinematics', title: 'Inverse Kinematics' },
  { id: 'foot-locking', title: 'Foot Locking / Foot IK' },
  { id: 'motion-warping', title: 'Motion Warping' },
  { id: 'animation-layers', title: 'Animation Layers & Blending' },
  { id: 'gaze', title: 'Look-at / Gaze Controller' },
  { id: 'motion-matching', title: 'Motion Matching' },
  { id: 'secondary-motion', title: 'Procedural Secondary Motion' },
  { id: 'object-interaction', title: 'Object Interaction & Constraints' },
  { id: 'retiming', title: 'Animation Retiming / Time Warping' },
];

export function experimentById(id: string) {
  return EXPERIMENTS.find((e) => e.id === id);
}
