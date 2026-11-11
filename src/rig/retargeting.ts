import { Matrix4, Quaternion, Vector3 } from 'three';
import { BONES, DRIVEN_BONES, ROOT_MOTION_BONE } from './rigSpec';
import {
  boneIndexMap,
  forwardKinematics,
  type BoneDef,
  type LocalPose,
  type ModelTransform,
  type RigDefinition,
} from './rigDefinition';
import { rigLandmarks } from './landmarkModel';
import { LM, type BodyFrame } from '../tracking/landmarks';

/** Neutral mapping captured during calibration (see tracking/calibration.ts). */
export interface CalibrationData {
  /** Rotation applied to every body-space vector so the calibration torso matches the rest torso. */
  correction: Quaternion;
  /** Residual chest/head misalignment (relative to their parent segment) at calibration time. */
  chestOffset: Quaternion;
  headOffset: Quaternion;
  legsTracked: boolean;
}

export function identityCalibration(): CalibrationData {
  return {
    correction: new Quaternion(),
    chestOffset: new Quaternion(),
    headOffset: new Quaternion(),
    legsTracked: true,
  };
}

export interface RetargetOptions {
  /** Minimum MediaPipe visibility for a landmark to drive a bone. */
  minVisibility: number;
  /** Seconds a lost bone holds its last pose before blending towards rest. */
  holdTime: number;
  /** Time constant (s) of the blend towards rest for lost bones. */
  releaseTau: number;
  /** Keep the lowest foot point on the floor by translating the hips vertically. */
  grounding: boolean;
}

export const DEFAULT_RETARGET_OPTIONS: RetargetOptions = {
  minVisibility: 0.5,
  holdTime: 0.6,
  releaseTau: 0.6,
  grounding: true,
};

export interface RetargetResult extends LocalPose {
  /** Per driven bone: 1 = tracked this frame, 0 = held / blended (landmarks not visible). */
  confidence: Map<string, number>;
  /** Vertical hips offset in model space (raw rig units) applied by grounding. */
  groundOffset: number;
}

/** Torso/head frames: X = subject's left, Y = up, Z = forward. */
export function basisFromXY(x: Vector3, yHint: Vector3, out = new Quaternion()): Quaternion {
  const bx = x.clone().normalize();
  const bz = new Vector3().crossVectors(bx, yHint).normalize();
  const by = new Vector3().crossVectors(bz, bx);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(bx, by, bz));
}

export function basisFromXZ(x: Vector3, zHint: Vector3, out = new Quaternion()): Quaternion {
  const bx = x.clone().normalize();
  const by = new Vector3().crossVectors(zHint, bx).normalize();
  const bz = new Vector3().crossVectors(bx, by);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(bx, by, bz));
}

const mid = (a: Vector3, b: Vector3) => a.clone().add(b).multiplyScalar(0.5);

export interface SegmentFrames {
  hips: Quaternion;
  chest: Quaternion;
  head: Quaternion;
}

/** Orientation of pelvis, chest and head derived from landmark positions (any consistent space). */
export function segmentFrames(p: Vector3[]): SegmentFrames {
  const hipMid = mid(p[LM.leftHip], p[LM.rightHip]);
  const shoulderMid = mid(p[LM.leftShoulder], p[LM.rightShoulder]);
  const up = shoulderMid.clone().sub(hipMid);
  const earMid = mid(p[LM.leftEar], p[LM.rightEar]);
  return {
    hips: basisFromXY(p[LM.leftHip].clone().sub(p[LM.rightHip]), up),
    chest: basisFromXY(p[LM.leftShoulder].clone().sub(p[LM.rightShoulder]), up),
    head: basisFromXZ(p[LM.leftEar].clone().sub(p[LM.rightEar]), p[LM.nose].clone().sub(earMid)),
  };
}

interface AimSpec {
  bone: string;
  from: number | [number, number];
  to: number | [number, number];
  /** Landmarks that must be visible to drive this bone. */
  needs: number[];
  /** For hinge parents (upper arm, thigh): child bone whose bend plane fixes this bone's twist. */
  hingeChild?: { bone: string; to: number };
}

