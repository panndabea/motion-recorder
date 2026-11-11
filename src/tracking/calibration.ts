import { Quaternion } from 'three';
import { forwardKinematics, type RigDefinition } from '../rig/rigDefinition';
import { rigLandmarks } from '../rig/landmarkModel';
import { identityCalibration, segmentFrames, type CalibrationData } from '../rig/retargeting';
import { LM, type BodyFrame } from './landmarks';

export type CalibrationPhase = 'waiting' | 'holding' | 'done';

export interface CalibrationStatus {
  phase: CalibrationPhase;
  /** 0..1 progress of the hold-still phase. */
  progress: number;
  message: string;
  missing: string[];
}

export interface CalibrationOptions {
  holdSeconds: number;
  minVisibility: number;
  /** Max torso rotation (deg) from the running mean while holding still. */
  maxDeviationDeg: number;
}

const REQUIRED: Array<[number, string]> = [
  [LM.leftShoulder, 'left shoulder'],
  [LM.rightShoulder, 'right shoulder'],
  [LM.leftHip, 'left hip'],
  [LM.rightHip, 'right hip'],
  [LM.nose, 'head'],
];
const LEGS: Array<[number, string]> = [
  [LM.leftKnee, 'left knee'],
  [LM.rightKnee, 'right knee'],
  [LM.leftAnkle, 'left ankle'],
  [LM.rightAnkle, 'right ankle'],
];

function averageQuaternion(qs: Quaternion[]): Quaternion {
  // Normalised sum in a common hemisphere: accurate for the small spreads accepted here.
  const ref = qs[0];
  let x = 0, y = 0, z = 0, w = 0;
  for (const q of qs) {
    const s = q.dot(ref) < 0 ? -1 : 1;
    x += q.x * s; y += q.y * s; z += q.z * s; w += q.w * s;
  }
  return new Quaternion(x, y, z, w).normalize();
}

/**
 * Establishes the neutral mapping: the user stands upright facing the camera (arms relaxed or in A/T-pose)
 * and holds still. The averaged torso orientation becomes the mannequin's rest orientation, which removes
 * camera tilt and the user's yaw relative to the camera; residual chest/head offsets are stored too.
 */
export class Calibrator {
  private readonly rest: ReturnType<typeof segmentFrames>;
  private samples: Array<{ t: number; hips: Quaternion; chest: Quaternion; head: Quaternion; legs: boolean }> = [];
  readonly options: CalibrationOptions;

  constructor(def: RigDefinition, options: Partial<CalibrationOptions> = {}) {
    this.options = { holdSeconds: 1.5, minVisibility: 0.65, maxDeviationDeg: 7, ...options };
    const fk = forwardKinematics(def);
    this.rest = segmentFrames(rigLandmarks(fk, fk));
  }

  reset() {
    this.samples = [];
  }

  /** Feeds one (unfiltered or filtered) body frame. Returns the status and, when done, the calibration. */
  addFrame(frame: BodyFrame): { status: CalibrationStatus; result?: CalibrationData } {
    const o = this.options;
    const missing = REQUIRED.filter(([i]) => (frame.visibility[i] ?? 0) < o.minVisibility).map(([, n]) => n);
    if (missing.length > 0) {
      this.samples = [];
      return {
        status: { phase: 'waiting', progress: 0, missing, message: `Step back so the camera sees your ${missing.join(', ')}.` },
      };
    }
    const legs = LEGS.every(([i]) => (frame.visibility[i] ?? 0) >= o.minVisibility);
    const f = segmentFrames(frame.points);
    const sample = { t: frame.timestamp, ...f, legs };

    if (this.samples.length > 0) {
      const mean = averageQuaternion(this.samples.map((s) => s.hips));
      const meanChest = averageQuaternion(this.samples.map((s) => s.chest));
      const dev = Math.max(mean.angleTo(f.hips), meanChest.angleTo(f.chest)) * (180 / Math.PI);
      if (dev > o.maxDeviationDeg) this.samples = [];
    }
    this.samples.push(sample);
    const held = (frame.timestamp - this.samples[0].t) / 1000;
    const progress = Math.min(1, held / o.holdSeconds);
    const legNote = legs ? '' : ' Legs not fully visible: legs will stay in rest pose.';
    if (progress < 1) {
      return {
        status: { phase: 'holding', progress, missing: [], message: `Stand upright facing the camera and hold still…${legNote}` },
      };
    }

    const hips = averageQuaternion(this.samples.map((s) => s.hips));
    const chest = averageQuaternion(this.samples.map((s) => s.chest));
    const head = averageQuaternion(this.samples.map((s) => s.head));
    const legsTracked = this.samples.filter((s) => s.legs).length >= this.samples.length * 0.8;
    const result = calibrationFromFrames(this.rest, { hips, chest, head }, legsTracked);
    this.samples = [];
    return {
      status: { phase: 'done', progress: 1, missing: [], message: legsTracked ? 'Calibrated (full body).' : 'Calibrated (upper body only).' },
      result,
    };
  }
}

export function calibrationFromFrames(
  rest: ReturnType<typeof segmentFrames>,
  measured: ReturnType<typeof segmentFrames>,
  legsTracked: boolean,
): CalibrationData {
  const c = identityCalibration();
  // correction * measured.hips = rest.hips
  c.correction = rest.hips.clone().multiply(measured.hips.clone().invert());
  const dOf = (m: Quaternion, r: Quaternion) => c.correction.clone().multiply(m).multiply(r.clone().invert());
  const dHips = dOf(measured.hips, rest.hips);
  const dChest = dOf(measured.chest, rest.chest);
  const dHead = dOf(measured.head, rest.head);
  c.chestOffset = dHips.clone().invert().multiply(dChest);
  const dChestCorrected = dChest.clone().multiply(c.chestOffset.clone().invert());
  c.headOffset = dChestCorrected.clone().invert().multiply(dHead);
  c.legsTracked = legsTracked;
  return c;
}

export function serializeCalibration(c: CalibrationData) {
  return {
    correction: c.correction.toArray(),
    chestOffset: c.chestOffset.toArray(),
    headOffset: c.headOffset.toArray(),
    legsTracked: c.legsTracked,
  };
}

