import { Matrix4, Quaternion, Vector3, type AnimationClip } from 'three';
import { forwardKinematics, type LocalPose, type RigDefinition } from '../../rig/rigDefinition';
import { BONES } from '../../rig/rigSpec';
import type { ActionStyle, ActionType, DirectorAction, Hand } from '../ai/commandSchema';
import { simulate, type Plan, type PlanIssue, type PlanStep } from '../planning/actionPlanner';
import { handSign } from '../planning/sceneConstraints';
import { glassSize, rad, requireObject, wrapAngle, type DirectorScene, type Vec3 } from '../scene/sceneModel';
import { ClipSampler } from './clipSampler';
import { solveTwoBone } from './ikController';

/** The parts of a loaded mannequin the composer needs (kept small so tests can build it in Node). */
export interface ComposerRig {
  definition: RigDefinition;
  clips: AnimationClip[];
  /** Armature scale: world metres per rig unit. */
  scale: number;
}

export const IDLE_CLIP = 'Idle_Loop';
export const WALK_CLIP = 'Walk_Loop';
export const SIT_CLIPS = { enter: 'Sitting_Enter', idle: 'Sitting_Idle_Loop', exit: 'Sitting_Exit' } as const;

const HAND_BONES: Record<Hand, { shoulder: string; upper: string; lower: string; hand: string }> = {
  right: { shoulder: BONES.shoulderR, upper: BONES.upperArmR, lower: BONES.forearmR, hand: BONES.handR },
  left: { shoulder: BONES.shoulderL, upper: BONES.upperArmL, lower: BONES.forearmL, hand: BONES.handL },
};
const SPINE_CHAIN = [BONES.spine1, BONES.spine2, BONES.spine3, BONES.neck, BONES.head];
/** Share of bend (pitch) and gaze (yaw, pitch) per spine-chain bone. */
const BEND_SHARE = [0.3, 0.35, 0.35, 0, 0];
const GAZE_YAW_SHARE = [0, 0, 0.15, 0.35, 0.5];
const GAZE_PITCH_SHARE = [0, 0, 0, 0.4, 0.6];
/** Palm centre relative to the hand bone (fraction of the index-finger base offset). */
const PALM_FRACTION = 0.6;

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

export interface ArmChannel {
  w: number;
  target: Vector3;
}

export interface PoseParams {
  t: number;
  rootPos: [number, number];
  yaw: number;
  walkWeight: number;
  /** Walk clip time. */
  walkTime: number;
  amplitude: number;
  /** Degrees. */
  bend: number;
  /** Radians, relative to the body (yaw left-positive, pitch down-positive). */
  gaze: [number, number];
  arms: Record<Hand, ArmChannel>;
  /** Full-body clip layers blended over the idle base, in order (sitting down, seated, standing up). */
  layers?: ClipLayer[];
}

export interface ClipLayer {
  clip: ClipSampler;
  time: number;
  weight: number;
}

/** Rig-dependent data, computed once per mannequin. */
export class ComposerContext {
  readonly def: RigDefinition;
  readonly scale: number;
  readonly idle: ClipSampler;
  readonly walk: ClipSampler;
  readonly sitEnter: ClipSampler;
  readonly sitIdle: ClipSampler;
  readonly sitExit: ClipSampler;
  /** World metres covered by one Walk_Loop cycle. */
  readonly strideLength: number;
  readonly restRoot: Quaternion;
  readonly armLength: number;
  readonly palmLocal: Record<Hand, Vector3>;
  private readonly lowerOffset: Record<Hand, Vector3>;
  private readonly effectorOffset: Record<Hand, Vector3>;
  private readonly restHand: Record<Hand, Quaternion>;
  /** Shoulder/head positions (actor frame, metres) for bends 0..70 in 5 degree steps. */
  private readonly bendTable: { bend: number; shoulder: Record<Hand, Vector3>; head: Vector3 }[] = [];
  readonly boneNames: string[];

