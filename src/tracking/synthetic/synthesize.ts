import { AnimationMixer, type AnimationClip } from 'three';
import { forwardKinematics, type LocalPose, type ModelTransform, type RigDefinition } from '../../rig/rigDefinition';
import { rigLandmarks } from '../../rig/landmarkModel';
import { readPose, resetToRest, type MannequinRig } from '../../rig/mannequinLoader';
import { bodyToMediaPipe, LM, type PoseFrame } from '../landmarks';

/**
 * Builds a MediaPipe-style pose frame from a posed mannequin skeleton: landmarks are placed with the same
 * landmark model the retargeter uses, re-centred on the hips, scaled to metres and converted to
 * MediaPipe axes. Image coordinates are a simple orthographic projection of an unmirrored camera.
 */
export function landmarksFromPose(
  def: RigDefinition,
  pose: LocalPose,
  restFk: Map<string, ModelTransform>,
  metresPerUnit: number,
  timestamp: number,
): PoseFrame {
  const fk = forwardKinematics(def, pose);
  const pts = rigLandmarks(fk, restFk);
  const hip = pts[LM.leftHip].clone().add(pts[LM.rightHip]).multiplyScalar(0.5);
  const world = pts.map((p) => {
    const m = bodyToMediaPipe(p.clone().sub(hip).multiplyScalar(metresPerUnit));
    return { ...m, visibility: 0.99 };
  });
  // Camera framing: 2.4 m tall view centred at 0.95 m, 4:3 frame.
  const viewH = 2.4 / metresPerUnit;
  const viewW = viewH * (4 / 3);
  const image = pts.map((p) => ({
    x: 0.5 + p.x / viewW,
    y: 0.5 - (p.y - 0.95 / metresPerUnit) / viewH,
    z: -p.z / viewW,
    visibility: 0.99,
  }));
  return { timestamp, world, image };
}

/** Samples an animation clip of the mannequin into local poses at a fixed rate. */
export function sampleClip(rig: MannequinRig, clip: AnimationClip, fps: number, duration = clip.duration): LocalPose[] {
  resetToRest(rig);
  const mixer = new AnimationMixer(rig.scene);
  const action = mixer.clipAction(clip);
  action.play();
  const names = rig.definition.bones.map((b) => b.name);
  const poses: LocalPose[] = [];
  const frames = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < frames; i++) {
    mixer.setTime((i / fps) % clip.duration);
    poses.push(readPose(rig, names, names));
  }
  action.stop();
  mixer.uncacheRoot(rig.scene);
  resetToRest(rig);
  return poses;
}