const AIMS: AimSpec[] = [
  { bone: BONES.upperArmL, from: LM.leftShoulder, to: LM.leftElbow, needs: [LM.leftShoulder, LM.leftElbow], hingeChild: { bone: BONES.forearmL, to: LM.leftWrist } },
  { bone: BONES.forearmL, from: LM.leftElbow, to: LM.leftWrist, needs: [LM.leftElbow, LM.leftWrist] },
  { bone: BONES.handL, from: LM.leftWrist, to: [LM.leftIndex, LM.leftPinky], needs: [LM.leftWrist, LM.leftIndex, LM.leftPinky] },
  { bone: BONES.upperArmR, from: LM.rightShoulder, to: LM.rightElbow, needs: [LM.rightShoulder, LM.rightElbow], hingeChild: { bone: BONES.forearmR, to: LM.rightWrist } },
  { bone: BONES.forearmR, from: LM.rightElbow, to: LM.rightWrist, needs: [LM.rightElbow, LM.rightWrist] },
  { bone: BONES.handR, from: LM.rightWrist, to: [LM.rightIndex, LM.rightPinky], needs: [LM.rightWrist, LM.rightIndex, LM.rightPinky] },
  { bone: BONES.thighL, from: LM.leftHip, to: LM.leftKnee, needs: [LM.leftHip, LM.leftKnee], hingeChild: { bone: BONES.shinL, to: LM.leftAnkle } },
  { bone: BONES.shinL, from: LM.leftKnee, to: LM.leftAnkle, needs: [LM.leftKnee, LM.leftAnkle] },
  { bone: BONES.footL, from: LM.leftAnkle, to: LM.leftFootIndex, needs: [LM.leftAnkle, LM.leftFootIndex] },
  { bone: BONES.thighR, from: LM.rightHip, to: LM.rightKnee, needs: [LM.rightHip, LM.rightKnee], hingeChild: { bone: BONES.shinR, to: LM.rightAnkle } },
  { bone: BONES.shinR, from: LM.rightKnee, to: LM.rightAnkle, needs: [LM.rightKnee, LM.rightAnkle] },
  { bone: BONES.footR, from: LM.rightAnkle, to: LM.rightFootIndex, needs: [LM.rightAnkle, LM.rightFootIndex] },
];

const LEG_BONES = new Set<string>([BONES.thighL, BONES.shinL, BONES.footL, BONES.thighR, BONES.shinR, BONES.footR]);
const TORSO_NEEDS = [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip];
const HEAD_NEEDS = [LM.nose, LM.leftEar, LM.rightEar];
const SPINE_WEIGHTS: Array<[string, number]> = [
  [BONES.spine1, 1 / 3],
  [BONES.spine2, 2 / 3],
  [BONES.spine3, 1],
];
const FOOT_POINTS = [LM.leftAnkle, LM.rightAnkle, LM.leftHeel, LM.rightHeel, LM.leftFootIndex, LM.rightFootIndex];

const pick = (p: Vector3[], ref: number | [number, number]) =>
  typeof ref === 'number' ? p[ref].clone() : mid(p[ref[0]], p[ref[1]]);

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Converts body-space landmarks into local bone rotations of the mannequin.
 *
 * Every driven bone is solved in model space as `Qmodel = D * QmodelRest`, where D rotates the bone's
 * rest direction (measured on the mannequin itself via the landmark model) onto the tracked direction,
 * using the parent's *solved* rotation so the hierarchy, bind pose and bone lengths are preserved.
 * Pelvis, chest and head use full frames; limbs use minimal swing plus a hinge-plane twist for
 * upper arms / thighs so elbows and knees bend about their natural axis.
 */
export class Retargeter {
  readonly def: RigDefinition;
  readonly options: RetargetOptions;
  private readonly bones: Map<string, BoneDef>;
  private readonly restLocal = new Map<string, Quaternion>();
  private readonly restModel = new Map<string, Quaternion>();
  private readonly restFk: Map<string, ModelTransform>;
  private readonly restDir = new Map<string, Vector3>();
  private readonly restBend = new Map<string, Vector3>();
  private readonly restFrames: SegmentFrames;
  private readonly restGroundY: number;
  private readonly lastLocal = new Map<string, Quaternion>();
  private readonly lostFor = new Map<string, number>();
  private groundOffset = 0;

