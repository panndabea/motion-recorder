import { Quaternion, Vector3 } from 'three';
import { MOTION_FORMAT, MOTION_VERSION, rigInfo, type MotionData, type MotionTrack } from '../../recording/motionFormat';
import { BONES } from '../../rig/rigSpec';
import type { Experiment, Params } from './experiment';
import { LAB_DRIVEN as DRIVEN_BONES, type LabActor } from './labActor';

export const BAKE_FPS = 30;

/**
 * Bakes what the experiment shows (technique enabled) into MotionRecorder motion data: local rotations of the
 * driven bones plus a DEF-hips translation that includes the actor's root motion (position/heading).
 */
export function bakeExperiment(exp: Experiment, actor: LabActor, params: Params, name: string, fps = BAKE_FPS): MotionData {
  const duration = exp.duration(params);
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const state = {};
  const times: number[] = [];
  const rot = new Map<string, number[][]>(DRIVEN_BONES.map((b) => [b, []]));
  const hips: number[][] = [];
  const prev = new Map<string, Quaternion>();
  const rootDef = actor.def.bones.find((b) => b.name === BONES.root)!;
  const rootRot = new Quaternion().fromArray(rootDef.rotation);
  for (let f = 0; f < frames; f++) {
    const t = Math.min(duration, f / fps);
    times.push(t);
    actor.position.set(0, 0, 0);
    actor.heading = 0;
    exp.evaluate({ actor, t, params, enabled: true, state, debug: null });
    for (const b of DRIVEN_BONES) {
      const q = actor.rot(b).clone();
      if (b === BONES.hips && actor.heading !== 0) {
        // heading about world Y, expressed in the hips' parent (root) space
        const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), actor.heading);
        q.premultiply(rootRot.clone().invert().multiply(yaw).multiply(rootRot));
      }
      const p = prev.get(b);
      if (p && p.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.set(b, q);
      rot.get(b)!.push([q.x, q.y, q.z, q.w]);
    }
    const local = actor.pose.translations.get(BONES.hips)!.clone();
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), actor.heading);
    // world offset (metres) -> model units -> root-local space
    const model = local.clone().applyQuaternion(rootRot).applyQuaternion(yaw).add(actor.position.clone().divideScalar(actor.scale));
    hips.push(model.applyQuaternion(rootRot.clone().invert()).toArray());
  }
  const tracks: MotionTrack[] = [...rot].map(([bone, values]) => ({ bone, property: 'rotation', times: [...times], values }));
  tracks.push({ bone: BONES.hips, property: 'translation', times: [...times], values: hips });
  return {
    format: MOTION_FORMAT,
    version: MOTION_VERSION,
    name,
    createdAt: new Date().toISOString(),
    duration,
    fps,
    frameCount: frames,
    space: 'local',
    quaternionOrder: 'xyzw',
    interpolation: 'linear',
    rig: rigInfo(actor.def, actor.rig.rawHeight),
    tracks,
    meta: { source: 'director', rootMotion: 'clip', app: `motion-recorder/gaming-lab/${exp.id}` },
  };
}
