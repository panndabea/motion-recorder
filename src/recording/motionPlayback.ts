import {
  AnimationClip,
  AnimationMixer,
  InterpolateLinear,
  LoopOnce,
  LoopRepeat,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type AnimationAction,
  type KeyframeTrack,
} from 'three';
import { toThreeName } from '../rig/rigSpec';
import { resetToRest, type MannequinRig } from '../rig/mannequinLoader';
import type { LocalPose, RigDefinition } from '../rig/rigDefinition';
import type { MotionData } from './motionFormat';

/** Builds a three.js AnimationClip that targets the mannequin bones by their (sanitised) names. */
export function motionToClip(motion: MotionData): AnimationClip {
  const tracks: KeyframeTrack[] = motion.tracks.map((t) => {
    const name = toThreeName(t.bone);
    const flat = t.values.flat();
    return t.property === 'rotation'
      ? new QuaternionKeyframeTrack(`${name}.quaternion`, t.times, flat, InterpolateLinear)
      : new VectorKeyframeTrack(`${name}.position`, t.times, flat, InterpolateLinear);
  });
  return new AnimationClip(motion.name, motion.duration, tracks);
}

/** Deterministically evaluates a motion at time t (seconds), without a mixer (linear / slerp). */
export function sampleMotion(motion: MotionData, t: number): LocalPose {
  const pose: LocalPose = { rotations: new Map(), translations: new Map() };
  for (const track of motion.tracks) {
    const { times, values } = track;
    let hi = times.findIndex((tm) => tm >= t);
    if (hi === -1) hi = times.length - 1;
    const lo = Math.max(0, times[hi] > t ? hi - 1 : hi);
    const span = times[hi] - times[lo];
    const a = span > 0 ? Math.min(1, Math.max(0, (t - times[lo]) / span)) : 0;
    if (track.property === 'rotation') {
      const q = new Quaternion().fromArray(values[lo]).slerp(new Quaternion().fromArray(values[hi]), a);
      pose.rotations.set(track.bone, q.normalize());
    } else {
      pose.translations.set(track.bone, new Vector3().fromArray(values[lo]).lerp(new Vector3().fromArray(values[hi]), a));
    }
  }
  return pose;
}

/** Converts a three.js clip (e.g. loaded from a GLB) on this rig back into motion tracks. */
export function clipToTracks(clip: AnimationClip, rig: RigDefinition): MotionData['tracks'] {
  const byThreeName = new Map(rig.bones.map((b) => [toThreeName(b.name), b.name]));
  const tracks: MotionData['tracks'] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const node = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const bone = byThreeName.get(node);
    if (!bone || (prop !== 'quaternion' && prop !== 'position')) continue;
    const width = prop === 'quaternion' ? 4 : 3;
    const times = Array.from(track.times);
    const values = times.map((_, i) => Array.from(track.values.slice(i * width, i * width + width)));
    tracks.push({ bone, property: prop === 'quaternion' ? 'rotation' : 'translation', times, values });
  }
  return tracks;
}

/**
 * Plays a motion on a mannequin through an AnimationMixer. Only this class writes bones in playback
 * mode; the engine never runs it at the same time as live retargeting.
 */
export class MotionPlayer {
  private readonly mixer: AnimationMixer;
  private action: AnimationAction | null = null;
  private clip: AnimationClip | null = null;
  private loop = true;

  constructor(private readonly rig: MannequinRig) {
    this.mixer = new AnimationMixer(rig.scene);
  }

  get loaded() {
    return this.action !== null;
  }

  get duration() {
    return this.clip?.duration ?? 0;
  }

  get time() {
    return this.action?.time ?? 0;
  }

  get playing() {
    return !!this.action && !this.action.paused && this.action.isRunning();
  }

  get finished() {
    return !!this.action && !this.loop && this.action.time >= this.duration - 1e-6;
  }

  load(motion: MotionData) {
    this.unload();
    resetToRest(this.rig);
    this.clip = motionToClip(motion);
    this.action = this.mixer.clipAction(this.clip);
    this.action.clampWhenFinished = true;
    this.setLoop(this.loop);
    this.action.play();
    this.action.paused = true;
    this.mixer.update(0);
  }

  setLoop(loop: boolean) {
    this.loop = loop;
    this.action?.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
  }

  play() {
    if (!this.action) return;
    if (this.finished) this.seek(0);
    this.action.enabled = true;
    if (!this.action.isScheduled()) this.action.play();
    this.action.paused = false;
  }

  pause() {
    if (this.action) this.action.paused = true;
  }

  restart() {
    this.seek(0);
    this.play();
  }

  seek(t: number) {
    if (!this.action || !this.clip) return;
    const time = Math.min(Math.max(t, 0), this.clip.duration);
    // Re-arm a finished LoopOnce action so seeking after the end works.
    this.action.reset();
    this.action.play();
    this.action.time = time;
    this.action.paused = true;
    this.mixer.update(0);
  }

  update(dt: number) {
    if (this.action && !this.action.paused) this.mixer.update(dt);
  }

  unload() {
    if (this.clip) {
      this.mixer.stopAllAction();
      this.mixer.uncacheClip(this.clip);
    }
    this.action = null;
    this.clip = null;
    resetToRest(this.rig);
  }
}