  constructor(def: RigDefinition, options: Partial<RetargetOptions> = {}) {
    this.def = def;
    this.options = { ...DEFAULT_RETARGET_OPTIONS, ...options };
    this.bones = boneIndexMap(def);
    for (const missing of [...DRIVEN_BONES, BONES.root].filter((b) => !this.bones.has(b))) {
      throw new Error(`Rig is missing required bone "${missing}"`);
    }
    for (const b of def.bones) this.restLocal.set(b.name, new Quaternion().fromArray(b.rotation));
    this.restFk = forwardKinematics(def);
    for (const [name, t] of this.restFk) this.restModel.set(name, t.quaternion.clone());
    const restLm = rigLandmarks(this.restFk, this.restFk);
    for (const aim of AIMS) {
      this.restDir.set(aim.bone, pick(restLm, aim.to).sub(pick(restLm, aim.from)).normalize());
    }
    for (const aim of AIMS) {
      if (!aim.hingeChild) continue;
      const parentDir = this.restDir.get(aim.bone)!;
      const childDir = this.restDir.get(aim.hingeChild.bone)!;
      const bend = childDir.clone().sub(parentDir.clone().multiplyScalar(childDir.dot(parentDir)));
      if (bend.lengthSq() < 1e-10) throw new Error(`Rest pose of ${aim.bone} has no bend direction`);
      // Store in the bone's local frame so it follows the solved swing.
      this.restBend.set(aim.bone, bend.normalize().applyQuaternion(this.restModel.get(aim.bone)!.clone().invert()));
    }
    this.restFrames = segmentFrames(restLm);
    this.restGroundY = Math.min(...FOOT_POINTS.map((i) => restLm[i].y));
    this.reset();
  }

  reset() {
    this.lastLocal.clear();
    this.lostFor.clear();
    for (const name of DRIVEN_BONES) {
      this.lastLocal.set(name, this.restLocal.get(name)!.clone());
      this.lostFor.set(name, 0);
    }
    this.groundOffset = 0;
  }

  restLocalRotation(bone: string): Quaternion {
    return this.restLocal.get(bone)!.clone();
  }

