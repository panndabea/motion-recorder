import { Quaternion } from 'three';
import type { RigDefinition } from '../../rig/rigDefinition';
import { BONES } from '../../rig/rigSpec';
import { MOTION_FORMAT, MOTION_VERSION, rigInfo, type MotionData, type MotionTrack } from '../../recording/motionFormat';
import type { Performance } from './motionComposer';

export const BAKE_FPS = 30;

/**
 * Samples the performance at a fixed rate into MotionRecorder-compatible local tracks (all bones, root motion on
 * the `root` bone). The result plays back in MotionRecorder and exports through the existing GLB pipeline.
 */
export function bakeActorMotion(perf: Performance, def: RigDefinition, rawHeight: number, name: string, fps = BAKE_FPS): MotionData {
  const frames = Math.max(2, Math.round(perf.duration * fps) + 1);
  const times = Array.from({ length: frames }, (_, i) => Math.min(perf.duration, i / fps));
  if (times[frames - 1] < perf.duration) times[frames - 1] = perf.duration;
  const rot = new Map<string, number[][]>();
  const tr = new Map<string, number[][]>();
  const prev = new Map<string, Quaternion>();
  for (const t of times) {
    const { pose } = perf.evaluate(t);
    for (const b of def.bones) {
      const q = pose.rotations.get(b.name)?.clone() ?? new Quaternion().fromArray(b.rotation);
      const p = prev.get(b.name);
      if (p && p.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.set(b.name, q);
      if (!rot.has(b.name)) rot.set(b.name, []);
      rot.get(b.name)!.push([q.x, q.y, q.z, q.w]);
    }
    for (const n of [BONES.root, BONES.hips]) {
      const v = pose.translations.get(n);
      const rest = def.bones.find((b) => b.name === n)!.translation;
      if (!tr.has(n)) tr.set(n, []);
      tr.get(n)!.push(v ? [v.x, v.y, v.z] : [...rest]);
    }
  }
  const tracks: MotionTrack[] = [];
  for (const [bone, values] of rot) tracks.push({ bone, property: 'rotation', times: [...times], values });
  for (const [bone, values] of tr) tracks.push({ bone, property: 'translation', times: [...times], values });
  return {
    format: MOTION_FORMAT,
    version: MOTION_VERSION,
    name,
    createdAt: new Date().toISOString(),
    duration: perf.duration,
    fps,
    frameCount: frames,
    space: 'local',
    quaternionOrder: 'xyzw',
    interpolation: 'linear',
    rig: rigInfo(def, rawHeight),
    tracks,
    meta: { source: 'director', rootMotion: 'clip', app: 'AI Director Studio' },
  };
}

export interface ObjectTrack {
  id: string;
  times: number[];
  positions: [number, number, number][];
  yaws: number[];
}

/** Samples the glass transform (world) at the bake rate. */
export function bakeGlass(perf: Performance, fps = BAKE_FPS): ObjectTrack {
  const frames = Math.max(2, Math.round(perf.duration * fps) + 1);
  const out: ObjectTrack = { id: 'glass', times: [], positions: [], yaws: [] };
  for (let i = 0; i < frames; i++) {
    const t = i === frames - 1 ? perf.duration : Math.min(perf.duration, i / fps);
    const f = perf.evaluate(t);
    out.times.push(t);
    out.positions.push([...f.glass.position]);
    out.yaws.push(f.glass.yaw);
  }
  return out;
}