  constructor(rig: ComposerRig) {
    this.def = rig.definition;
    this.scale = rig.scale;
    const find = (name: string) => {
      const c = rig.clips.find((x) => x.name === name);
      if (!c) throw new Error(`Mannequin is missing the "${name}" animation clip.`);
      return c;
    };
    this.idle = new ClipSampler(find(IDLE_CLIP), this.def);
    this.walk = new ClipSampler(find(WALK_CLIP), this.def);
    this.sitEnter = new ClipSampler(find(SIT_CLIPS.enter), this.def);
    this.sitIdle = new ClipSampler(find(SIT_CLIPS.idle), this.def);
    this.sitExit = new ClipSampler(find(SIT_CLIPS.exit), this.def);
    const bone = (n: string) => {
      const b = this.def.bones.find((x) => x.name === n);
      if (!b) throw new Error(`Rig has no bone ${n}`);
      return b;
    };
    this.boneNames = this.def.bones.map((b) => b.name);
    this.restRoot = new Quaternion().fromArray(bone(BONES.root).rotation);
    const hands: Hand[] = ['right', 'left'];
    this.lowerOffset = {} as Record<Hand, Vector3>;
    this.effectorOffset = {} as Record<Hand, Vector3>;
    this.restHand = {} as Record<Hand, Quaternion>;
    this.palmLocal = {} as Record<Hand, Vector3>;
    for (const h of hands) {
      const names = HAND_BONES[h];
      const idx = h === 'right' ? BONES.index1R : BONES.index1L;
      this.palmLocal[h] = new Vector3().fromArray(bone(idx).translation).multiplyScalar(PALM_FRACTION);
      this.lowerOffset[h] = new Vector3().fromArray(bone(names.lower).translation);
      this.restHand[h] = new Quaternion().fromArray(bone(names.hand).rotation);
      this.effectorOffset[h] = new Vector3().fromArray(bone(names.hand).translation).add(this.palmLocal[h].clone().applyQuaternion(this.restHand[h]));
    }
    this.armLength = (this.lowerOffset.right.length() + this.effectorOffset.right.length()) * this.scale;

    // Stride: the stance foot is fixed on the ground for ~60% of the cycle while sliding back relative to the hips.
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 40; i++) {
      const pose: LocalPose = { rotations: new Map(), translations: new Map() };
      this.walk.sample((i / 40) * this.walk.duration, pose.rotations, pose.translations);
      const z = forwardKinematics(this.def, pose).get(BONES.footL)!.position.z;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const range = (maxZ - minZ) * this.scale;
    this.strideLength = range > 0.2 && range < 2 ? range / 0.6 : 1.4;

    const none = (): ArmChannel => ({ w: 0, target: new Vector3() });
    for (let b = 0; b <= 70; b += 5) {
      const { fk } = this.compose({ t: 0, rootPos: [0, 0], yaw: 0, walkWeight: 0, walkTime: 0, amplitude: 1, bend: b, gaze: [0, 0], arms: { right: none(), left: none() } });
      const p = (n: string) => fk.get(n)!.position.clone().multiplyScalar(this.scale);
      this.bendTable.push({ bend: b, shoulder: { right: p(HAND_BONES.right.upper), left: p(HAND_BONES.left.upper) }, head: p(BONES.head) });
    }
  }

  /** World position of a point given in the actor frame (x left... uses model axes: +Z forward, -X right). */
  static actorToWorld(rootPos: [number, number], yaw: number, local: Vector3): Vector3 {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return new Vector3(rootPos[0] + local.x * c + local.z * s, local.y, rootPos[1] - local.x * s + local.z * c);
  }

  private bendRow(bend: number) {
    const i = Math.max(0, Math.min(this.bendTable.length - 2, Math.floor(bend / 5)));
    const a = this.bendTable[i];
    const b = this.bendTable[i + 1];
    const f = Math.max(0, Math.min(1, (bend - a.bend) / 5));
    return { shoulder: (h: Hand) => a.shoulder[h].clone().lerp(b.shoulder[h], f), head: a.head.clone().lerp(b.head, f) };
  }

  /** Smallest upper-body bend (degrees) that brings `target` within the arm's reach. */
  bendFor(target: Vector3, rootPos: [number, number], yaw: number, hand: Hand): number {
    const limit = this.armLength * 0.95;
    let prev = Infinity;
    for (let b = 0; b <= 60; b += 1) {
      const sh = ComposerContext.actorToWorld(rootPos, yaw, this.bendRow(b).shoulder(hand));
      const d = sh.distanceTo(target);
      if (d <= limit) return b;
      if (d > prev + 1e-4) return Math.max(0, b - 1);
      prev = d;
    }
    return 60;
  }

  /** Gaze yaw/pitch (body-relative) that looks at a world point, given the bend that is already applied. */
  gazeAt(target: Vector3, rootPos: [number, number], yaw: number, bend: number): [number, number] {
    const head = ComposerContext.actorToWorld(rootPos, yaw, this.bendRow(Math.max(0, Math.min(70, bend))).head);
    const d = target.clone().sub(head);
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const lx = d.x * c + d.z * s;
    const lz = -d.x * s + d.z * c;
    const gy = Math.atan2(lx, lz);
    const gp = Math.atan2(-d.y, Math.hypot(lx, lz)) - rad(bend) * 0.8;
    const lim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    return [lim(gy, -rad(80), rad(80)), lim(gp, -rad(35), rad(50))];
  }