  solve(frame: BodyFrame, calibration: CalibrationData, dt = 1 / 30): RetargetResult {
    const o = this.options;
    const points = frame.points.map((p) => p.clone().applyQuaternion(calibration.correction));
    const vis = frame.visibility;
    const visible = (ids: number[]) => ids.every((i) => (vis[i] ?? 0) >= o.minVisibility);

    const model = new Map<string, Quaternion>();
    const local = new Map<string, Quaternion>();
    const confidence = new Map<string, number>();
    model.set(BONES.root, this.restModel.get(BONES.root)!.clone());

    const setFromModel = (bone: string, q: Quaternion) => {
      const parent = this.bones.get(bone)!.parent!;
      model.set(bone, q);
      local.set(bone, model.get(parent)!.clone().invert().multiply(q));
    };
    const ensureParentChain = (bone: string) => {
      // Non-driven intermediate bones (e.g. clavicles) keep their rest local rotation.
      const parent = this.bones.get(bone)!.parent!;
      if (!model.has(parent)) {
        ensureParentChain(parent);
        const pp = this.bones.get(parent)!.parent!;
        model.set(parent, model.get(pp)!.clone().multiply(this.restLocal.get(parent)!));
      }
    };
    const hold = (bone: string) => {
      const lost = (this.lostFor.get(bone) ?? 0) + dt;
      this.lostFor.set(bone, lost);
      const last = this.lastLocal.get(bone)!;
      if (lost > o.holdTime) last.slerp(this.restLocal.get(bone)!, 1 - Math.exp(-dt / o.releaseTau));
      ensureParentChain(bone);
      const parent = this.bones.get(bone)!.parent!;
      setFromModel(bone, model.get(parent)!.clone().multiply(last));
      confidence.set(bone, 0);
    };
    const accept = (bone: string) => {
      this.lastLocal.get(bone)!.copy(local.get(bone)!);
      this.lostFor.set(bone, 0);
      confidence.set(bone, 1);
    };

    // Torso: pelvis, distributed spine, neck/head.
    const torsoVisible = visible(TORSO_NEEDS);
    let dHips = new Quaternion();
    let dChest = new Quaternion();
    if (torsoVisible) {
      const f = segmentFrames(points);
      dHips = f.hips.clone().multiply(this.restFrames.hips.clone().invert());
      dChest = f.chest.clone().multiply(this.restFrames.chest.clone().invert()).multiply(calibration.chestOffset.clone().invert());
      setFromModel(BONES.hips, dHips.clone().multiply(this.restModel.get(BONES.hips)!));
      accept(BONES.hips);
      for (const [bone, w] of SPINE_WEIGHTS) {
        const d = new Quaternion().slerpQuaternions(dHips, dChest, w);
        setFromModel(bone, d.multiply(this.restModel.get(bone)!));
        accept(bone);
      }
    } else {
      hold(BONES.hips);
      for (const [bone] of SPINE_WEIGHTS) hold(bone);
    }

    if (torsoVisible && visible(HEAD_NEEDS)) {
      const f = segmentFrames(points);
      const dHead = f.head.clone().multiply(this.restFrames.head.clone().invert()).multiply(calibration.headOffset.clone().invert());
      const dNeck = new Quaternion().slerpQuaternions(dChest, dHead, 0.5);
      setFromModel(BONES.neck, dNeck.multiply(this.restModel.get(BONES.neck)!));
      accept(BONES.neck);
      setFromModel(BONES.head, dHead.clone().multiply(this.restModel.get(BONES.head)!));
      accept(BONES.head);
    } else {
      hold(BONES.neck);
      hold(BONES.head);
    }

    // Limbs, parents first (AIMS order).
    for (const aim of AIMS) {
      const legsOff = LEG_BONES.has(aim.bone) && !calibration.legsTracked;
      if (legsOff || !visible(aim.needs)) {
        hold(aim.bone);
        continue;
      }
      ensureParentChain(aim.bone);
      const parent = this.bones.get(aim.bone)!.parent!;
      const q0 = model.get(parent)!.clone().multiply(this.restLocal.get(aim.bone)!);
      const restToNow = q0.clone().multiply(this.restModel.get(aim.bone)!.clone().invert());
      const d0 = this.restDir.get(aim.bone)!.clone().applyQuaternion(restToNow);
      const target = pick(points, aim.to).sub(pick(points, aim.from));
      if (target.lengthSq() < 1e-10) {
        hold(aim.bone);
        continue;
      }
      target.normalize();
      const q = new Quaternion().setFromUnitVectors(d0, target).multiply(q0);

      if (aim.hingeChild && visible([aim.hingeChild.to])) {
        const child = pick(points, aim.hingeChild.to).sub(pick(points, aim.to)).normalize();
        const perp = child.clone().sub(target.clone().multiplyScalar(child.dot(target)));
        const sinBend = perp.length();
        const w = smoothstep(0.08, 0.3, sinBend);
        if (w > 0) {
          perp.normalize();
          const bendNow = this.restBend.get(aim.bone)!.clone().applyQuaternion(q);
          const twist = Math.atan2(new Vector3().crossVectors(bendNow, perp).dot(target), bendNow.dot(perp));
          q.premultiply(new Quaternion().setFromAxisAngle(target, twist * w));
        }
      }
      setFromModel(aim.bone, q.normalize());
      accept(aim.bone);
    }

    const translations = new Map<string, Vector3>();
    if (o.grounding) {
      const legsOk = calibration.legsTracked && LEG_BONES.size > 0 && [...LEG_BONES].every((b) => confidence.get(b) === 1);
      const posed = forwardKinematics(this.def, { rotations: local, translations: new Map() });
      const lm = rigLandmarks(posed, this.restFk);
      const lowest = Math.min(...FOOT_POINTS.map((i) => lm[i].y));
      const target = legsOk ? this.restGroundY - lowest : 0;
      this.groundOffset += (target - this.groundOffset) * (1 - Math.exp(-dt / 0.08));
      const rootInv = this.restModel.get(BONES.root)!.clone().invert();
      const hipsRest = new Vector3().fromArray(this.bones.get(ROOT_MOTION_BONE)!.translation);
      translations.set(ROOT_MOTION_BONE, hipsRest.add(new Vector3(0, this.groundOffset, 0).applyQuaternion(rootInv)));
    }

    const rotations = new Map<string, Quaternion>();
    for (const name of DRIVEN_BONES) rotations.set(name, local.get(name)!.clone().normalize());
    return { rotations, translations, confidence, groundOffset: this.groundOffset };
  }
}
