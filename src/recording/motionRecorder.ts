import { Quaternion, Vector3 } from 'three';
import type { LocalPose, RigDefinition } from '../rig/rigDefinition';
import { MOTION_FORMAT, MOTION_VERSION, rigInfo, type MotionData, type MotionMeta, type MotionTrack } from './motionFormat';

interface Sample {
  /** Seconds since recording start. */
  t: number;
  rotations: Float32Array;
  translations: Float32Array;
}

export interface BakeOptions {
  name: string;
  fps?: number;
  rig: RigDefinition;
  rawHeight: number;
  meta: MotionMeta;
  /** Decimal places stored in the file. */
  precision?: number;
}

/**
 * Captures the final retargeted pose every rendered frame (timestamps as they arrive) and bakes
 * the samples onto a uniform time base, so dropped/irregular frames do not distort timing.
 */
export class MotionRecorder {
  private samples: Sample[] = [];
  private startTime: number | null = null;
  private recording = false;

  constructor(
    readonly rotationBones: readonly string[],
    readonly translationBones: readonly string[],
  ) {}

  get isRecording() {
    return this.recording;
  }

  get sampleCount() {
    return this.samples.length;
  }

  /** Elapsed recording time in seconds for a given clock value (ms). */
  elapsed(nowMs: number) {
    return this.startTime === null ? 0 : (nowMs - this.startTime) / 1000;
  }

  start(nowMs: number) {
    this.samples = [];
    this.startTime = nowMs;
    this.recording = true;
  }

  addSample(nowMs: number, pose: LocalPose) {
    if (!this.recording || this.startTime === null) return;
    const t = (nowMs - this.startTime) / 1000;
    if (this.samples.length && t <= this.samples[this.samples.length - 1].t) return;
    const rotations = new Float32Array(this.rotationBones.length * 4);
    this.rotationBones.forEach((b, i) => {
      const q = pose.rotations.get(b);
      if (!q) throw new Error(`Pose is missing rotation for ${b}`);
      rotations.set([q.x, q.y, q.z, q.w], i * 4);
    });
    const translations = new Float32Array(this.translationBones.length * 3);
    this.translationBones.forEach((b, i) => {
      const p = pose.translations.get(b);
      if (!p) throw new Error(`Pose is missing translation for ${b}`);
      translations.set([p.x, p.y, p.z], i * 3);
    });
    this.samples.push({ t, rotations, translations });
  }

  /** Stops and returns the baked motion, or null if nothing usable was captured. */
  stop(options: BakeOptions): MotionData | null {
    this.recording = false;
    const samples = this.samples;
    this.samples = [];
    this.startTime = null;
    if (samples.length < 2) return null;
    return bakeSamples(samples, this.rotationBones, this.translationBones, options);
  }
}

function round(v: number, precision: number) {
  const f = 10 ** precision;
  return Math.round(v * f) / f || 0;
}

export function bakeSamples(
  samples: Sample[],
  rotationBones: readonly string[],
  translationBones: readonly string[],
  options: BakeOptions,
): MotionData {
  const fps = options.fps ?? 30;
  const precision = options.precision ?? 6;
  const t0 = samples[0].t;
  const last = samples[samples.length - 1].t - t0;
  const frameCount = Math.max(2, Math.floor(last * fps + 1e-6) + 1);
  const duration = (frameCount - 1) / fps;
  const times = Array.from({ length: frameCount }, (_, i) => round(i / fps, 6));

  // Bracketing sample for each output frame.
  const brackets: Array<[number, number, number]> = [];
  let j = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = t0 + i / fps;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    brackets.push([j, Math.min(j + 1, samples.length - 1), alpha]);
  }

  const tracks: MotionTrack[] = [];
  const qa = new Quaternion();
  const qb = new Quaternion();
  rotationBones.forEach((bone, bi) => {
    const values: number[][] = [];
    let prev: Quaternion | null = null;
    for (const [ia, ib, alpha] of brackets) {
      qa.fromArray(samples[ia].rotations, bi * 4);
      qb.fromArray(samples[ib].rotations, bi * 4);
      const q = qa.clone().slerp(qb, alpha).normalize();
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev = q;
      values.push([q.x, q.y, q.z, q.w].map((v) => round(v, precision)));
    }
    tracks.push({ bone, property: 'rotation', times: [...times], values });
  });
  const va = new Vector3();
  const vb = new Vector3();
  translationBones.forEach((bone, bi) => {
    const values = brackets.map(([ia, ib, alpha]) => {
      va.fromArray(samples[ia].translations, bi * 3);
      vb.fromArray(samples[ib].translations, bi * 3);
      return va.clone().lerp(vb, alpha).toArray().map((v) => round(v, precision));
    });
    tracks.push({ bone, property: 'translation', times: [...times], values });
  });

  return {
    format: MOTION_FORMAT,
    version: MOTION_VERSION,
    name: options.name,
    createdAt: new Date().toISOString(),
    duration: round(duration, 6),
    fps,
    frameCount,
    space: 'local',
    quaternionOrder: 'xyzw',
    interpolation: 'linear',
    rig: rigInfo(options.rig, options.rawHeight),
    tracks,
    meta: options.meta,
  };
}