  /** Builds the full local pose (all bones incl. root motion) for a set of channel values. Pure. */
  compose(p: PoseParams): { pose: LocalPose; fk: ReturnType<typeof forwardKinematics> } {
    const pose: LocalPose = { rotations: new Map(), translations: new Map() };
    this.idle.sample(p.t, pose.rotations, pose.translations);
    for (const layer of p.layers ?? []) {
      if (layer.weight <= 1e-4) continue;
      const lr = new Map<string, Quaternion>();
      const lt = new Map<string, Vector3>();
      layer.clip.sample(layer.time, lr, lt);
      const w = Math.min(1, layer.weight);
      for (const [name, q] of lr) {
        const base = pose.rotations.get(name);
        if (base) base.slerp(q, w).normalize();
        else pose.rotations.set(name, q.clone());
      }
      for (const [name, v] of lt) {
        const base = pose.translations.get(name);
        if (base) base.lerp(v, w);
        else pose.translations.set(name, v.clone());
      }
    }
    if (p.walkWeight > 1e-4) {
      const wr = new Map<string, Quaternion>();
      const wt = new Map<string, Vector3>();
      this.walk.sample(p.walkTime, wr, wt);
      const k = p.walkWeight * p.amplitude;
      for (const [name, q] of wr) {
        const base = pose.rotations.get(name);
        if (base) base.slerpQuaternions(base.clone(), q, k).normalize();
        else pose.rotations.set(name, q.clone());
      }
      for (const [name, v] of wt) {
        const base = pose.translations.get(name);
        if (base) base.lerp(v, p.walkWeight);
      }
    }
    const yawQ = new Quaternion().setFromAxisAngle(Y, p.yaw);
    pose.rotations.set(BONES.root, yawQ.clone().multiply(this.restRoot));
    pose.translations.set(BONES.root, new Vector3(p.rootPos[0] / this.scale, 0, p.rootPos[1] / this.scale));

    // Spine bend + gaze: model-space deltas distributed along the chain.
    if (Math.abs(p.bend) > 1e-3 || Math.abs(p.gaze[0]) > 1e-4 || Math.abs(p.gaze[1]) > 1e-4) {
      const fk0 = forwardKinematics(this.def, pose);
      const pitchAxis = X.clone().applyQuaternion(yawQ);
      let parentC = new Quaternion();
      let parentW = fk0.get(BONES.hips)!.quaternion.clone();
      SPINE_CHAIN.forEach((name, i) => {
        const w = fk0.get(name)!.quaternion;
        const d = new Quaternion()
          .setFromAxisAngle(Y, p.gaze[0] * GAZE_YAW_SHARE[i])
          .multiply(new Quaternion().setFromAxisAngle(pitchAxis, rad(p.bend) * BEND_SHARE[i] + p.gaze[1] * GAZE_PITCH_SHARE[i]));
        const c = d.multiply(parentC);
        const local = parentC.clone().multiply(parentW).invert().multiply(c.clone().multiply(w)).normalize();
        pose.rotations.set(name, local);
        parentC = c;
        parentW = w.clone();
      });
    }

    let fk = forwardKinematics(this.def, pose);
    let changed = false;
    for (const hand of ['right', 'left'] as Hand[]) {
      const arm = p.arms[hand];
      if (arm.w <= 1e-4) continue;
      const n = HAND_BONES[hand];
      const right = new Vector3(-Math.cos(p.yaw), 0, Math.sin(p.yaw));
      const forward = new Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
      const pole = right.multiplyScalar(0.6 * handSign(hand)).add(new Vector3(0, -1, 0)).add(forward.multiplyScalar(-0.3));
      const upperLocal = pose.rotations.get(n.upper)!;
      const lowerLocal = pose.rotations.get(n.lower)!;
      const ik = solveTwoBone({
        root: fk.get(n.upper)!.position,
        parentRotation: fk.get(n.shoulder)!.quaternion,
        upperLocal,
        lowerLocal,
        lowerOffset: this.lowerOffset[hand],
        effectorOffset: this.effectorOffset[hand],
        target: arm.target.clone().divideScalar(this.scale),
        pole,
      });
      const w = Math.min(1, arm.w);
      upperLocal.slerp(ik.upperLocal, w).normalize();
      lowerLocal.slerp(ik.lowerLocal, w).normalize();
      pose.rotations.get(n.hand)?.slerp(this.restHand[hand], w).normalize();
      changed = true;
    }
    if (changed) fk = forwardKinematics(this.def, pose);
    return { pose, fk };
  }

  /** World-space palm position of a hand from a forward-kinematics result. */
  palmWorld(fk: ReturnType<typeof forwardKinematics>, hand: Hand): Vector3 {
    const m = fk.get(HAND_BONES[hand].hand)!.matrix;
    return this.palmLocal[hand].clone().applyMatrix4(m).multiplyScalar(this.scale);
  }
}

export type GlassState = 'on_table' | 'available' | 'being_reached' | 'held_right' | 'held_left' | 'being_placed' | 'released';
export type Lane = 'root' | 'body' | 'head' | 'rightArm' | 'leftArm' | 'interaction' | 'glass' | 'events';

export interface Segment {
  actionId: string;
  actionIndex: number;
  type: ActionType;
  /** `prepare`: anticipation before a deliberately slow walk (idle motion, gaze toward the destination). */
  phase: 'turn' | 'walk' | 'prepare' | 'main';
  start: number;
  end: number;
}

export interface TimelineItem {
  id: string;
  actionId: string | null;
  lane: Lane;
  label: string;
  start: number;
  end: number;
}

export interface InteractionEvent {
  time: number;
  type: 'attach' | 'release';
  object: string;
  hand: Hand;
}

export interface DirectorFrame {
  time: number;
  pose: LocalPose;
  actor: { position: Vec3; yaw: number };
  glass: { position: Vec3; yaw: number };
  glassState: GlassState;
  heldBy: Hand | null;
  activeActionId: string | null;
  palm: Record<Hand, Vector3>;
}

export interface Performance {
  duration: number;
  segments: Segment[];
  actionTimes: Map<string, { start: number; end: number }>;
  items: TimelineItem[];
  events: InteractionEvent[];
  plan: Plan;
  issues: PlanIssue[];
  evaluate(t: number): DirectorFrame;
}

const smooth = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};

const STYLE_TIME: Record<ActionStyle, number> = { normal: 1, nervous: 0.85, cautious: 1.35, exaggerated: 1, calm: 1.15, hesitant: 1.25 };
const BASE_DURATION: Partial<Record<ActionType, number>> = {
  reach: 0.9,
  grip: 0.35,
  lift: 0.7,
  place: 1.0,
  release: 0.45,
  look_at: 1.0,
  look_around: 2.2,
  bend: 1.2,
  pause: 1.0,
  idle: 1.5,
};
const WALK_SPEED = 1.05;
/** Slowest plausible walking speed (m/s, peak). Slower targets add an anticipation phase instead. */
export const MIN_WALK_SPEED = 0.38;
/** Slow walks take shorter steps: stride scales with sqrt(speed), so cadence and step length both drop. */
const strideScaleFor = (peakSpeed: number) => Math.max(0.55, Math.min(1.2, Math.sqrt(peakSpeed / WALK_SPEED)));
/** Peak speed of the trapezoidal walk profile used by `rootAt`. */
const walkPeak = (len: number, T: number) => len / Math.max(1e-6, T - Math.min(0.5, T / 3));
const TURN_SPEED = 2.4;
const TURN_THRESHOLD = 0.3;

