import type { LabActor } from '../labActor';
import { estimateClipSpeed, FEET } from '../locomotion/gait';

/** Locomotion/idle clips of mannequin.glb used as the motion database (no fabricated data). */
export const MM_CLIPS = ['Idle_Loop', 'Crouch_Idle_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Crouch_Fwd_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop'] as const;
export const MM_FPS = 15;
/** Trajectory sample offsets (s) into the future. */
export const TRAJ_T = [0.33, 0.66, 1.0];
export const POSE_DIMS = 13;

export interface MMFrame {
  clip: string;
  time: number;
  /** Pose features: feet pos rel. hips (x,y,z ×2), feet vel (x,z ×2) [m, m/s], hips height. */
  pose: number[];
  /** Trajectory features: future root positions in character space (x,z per TRAJ_T). */
  traj: number[];
  speed: number;
}

export interface MMDatabase {
  frames: MMFrame[];
  poseMean: number[];
  poseStd: number[];
  trajMean: number[];
  trajStd: number[];
}

/** Pose feature vector of `clip` at time t (overwrites the actor pose). */
export function poseFeatures(actor: LabActor, clip: string, t: number): number[] {
  const at = (time: number) => {
    actor.sampleClip(clip, time);
    const fk = actor.fk();
    const hips = fk.get('DEF-hips')!.position;
    const l = fk.get(FEET.left.foot)!.position.clone().sub(hips).multiplyScalar(actor.scale);
    const r = fk.get(FEET.right.foot)!.position.clone().sub(hips).multiplyScalar(actor.scale);
    return { l, r, h: hips.y * actor.scale };
  };
  const dt = 1 / 30;
  const a = at(t - dt);
  const b = at(t);
  return [b.l.x, b.l.y, b.l.z, b.r.x, b.r.y, b.r.z, (b.l.x - a.l.x) / dt, (b.l.z - a.l.z) / dt, (b.r.x - a.r.x) / dt, (b.r.z - a.r.z) / dt, b.h, 0, 0].slice(0, POSE_DIMS);
}

const cache = new WeakMap<LabActor, MMDatabase>();

function stats(rows: number[][]) {
  const n = rows.length;
  const d = rows[0].length;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  return { mean, std };
}

/** Builds (once per actor) the feature database from the mannequin clips. */
export function buildDatabase(actor: LabActor): MMDatabase {
  const hit = cache.get(actor);
  if (hit) return hit;
  const frames: MMFrame[] = [];
  for (const clip of MM_CLIPS) {
    const d = actor.sampler(clip).duration;
    const speed = clip.includes('Idle') ? 0 : estimateClipSpeed(actor, clip);
    const n = Math.max(1, Math.floor(d * MM_FPS));
    for (let i = 0; i < n; i++) {
      const time = i / MM_FPS;
      frames.push({ clip, time, pose: poseFeatures(actor, clip, time), traj: TRAJ_T.flatMap((f) => [0, speed * f]), speed });
    }
  }
  const p = stats(frames.map((f) => f.pose));
  const tr = stats(frames.map((f) => f.traj));
  // trajectory x is always 0 in this database (no turning clips): keep a unit std so it still contributes
  const db = { frames, poseMean: p.mean, poseStd: p.std.map((s) => Math.max(s, 1e-3)), trajMean: tr.mean, trajStd: tr.std.map((s) => (s < 1e-6 ? 1 : s)) };
  cache.set(actor, db);
  return db;
}

export interface MMCandidate {
  index: number;
  clip: string;
  time: number;
  poseCost: number;
  trajCost: number;
  cost: number;
}

/** Weighted, normalised squared distance; returns all candidates sorted by cost (stable → deterministic). */
export function rankCandidates(db: MMDatabase, queryPose: number[], queryTraj: number[], wPose: number, wTraj: number): MMCandidate[] {
  const out = db.frames.map((f, index) => {
    let pc = 0;
    for (let j = 0; j < f.pose.length; j++) pc += ((f.pose[j] - queryPose[j]) / db.poseStd[j]) ** 2;
    let tc = 0;
    for (let j = 0; j < f.traj.length; j++) tc += ((f.traj[j] - queryTraj[j]) / db.trajStd[j]) ** 2;
    pc /= f.pose.length;
    tc /= f.traj.length;
    return { index, clip: f.clip, time: f.time, poseCost: pc, trajCost: tc, cost: wPose * pc + wTraj * tc };
  });
  return out.sort((a, b) => a.cost - b.cost || a.index - b.index);
}

/** Desired future root positions in character space for a desired velocity relative to the facing. */
export function queryTrajectory(speed: number, relAngle: number) {
  return TRAJ_T.flatMap((f) => [Math.sin(relAngle) * speed * f, Math.cos(relAngle) * speed * f]);
}
