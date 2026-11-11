import { Quaternion } from 'three';
import { rigSignature, type BoneDef, type RigDefinition } from '../rig/rigDefinition';

export const MOTION_FORMAT = 'motion-recorder';
export const MOTION_VERSION = 1;

export type TrackProperty = 'rotation' | 'translation';

export interface MotionTrack {
  /** Original glTF node name of the bone, e.g. `DEF-upper_arm.L`. */
  bone: string;
  /** `rotation`: local quaternion [x, y, z, w]; `translation`: local position [x, y, z] in rig units. */
  property: TrackProperty;
  /** Seconds from clip start, strictly increasing. */
  times: number[];
  values: number[][];
}

export interface MotionRigInfo {
  id: string;
  /** FNV-1a hash of bone names + parent links (see rigSignature). */
  signature: string;
  boneCount: number;
  upAxis: '+Y';
  forwardAxis: '+Z';
  /** Values are in the rig's own node units (unscaled glTF units). */
  units: 'rig';
  rawHeight: number;
  /** Rest local transforms of every bone, so a consumer can reconstruct untracked bones. */
  bones: BoneDef[];
}

export interface MotionMeta {
  source: 'webcam' | 'synthetic' | 'glb-import' | 'unknown';
  /** `vertical-grounded`: hips translation only compensates for leg bending (no horizontal root motion). */
  rootMotion: 'none' | 'vertical-grounded' | 'clip';
  calibration?: unknown;
  app?: string;
}

export interface MotionData {
  format: typeof MOTION_FORMAT;
  version: number;
  name: string;
  createdAt: string;
  duration: number;
  fps: number;
  frameCount: number;
  /** Rotations/translations are local to the parent bone (same convention as glTF animation channels). */
  space: 'local';
  quaternionOrder: 'xyzw';
  interpolation: 'linear';
  rig: MotionRigInfo;
  tracks: MotionTrack[];
  meta: MotionMeta;
}

export function rigInfo(def: RigDefinition, rawHeight: number): MotionRigInfo {
  return {
    id: def.id,
    signature: rigSignature(def),
    boneCount: def.bones.length,
    upAxis: '+Y',
    forwardAxis: '+Z',
    units: 'rig',
    rawHeight,
    bones: def.bones.map((b) => ({ ...b, translation: [...b.translation], rotation: [...b.rotation], scale: [...b.scale] })),
  };
}

export const LIMITS = {
  maxTracks: 512,
  maxKeysPerTrack: 200_000,
  maxDuration: 60 * 60,
  maxNameLength: 200,
};