interface Channels {
  bend: number;
  gaze: [number, number];
  arms: Record<Hand, ArmChannel>;
}

interface SegData extends Segment {
  step: PlanStep;
  fromPos: [number, number];
  toPos: [number, number];
  fromYaw: number;
  toYaw: number;
  /** Cumulative walk distance at segment start (drives the walk phase). */
  dist0: number;
  distance: number;
  /** Gait phase (in metres of nominal stride) at segment start, and stride scaling of this segment. */
  phase0: number;
  strideScale: number;
  /** Prepare segments: gaze yaw toward the walk direction. */
  gazeYaw?: number;
  /** Time the actor finished sitting down (drives the seated idle loop). */
  seatedSince?: number;
  prev: Channels;
  /** Interaction target positions (world). */
  hand: Hand;
  gripTarget?: Vector3;
  placeHand?: Vector3;
  reachBend?: number;
  placeBend?: number;
}

function timeScale(a: DirectorAction): number {
  return STYLE_TIME[a.style ?? 'normal'] / Math.max(0.05, a.speed);
}

function cloneChannels(c: Channels): Channels {
  return {
    bend: c.bend,
    gaze: [c.gaze[0], c.gaze[1]],
    arms: { right: { w: c.arms.right.w, target: c.arms.right.target.clone() }, left: { w: c.arms.left.w, target: c.arms.left.target.clone() } },
  };
}

const restChannels = (): Channels => ({ bend: 0, gaze: [0, 0], arms: { right: { w: 0, target: new Vector3() }, left: { w: 0, target: new Vector3() } } });

/**
 * Retimes a walk/turn action to exactly `T` seconds. Faster: everything is compressed. Slower: turns stretch
 * up to 2x and the walk slows down (shorter, slower steps) to MIN_WALK_SPEED; any time still missing becomes
 * an anticipation phase before setting off (idle motion, gaze toward the destination), never a frozen pose.
 */
function fitLocomotion(parts: { phase: Segment['phase']; dur: number; extra: Partial<SegData> }[], T: number, len: number, from: { pos: [number, number]; yaw: number }, pathTurn: number) {
  const total = parts.reduce((acc, p) => acc + p.dur, 0);
  if (total <= 1e-6) return;
  const f = T / total;
  const walk = parts.find((p) => p.phase === 'walk');
  const maxWalk = walk ? len / MIN_WALK_SPEED + 0.5 : 0;
  const turnCap = walk ? 2 : 3;
  if (f <= 1 || ((!walk || walk.dur * f <= maxWalk) && f <= turnCap)) {
    for (const p of parts) p.dur *= f;
    return;
  }
  for (const p of parts) p.dur = p.phase === 'walk' ? Math.min(maxWalk, p.dur * f) : p.dur * Math.min(f, turnCap);
  const rest = T - parts.reduce((acc, p) => acc + p.dur, 0);
  if (rest > 1e-6) parts.unshift({ phase: 'prepare', dur: rest, extra: { fromPos: [...from.pos], toPos: [...from.pos], fromYaw: from.yaw, toYaw: from.yaw, distance: 0, gazeYaw: Math.max(-1.2, Math.min(1.2, pathTurn)) } });
}

/**
 * Deterministic motion composer: turns a validated action list into a performance whose pose is a pure
 * function of time. Library clips (idle, walk) provide the base motion; procedural layers add root motion,
 * spine bend, gaze, two-bone arm IK and the glass attachment.
 */
export function composePerformance(ctx: ComposerContext, scene: DirectorScene, actions: DirectorAction[]): Performance {
  const plan = simulate(actions, scene);
  const glassObj = requireObject(scene, 'glass');
  const gSize = glassSize(glassObj);
  const gripHeight = gSize[1] * 0.55;
  const segs: SegData[] = [];
  let time = 0;
  let dist = 0;
  let gait = 0;
  let seatedSince = 0;
  const prevPlaceHand: { v?: Vector3; bend?: number } = {};

  const carry = (pos: [number, number], yaw: number, hand: Hand) =>
    ComposerContext.actorToWorld(pos, yaw, new Vector3(-0.2 * handSign(hand), 1.0, 0.3));

  const push = (step: PlanStep, i: number, phase: SegData['phase'], duration: number, extra: Partial<SegData>) => {
    const s: SegData = {
      actionId: step.action.id,
      actionIndex: i,
      type: step.action.type,
      phase,
      start: time,
      end: time + Math.max(0.05, duration),
      step,
      fromPos: [...step.before.stand.pos],
      toPos: [...step.before.stand.pos],
      fromYaw: step.before.stand.yaw,
      toYaw: step.before.stand.yaw,
      dist0: dist,
      distance: 0,
      phase0: gait,
      strideScale: 1,
      prev: restChannels(),
      hand: step.action.hand ?? step.before.hand,
      ...extra,
    };
    segs.push(s);
    time = s.end;
    dist += s.distance;
    gait += s.distance / s.strideScale;
    return s;
  };

  plan.steps.forEach((step, i) => {
    const a = step.action;
    const k = timeScale(a);
    const b = step.before;
    const af = step.after;
    const hand = a.hand ?? b.hand;
    if (a.type === 'walk_to' || a.type === 'turn') {
      const from = b.stand;
      const to = af.stand;
      const dx = to.pos[0] - from.pos[0];
      const dz = to.pos[1] - from.pos[1];
      const len = Math.hypot(dx, dz);
      type Part = { phase: SegData['phase']; dur: number; extra: Partial<SegData> };
      const parts: Part[] = [];
      let yaw = from.yaw;
      let pathTurn = 0;
      if (len > 0.05) {
        const pathYaw = Math.atan2(dx, dz);
        const d = wrapAngle(pathYaw - yaw);
        pathTurn = d;
        if (Math.abs(d) > TURN_THRESHOLD) {
          parts.push({ phase: 'turn', dur: (Math.abs(d) / TURN_SPEED) * k + 0.15, extra: { fromPos: [...from.pos], toPos: [...from.pos], fromYaw: yaw, toYaw: yaw + d, distance: Math.abs(d) * 0.22 } });
        }
        yaw += d; // small corrections are absorbed into the walk
        const v = (WALK_SPEED * Math.max(0.05, a.speed)) / STYLE_TIME[a.style ?? 'normal'];
        const r = Math.min(0.5, len / v / 2);
        parts.push({ phase: 'walk', dur: len / v + r, extra: { fromPos: [...from.pos], toPos: [...to.pos], fromYaw: wrapAngle(yaw), toYaw: wrapAngle(yaw), distance: len } });
      }
      const d2 = wrapAngle(to.yaw - yaw);
      if (Math.abs(d2) > 0.02 || parts.length === 0) {
        parts.push({ phase: 'turn', dur: Math.max(0.35, (Math.abs(d2) / TURN_SPEED) * k + 0.15), extra: { fromPos: [...to.pos], toPos: [...to.pos], fromYaw: wrapAngle(yaw), toYaw: wrapAngle(yaw) + d2, distance: Math.abs(d2) * 0.22 } });
      }
      if (a.duration !== undefined) fitLocomotion(parts, a.duration, len, from, pathTurn);
      for (const part of parts) {
        if (part.phase === 'walk') part.extra.strideScale = strideScaleFor(walkPeak(len, part.dur));
        push(step, i, part.phase, part.dur, part.extra);
      }
      return;
    }
    const natural = a.type === 'sit' ? ctx.sitEnter.duration : a.type === 'stand_up' ? ctx.sitExit.duration : (BASE_DURATION[a.type] ?? 1);
    const base = a.duration ?? natural * (a.type === 'pause' || a.type === 'idle' ? 1 : k);
    const extra: Partial<SegData> = {};
    if (b.seated) extra.seatedSince = seatedSince;
    const pos = b.stand.pos;
    const yaw = b.stand.yaw;
    if (a.type === 'reach' || a.type === 'grip') {
      const g = new Vector3(b.glassPos[0], b.glassPos[1] + gripHeight, b.glassPos[2]);
      const toActor = new Vector3(pos[0] - g.x, 0, pos[1] - g.z).normalize();
      const right = new Vector3(-Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(handSign(hand));
      extra.gripTarget = g.clone().add(toActor.multiplyScalar(gSize[0] + 0.02)).add(right.multiplyScalar(0.025));
      extra.reachBend = ctx.bendFor(extra.gripTarget, pos, yaw, hand);
    }
    if (a.type === 'place' && step.placeAt) {
      // Hand target is resolved after the attach offset is known (second pass).
      extra.placeBend = 0;
    }
    if (a.type === 'release' || (b.glassPhase === 'placed' && a.type !== 'place')) {
      extra.placeHand = prevPlaceHand.v;
      extra.placeBend = prevPlaceHand.bend;
    }
    const s = push(step, i, 'main', base, extra);
    if (a.type === 'place') prevPlaceHand.v = undefined;
    if (a.type === 'sit' && af.seated) seatedSince = s.end;
  });

  if (segs.length === 0) {
    // Empty sequence: idle at the start mark.
    const st = plan.initial;
    const fakeStep: PlanStep = { action: { id: '', type: 'idle', speed: 1 }, before: st, after: st };
    push(fakeStep, -1, 'main', 2, {});
  }
  const duration = time;

  // --- channel evaluation -------------------------------------------------------------------------
  const rootAt = (s: SegData, u: number): { pos: [number, number]; yaw: number; walkW: number; dist: number } => {
    if (s.phase === 'walk') {
      const T = s.end - s.start;
      const L = s.distance;
      const r = Math.min(0.5, T / 3);
      const vmax = L / Math.max(1e-6, T - r);
      const t = u * T;
      let d: number;
      let v: number;
      if (t < r) {
        d = (vmax * t * t) / (2 * r);
        v = (vmax * t) / r;
      } else if (t < T - r) {
        d = vmax * (r / 2 + (t - r));
        v = vmax;
      } else {
        d = L - (vmax * (T - t) * (T - t)) / (2 * r);
        v = (vmax * (T - t)) / r;
      }
      const f = L > 0 ? Math.max(0, Math.min(1, d / L)) : 1;
      const pos: [number, number] = [s.fromPos[0] + (s.toPos[0] - s.fromPos[0]) * f, s.fromPos[1] + (s.toPos[1] - s.fromPos[1]) * f];
      return { pos, yaw: s.fromYaw, walkW: Math.min(1, v / Math.max(1e-6, vmax)), dist: s.dist0 + d };
    }
    if (s.phase === 'turn') {
      const e = smooth(u);
      return { pos: [...s.fromPos], yaw: s.fromYaw + (s.toYaw - s.fromYaw) * e, walkW: 0.35 * Math.sin(Math.PI * u), dist: s.dist0 + s.distance * e };
    }
    return { pos: [...s.fromPos], yaw: s.fromYaw, walkW: 0, dist: s.dist0 };
  };

  const placedHold = (s: SegData) => s.step.before.glassPhase === 'placed' && s.placeHand;

  /** Unblended channel targets of a segment at progress u. */
  const desired = (s: SegData, u: number, root: { pos: [number, number]; yaw: number }): Channels => {
    const a = s.step.action;
    const st = s.step.before;
    const c = restChannels();
    const held = st.held !== null && st.glassPhase !== 'placed';
    const restArm = () => {
      if (placedHold(s)) {
        c.arms[s.hand] = { w: 1, target: s.placeHand!.clone() };
        c.bend = s.placeBend ?? 0;
      } else if (held) c.arms[st.hand] = { w: 1, target: carry(root.pos, root.yaw, st.hand) };
    };
    switch (a.type) {
      case 'walk_to':
      case 'turn': {
        restArm();
        if (s.phase === 'prepare') {
          const T = s.end - s.start;
          const tt = u * T;
          const env = smooth(tt / Math.min(0.8, T / 2)) * smooth((T - tt) / Math.min(0.5, T / 3));
          c.gaze = [(s.gazeYaw ?? 0) * 0.8 * env, rad(6) * env];
        } else if (s.phase === 'walk') {
          c.bend = a.bend ?? (a.style === 'cautious' ? 12 : a.style === 'hesitant' ? 6 : 0);
          if (a.style === 'nervous') c.gaze = [rad(28) * Math.sin(2 * Math.PI * 0.9 * u * (s.end - s.start)), rad(-4)];
        } else c.gaze = [Math.sign(s.toYaw - s.fromYaw) * 0.3 * Math.sin(Math.PI * u), 0];
        break;
      }
      case 'reach': {
        const e = smooth(u);
        c.arms[s.hand] = { w: e, target: s.gripTarget!.clone().add(new Vector3(0, 0.12 * (1 - e), 0)) };
        c.bend = (s.reachBend ?? 0) * smooth(u * 1.3);
        c.gaze = ctx.gazeAt(s.gripTarget!, root.pos, root.yaw, c.bend);
        break;
      }
      case 'grip':
        c.arms[s.hand] = { w: 1, target: s.gripTarget!.clone() };
        c.bend = s.reachBend ?? 0;
        c.gaze = ctx.gazeAt(s.gripTarget!, root.pos, root.yaw, c.bend);
        break;
      case 'lift': {
        const e = smooth(u);
        const from = s.gripTarget ?? carry(root.pos, root.yaw, st.hand);
        const to = carry(root.pos, root.yaw, st.hand);
        c.arms[st.hand] = { w: 1, target: from.clone().lerp(to, e).add(new Vector3(0, 0.06 * Math.sin(Math.PI * u), 0)) };
        c.bend = (s.reachBend ?? 0) * (1 - e);
        c.gaze = [0, rad(25) * (1 - e) + rad(8)];
        break;
      }
      case 'place': {
        const start = carry(root.pos, root.yaw, st.hand);
        const goal = s.placeHand ?? start;
        const above = goal.clone().add(new Vector3(0, 0.1, 0));
        const target = u < 0.7 ? start.clone().lerp(above, smooth(u / 0.7)) : above.clone().lerp(goal, smooth((u - 0.7) / 0.3));
        c.arms[st.hand] = { w: 1, target };
        c.bend = (s.placeBend ?? 0) * smooth(u * 1.2);
        c.gaze = ctx.gazeAt(goal, root.pos, root.yaw, c.bend);
        break;
      }
      case 'release': {
        const goal = s.placeHand ?? carry(root.pos, root.yaw, st.hand);
        const e = smooth(u);
        const fw = new Vector3(Math.sin(root.yaw), 0, Math.cos(root.yaw));
        c.arms[st.hand] = { w: 1 - smooth((u - 0.25) / 0.75), target: goal.clone().add(new Vector3(0, 0.1 * e, 0)).sub(fw.multiplyScalar(0.08 * e)) };
        c.bend = (s.placeBend ?? 0) * (1 - e);
        c.gaze = [0, rad(15) * (1 - e)];
        break;
      }
      case 'look_at': {
        restArm();
        const dirs: Record<string, [number, number]> = { left: [rad(70), 0], right: [rad(-70), 0], up: [0, rad(-30)], down: [0, rad(40)], forward: [0, 0], back: [rad(80), 0], around: [rad(70), 0] };
        if (a.target) {
          const o = scene.objects.find((x) => x.id === a.target);
          const p = a.target === 'glass' ? new Vector3(st.glassPos[0], st.glassPos[1] + 0.06, st.glassPos[2]) : o ? new Vector3(...o.position) : new Vector3();
          if (a.target === 'table' && o) p.y = 0.75;
          if (a.target === 'camera' && o) p.y = o.position[1];
          c.gaze = ctx.gazeAt(p, root.pos, root.yaw, c.bend);
        } else c.gaze = dirs[a.direction ?? 'forward'] ?? [0, 0];
        c.gaze = [c.gaze[0] * (a.amplitude ?? 1), c.gaze[1] * (a.amplitude ?? 1)];
        break;
      }
      case 'look_around': {
        restArm();
        const nervous = a.style === 'nervous' || a.style === 'hesitant';
        const A = rad(nervous ? 55 : 65) * (a.amplitude ?? 1);
        const f = nervous ? 2 : 1;
        const env = Math.sin(Math.PI * Math.min(1, u)) ** 0.5;
        c.gaze = [A * Math.sin(2 * Math.PI * f * u) * env, (nervous ? rad(6) * Math.sin(2 * Math.PI * 3.3 * u) : rad(-3)) * env + c.gaze[1]];
        break;
      }
      case 'sit':
      case 'stand_up':
        restArm();
        c.gaze = [0, rad(10) * Math.sin(Math.PI * u)];
        break;
      case 'bend':
        restArm();
        c.bend = a.bend ?? 35;
        c.gaze = [0, rad(15)];
        break;
      case 'pause':
        return cloneChannels(s.prev);
      case 'idle':
      default:
        restArm();
        break;
    }
    return c;
  };

  const blend = (s: SegData, t: number, d: Channels): Channels => {
    const tau = Math.min(0.45, (s.end - s.start) * 0.5);
    const e = smooth(tau > 0 ? (t - s.start) / tau : 1);
    if (e >= 1) return d;
    const p = s.prev;
    const arm = (h: Hand): ArmChannel => {
      const a = p.arms[h];
      const b = d.arms[h];
      const target = a.w < 1e-3 ? b.target.clone() : b.w < 1e-3 ? a.target.clone() : a.target.clone().lerp(b.target, e);
      return { w: a.w + (b.w - a.w) * e, target };
    };
    return { bend: p.bend + (d.bend - p.bend) * e, gaze: [p.gaze[0] + (d.gaze[0] - p.gaze[0]) * e, p.gaze[1] + (d.gaze[1] - p.gaze[1]) * e], arms: { right: arm('right'), left: arm('left') } };
  };

  const channelsAt = (s: SegData, t: number) => {
    const u = Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start)));
    const root = rootAt(s, u);
    return { root, ch: blend(s, t, desired(s, u, root)) };
  };

  /** Sitting: Sitting_Enter, then Sitting_Idle_Loop (from the moment the actor sat), then Sitting_Exit. */
  const layersAt = (s: SegData, t: number): ClipLayer[] | undefined => {
    const T = s.end - s.start;
    const tt = Math.max(0, Math.min(T, t - s.start));
    const clipTime = (c: ClipSampler) => Math.min(c.duration - 1e-4, (tt / T) * c.duration);
    if (s.type === 'sit' && s.step.after.seated) return [{ clip: ctx.sitEnter, time: clipTime(ctx.sitEnter), weight: smooth(tt / Math.min(0.3, T / 3)) }];
    if (!s.step.before.seated) return undefined;
    const seated: ClipLayer = { clip: ctx.sitIdle, time: t - (s.seatedSince ?? s.start), weight: 1 };
    if (s.type !== 'stand_up') return [seated];
    const out = smooth((T - tt) / Math.min(0.3, T / 3));
    seated.weight = out;
    return [seated, { clip: ctx.sitExit, time: clipTime(ctx.sitExit), weight: Math.min(out, smooth(tt / Math.min(0.25, T / 4))) }];
  };

  const poseAt = (s: SegData, t: number) => {
    const { root, ch } = channelsAt(s, t);
    const amp = s.phase === 'walk' ? (s.step.action.amplitude ?? (s.step.action.style === 'exaggerated' ? 1.6 : s.step.action.style === 'cautious' ? 0.75 : 1)) * s.strideScale : 1;
    const out = ctx.compose({
      t,
      rootPos: root.pos,
      yaw: root.yaw,
      walkWeight: root.walkW,
      walkTime: ((s.phase0 + (root.dist - s.dist0) / s.strideScale) / ctx.strideLength) * ctx.walk.duration,
      amplitude: amp,
      bend: ch.bend,
      gaze: ch.gaze,
      arms: ch.arms,
      layers: layersAt(s, t),
    });
    return { ...out, root };
  };

  // --- holds: attach offsets, place targets (sequential, each depends on the previous) ----------------
  interface Hold {
    start: number;
    end: number;
    hand: Hand;
    offset: Vector3;
    yawOffset: number;
    attachYaw: number;
    placeSeg?: SegData;
    placeAt?: Vec3;
  }
  const holds: Hold[] = [];
  const events: InteractionEvent[] = [];
  let glassYaw = rad(glassObj.rotationY);
  let open: Hold | null = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    s.prev = i === 0 ? restChannels() : cloneChannels(channelsAt(segs[i - 1], segs[i - 1].end).ch);
    if (s.step.before.glassPhase === 'placed' && s.type !== 'place' && !s.placeHand) {
      const ph = [...segs.slice(0, i)].reverse().find((x) => x.type === 'place' && x.placeHand);
      if (ph) {
        s.placeHand = ph.placeHand;
        s.placeBend = ph.placeBend;
      }
    }
    if (s.type === 'grip' && s.step.after.held === 'glass') {
      const { fk, root } = poseAt(s, s.end);
      const palm = ctx.palmWorld(fk, s.hand);
      const base = new Vector3(...s.step.before.glassPos);
      const inv = new Quaternion().setFromAxisAngle(Y, -root.yaw);
      open = { start: s.end, end: Infinity, hand: s.hand, offset: base.sub(palm).applyQuaternion(inv), yawOffset: glassYaw - root.yaw, attachYaw: root.yaw };
      holds.push(open);
      events.push({ time: s.end, type: 'attach', object: 'glass', hand: s.hand });
    }
    if (s.type === 'place' && open && s.step.placeAt) {
      const yaw = s.fromYaw;
      const at = new Vector3(...s.step.placeAt);
      s.placeHand = at.clone().sub(open.offset.clone().applyQuaternion(new Quaternion().setFromAxisAngle(Y, yaw)));
      s.placeBend = ctx.bendFor(s.placeHand, s.fromPos, yaw, open.hand);
      open.end = s.end;
      open.placeSeg = s;
      open.placeAt = s.step.placeAt;
      glassYaw = yaw + open.yawOffset;
      open = null;
    }
    if (s.type === 'release' && s.step.after.held === null) events.push({ time: s.end, type: 'release', object: 'glass', hand: s.hand });
  }

  const findSeg = (t: number) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return segs[lo];
  };

  const glassStateAt = (s: SegData, t: number, hold: Hold | undefined): GlassState => {
    if (hold && t >= hold.start && t < hold.end) return s.type === 'place' ? 'being_placed' : hold.hand === 'right' ? 'held_right' : 'held_left';
    if (s.type === 'reach' && t >= s.start) return 'being_reached';
    const ph = s.step.before.glassPhase;
    if (s.type === 'release' || ph === 'released' || ph === 'placed') return 'released';
    if (ph === 'held') return s.step.before.hand === 'right' ? 'held_right' : 'held_left';
    return plan.initial.glassPhase === 'on_table' ? 'on_table' : 'available';
  };

  const evaluate = (tIn: number): DirectorFrame => {
    const t = Math.max(0, Math.min(duration, Number.isFinite(tIn) ? tIn : 0));
    const s = findSeg(t);
    const { pose, fk, root } = poseAt(s, t);
    const palm = { right: ctx.palmWorld(fk, 'right'), left: ctx.palmWorld(fk, 'left') };
    // Glass: static unless inside a hold; after a hold it rests at its placement point.
    let gPos = new Vector3(...glassObj.position);
    let gYaw = rad(glassObj.rotationY);
    let heldBy: Hand | null = null;
    let current: Hold | undefined;
    for (const h of holds) {
      if (t < h.start) break;
      current = h;
      if (t >= h.end && h.placeAt) {
        gPos = new Vector3(...h.placeAt);
        gYaw = h.placeSeg!.fromYaw + h.yawOffset;
        continue;
      }
      heldBy = h.hand;
      gPos = palm[h.hand].clone().add(h.offset.clone().applyQuaternion(new Quaternion().setFromAxisAngle(Y, root.yaw)));
      gYaw = root.yaw + h.yawOffset;
      if (h.placeSeg && s === h.placeSeg && h.placeAt) {
        const u = (t - s.start) / (s.end - s.start);
        gPos.lerp(new Vector3(...h.placeAt), smooth((u - 0.7) / 0.3));
      }
    }
    return {
      time: t,
      pose,
      actor: { position: [root.pos[0], 0, root.pos[1]], yaw: root.yaw },
      glass: { position: [gPos.x, gPos.y, gPos.z], yaw: gYaw },
      glassState: glassStateAt(s, t, current),
      heldBy,
      activeActionId: s.actionId || null,
      palm,
    };
  };

  // --- timeline items --------------------------------------------------------------------------------
  const actionTimes = new Map<string, { start: number; end: number }>();
  for (const s of segs) {
    if (!s.actionId) continue;
    const e = actionTimes.get(s.actionId);
    if (e) e.end = s.end;
    else actionTimes.set(s.actionId, { start: s.start, end: s.end });
  }
  const items: TimelineItem[] = [];
  const label = (a: DirectorAction) => a.type.replace('_', ' ') + (a.target ? ` ${a.target}` : a.direction ? ` ${a.direction}` : '');
  const lanesFor = (a: DirectorAction, st: PlanStep): Lane[] => {
    const arm: Lane = (a.hand ?? st.before.hand) === 'left' ? 'leftArm' : 'rightArm';
    switch (a.type) {
      case 'walk_to':
      case 'turn':
      case 'sit':
      case 'stand_up':
        return ['root', 'body'];
      case 'reach':
      case 'lift':
        return [arm, 'body', 'head'];
      case 'grip':
      case 'place':
      case 'release':
        return [arm, 'interaction'];
      case 'look_at':
      case 'look_around':
        return ['head'];
      case 'bend':
      case 'idle':
      case 'pause':
        return ['body'];
    }
  };
  for (const st of plan.steps) {
    const tm = actionTimes.get(st.action.id);
    if (!tm) continue;
    for (const lane of lanesFor(st.action, st)) items.push({ id: `${st.action.id}:${lane}`, actionId: st.action.id, lane, label: label(st.action), start: tm.start, end: tm.end });
  }
  holds.forEach((h, i) => items.push({ id: `hold${i}`, actionId: null, lane: 'glass', label: `glass in ${h.hand} hand`, start: h.start, end: Math.min(duration, h.end) }));
  for (const ev of events) items.push({ id: `${ev.type}@${ev.time.toFixed(3)}`, actionId: null, lane: 'events', label: ev.type, start: ev.time, end: ev.time });

  return { duration, segments: segs.map(({ actionId, actionIndex, type, phase, start, end }) => ({ actionId, actionIndex, type, phase, start, end })), actionTimes, items, events, plan, issues: plan.issues, evaluate };
}

/** Converts a frame's pose into a world transform matrix for the actor's root (handy for exports/tests). */
export function rootMatrix(frame: DirectorFrame): Matrix4 {
  return new Matrix4().compose(new Vector3(...frame.actor.position), new Quaternion().setFromAxisAngle(Y, frame.actor.yaw), new Vector3(1, 1, 1));
}