export type ValidationResult =
  | { ok: true; motion: MotionData; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validates untrusted motion data (parsed JSON) against the schema and, if given, the loaded rig.
 * Returns a normalised copy: quaternions re-normalised and hemisphere-aligned, unknown fields dropped.
 */
export function validateMotion(input: unknown, rig?: RigDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): ValidationResult => ({ ok: false, errors, warnings });
  if (!isObj(input)) {
    errors.push('File is not a JSON object.');
    return fail();
  }
  if (input.format !== MOTION_FORMAT) errors.push(`Unknown format "${String(input.format)}" (expected "${MOTION_FORMAT}").`);
  if (!isNum(input.version) || !Number.isInteger(input.version)) errors.push('Missing or invalid schema version.');
  else if (input.version > MOTION_VERSION) errors.push(`Schema version ${input.version} is newer than supported (${MOTION_VERSION}).`);
  else if (input.version < 1) errors.push(`Unsupported schema version ${input.version}.`);
  if (errors.length) return fail();

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, LIMITS.maxNameLength) : 'Imported motion';
  if (!isNum(input.duration) || input.duration < 0 || input.duration > LIMITS.maxDuration) errors.push('Invalid duration.');
  const fps = isNum(input.fps) && input.fps > 0 && input.fps <= 1000 ? input.fps : 30;
  if (input.space !== undefined && input.space !== 'local') errors.push(`Unsupported transform space "${String(input.space)}".`);
  if (input.quaternionOrder !== undefined && input.quaternionOrder !== 'xyzw') errors.push('Unsupported quaternion order.');

  // Rig compatibility.
  const r = input.rig;
  if (!isObj(r)) errors.push('Missing rig metadata.');
  else {
    if (r.id !== (rig?.id ?? r.id)) errors.push(`Recording is for rig "${String(r.id)}", but the loaded character is "${rig!.id}".`);
    if (rig && typeof r.signature === 'string' && r.signature !== rigSignature(rig)) {
      errors.push('Skeleton hierarchy in the file does not match the loaded mannequin.');
    }
  }
  if (!Array.isArray(input.tracks)) errors.push('Missing tracks array.');
  if (errors.length) return fail();

  const duration = input.duration as number;
  const rawTracks = input.tracks as unknown[];
  if (rawTracks.length > LIMITS.maxTracks) {
    errors.push(`Too many tracks (${rawTracks.length}).`);
    return fail();
  }
  const known = rig ? new Set(rig.bones.map((b) => b.name)) : null;
  const seen = new Set<string>();
  const tracks: MotionTrack[] = [];
  rawTracks.forEach((t, ti) => {
    const where = `Track ${ti}`;
    if (!isObj(t)) return void errors.push(`${where}: not an object.`);
    const bone = t.bone;
    const property = t.property;
    if (typeof bone !== 'string') return void errors.push(`${where}: missing bone name.`);
    if (property !== 'rotation' && property !== 'translation') return void errors.push(`${where} (${bone}): unknown property "${String(property)}".`);
    if (known && !known.has(bone)) return void warnings.push(`${where}: bone "${bone}" does not exist on the mannequin and was skipped.`);
    const key = `${bone}/${property}`;
    if (seen.has(key)) return void errors.push(`${where}: duplicate ${property} track for ${bone}.`);
    seen.add(key);
    const times = t.times;
    const values = t.values;
    if (!Array.isArray(times) || !Array.isArray(values)) return void errors.push(`${where} (${bone}): times/values must be arrays.`);
    if (times.length === 0) return void errors.push(`${where} (${bone}): no keyframes.`);
    if (times.length > LIMITS.maxKeysPerTrack) return void errors.push(`${where} (${bone}): too many keyframes.`);
    if (times.length !== values.length) return void errors.push(`${where} (${bone}): ${times.length} times but ${values.length} values.`);
    for (let i = 0; i < times.length; i++) {
      const tm = times[i];
      if (!isNum(tm) || tm < 0) return void errors.push(`${where} (${bone}): invalid time at key ${i}.`);
      if (i > 0 && tm <= (times[i - 1] as number)) return void errors.push(`${where} (${bone}): times must be strictly increasing (key ${i}).`);
      if (tm > duration + 1e-3) return void errors.push(`${where} (${bone}): key ${i} at ${tm}s is beyond the duration ${duration}s.`);
    }
    const width = property === 'rotation' ? 4 : 3;
    const out: number[][] = [];
    let prev: Quaternion | null = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Array.isArray(v) || v.length !== width || !v.every(isNum)) {
        return void errors.push(`${where} (${bone}): value ${i} must be ${width} finite numbers.`);
      }
      if (property === 'rotation') {
        const q = new Quaternion(v[0], v[1], v[2], v[3]);
        const len = q.length();
        if (len < 0.9 || len > 1.1) return void errors.push(`${where} (${bone}): quaternion ${i} is not unit length (|q| = ${len.toFixed(3)}).`);
        // Only renormalise when needed so that files written by this app round-trip bit-exactly.
        if (Math.abs(len - 1) > 1e-5) q.normalize();
        const flip = prev !== null && prev.dot(q) < 0;
        if (flip) q.set(-q.x, -q.y, -q.z, -q.w);
        prev = q;
        out.push(flip || Math.abs(len - 1) > 1e-5 ? [q.x, q.y, q.z, q.w] : [...(v as number[])]);
      } else out.push([...(v as number[])]);
    }
    tracks.push({ bone, property, times: [...(times as number[])], values: out });
  });
  if (errors.length) return fail();
  if (tracks.length === 0) {
    errors.push('No usable tracks for this mannequin.');
    return fail();
  }

  const rigIn = input.rig as Record<string, unknown>;
  const meta = isObj(input.meta) ? input.meta : {};
  const motion: MotionData = {
    format: MOTION_FORMAT,
    version: MOTION_VERSION,
    name,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    duration,
    fps,
    frameCount: isNum(input.frameCount) ? Math.round(input.frameCount) : Math.round(duration * fps) + 1,
    space: 'local',
    quaternionOrder: 'xyzw',
    interpolation: 'linear',
    rig: rig
      ? rigInfo(rig, isNum(rigIn.rawHeight) ? rigIn.rawHeight : 0)
      : (rigIn as unknown as MotionRigInfo),
    tracks,
    meta: {
      source: (['webcam', 'synthetic', 'glb-import'] as const).find((s) => s === meta.source) ?? 'unknown',
      rootMotion: (['none', 'vertical-grounded', 'clip'] as const).find((s) => s === meta.rootMotion) ?? 'none',
      calibration: meta.calibration,
      app: typeof meta.app === 'string' ? meta.app : undefined,
    },
  };
  return { ok: true, motion, warnings };
}
