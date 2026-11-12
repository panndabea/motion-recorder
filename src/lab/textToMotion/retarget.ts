import { Matrix4, Quaternion, Vector3 } from 'three';
import { MOTION_FORMAT, MOTION_VERSION, rigInfo, type MotionData, type MotionTrack } from '../../recording/motionFormat';
import { forwardKinematics, type RigDefinition } from '../../rig/rigDefinition';
import { BONES } from '../../rig/rigSpec';

/**
 * Skeleton a generative model writes. Positions are metres, +Y up, +Z forward (the character's front),
 * +X the character's left. Joint global rotations are relative to `restPositions` (identity = rest pose).
 */
export interface SourceSkeleton {
  id: string;
  jointNames: readonly string[];
  parents: readonly number[];
  restPositions: readonly (readonly [number, number, number])[];
  /** Source joint name -> mannequin bone (original glTF name). */
  mapping: Readonly<Record<string, string>>;
  hipsJoint: string;
  /**
   * Joints whose rest direction differs by design (clavicle shape) rather than by pose; they transfer
   * the rotation delta from rest without a rest-direction alignment.
   */
  noAlign?: readonly string[];
}

export interface GeneratorProvenance {
  generator: string;
  model: string;
  modelRevision?: string;
  runtime: string;
  prompt: string;
  seed: number;
  fps: number;
  frames: number;
  latencyMs: number;
  generatedAt: string;
  extra?: Record<string, unknown>;
}

/** Raw model output, before any retargeting. */
export interface GeneratedMotion {
  skeleton: SourceSkeleton;
  fps: number;
  frameCount: number;
  /** frameCount × joints × [x, y, z, w], source-global rotations. */
  globalRotations: Float32Array;
  /** frameCount × joints × 3, world positions in metres (y = 0 is the floor). */
  positions: Float32Array;
  provenance: GeneratorProvenance;
}

export function quatFromMatrix3RowMajor(m: ArrayLike<number>, o: number, out = new Quaternion()): Quaternion {
  const mat = new Matrix4().set(m[o], m[o + 1], m[o + 2], 0, m[o + 3], m[o + 4], m[o + 5], 0, m[o + 6], m[o + 7], m[o + 8], 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(mat).normalize();
}

/** Converts a frames × joints × 3 × 3 row-major rotation-matrix array to xyzw quaternions. */
export function matricesToQuaternions(values: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(count * 4);
  const q = new Quaternion();
  for (let i = 0; i < count; i++) {
    quatFromMatrix3RowMajor(values, i * 9, q);
    out.set([q.x, q.y, q.z, q.w], i * 4);
  }
  return out;
}

interface Binding {
  source: number;
  bone: string;
  /** Swing that turns the mannequin's rest bone direction onto the source's rest bone direction. */
  align: Quaternion;
}

function firstMappedDescendant(skel: SourceSkeleton, joint: number): number {
  const queue = skel.parents.flatMap((p, i) => (p === joint ? [i] : []));
  while (queue.length) {
    const j = queue.shift()!;
    if (skel.mapping[skel.jointNames[j]]) return j;
    queue.push(...skel.parents.flatMap((p, i) => (p === j ? [i] : [])));
  }
  return -1;
}

export interface RetargetReport {
  /** Per mapped bone: angle (deg) between source and mannequin rest directions that the alignment absorbed. */
  restMismatchDeg: Record<string, number>;
  unmappedSourceJoints: string[];
  heightScale: number;
}

/**
 * Retargets source-global joint rotations onto the mannequin:
 * targetGlobal(t) = sourceGlobal(t) · align · targetRestGlobal, then local = parentGlobal⁻¹ · targetGlobal.
 * Unmapped mannequin bones keep their rest local rotation; the hips receive the scaled source hips path.
 */
export function retargetToMannequin(
  gen: GeneratedMotion,
  def: RigDefinition,
  rawHeight: number,
  name: string,
): { motion: MotionData; report: RetargetReport } {
  const skel = gen.skeleton;
  const J = skel.jointNames.length;
  const rest = forwardKinematics(def);
  const byName = new Map(def.bones.map((b) => [b.name, b]));
  const report: RetargetReport = { restMismatchDeg: {}, unmappedSourceJoints: [], heightScale: 1 };

  const bindings = new Map<string, Binding>();
  skel.jointNames.forEach((jn, j) => {
    const bone = skel.mapping[jn];
    if (!bone) return void report.unmappedSourceJoints.push(jn);
    if (!byName.has(bone)) throw new Error(`Mannequin has no bone ${bone}`);
    const align = new Quaternion();
    const c = firstMappedDescendant(skel, j);
    if (c >= 0 && jn !== skel.hipsJoint && !skel.noAlign?.includes(jn)) {
      const ds = new Vector3(...skel.restPositions[c]).sub(new Vector3(...skel.restPositions[j])).normalize();
      const dt = rest.get(skel.mapping[skel.jointNames[c]])!.position.clone().sub(rest.get(bone)!.position).normalize();
      align.setFromUnitVectors(dt, ds);
      report.restMismatchDeg[bone] = Math.round((Math.acos(Math.min(1, Math.max(-1, ds.dot(dt)))) * 1800) / Math.PI) / 10;
    }
    bindings.set(bone, { source: j, bone, align });
  });

  const hipsIdx = skel.jointNames.indexOf(skel.hipsJoint);
  const minRestY = (pts: readonly (readonly number[])[]) => Math.min(...pts.map((p) => p[1]));
  const srcHipsHeight = skel.restPositions[hipsIdx][1] - minRestY(skel.restPositions);
  const restPts = [...rest.values()].map((t) => t.position.toArray());
  const floorY = minRestY(restPts);
  const tgtHipsHeight = rest.get(BONES.hips)!.position.y - floorY;
  const scale = tgtHipsHeight / srcHipsHeight;
  report.heightScale = scale;
  const hipsParentInv = rest.get(byName.get(BONES.hips)!.parent!)!.matrix.clone().invert();

  const times: number[] = [];
  const rot = new Map<string, number[][]>();
  const hipsT: number[][] = [];
  const prev = new Map<string, Quaternion>();
  const globals = new Map<string, Quaternion>();
  const sg = new Quaternion();
  for (let f = 0; f < gen.frameCount; f++) {
    times.push(f / gen.fps);
    globals.clear();
    for (const b of def.bones) {
      const parentG = b.parent ? globals.get(b.parent)! : new Quaternion();
      const bind = bindings.get(b.name);
      let local: Quaternion;
      let g: Quaternion;
      if (bind) {
        const o = (f * J + bind.source) * 4;
        sg.set(gen.globalRotations[o], gen.globalRotations[o + 1], gen.globalRotations[o + 2], gen.globalRotations[o + 3]);
        g = sg.clone().multiply(bind.align).multiply(rest.get(b.name)!.quaternion);
        local = parentG.clone().invert().multiply(g).normalize();
        const p = prev.get(b.name);
        if (p && p.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
        prev.set(b.name, local);
        if (!rot.has(b.name)) rot.set(b.name, []);
        rot.get(b.name)!.push([local.x, local.y, local.z, local.w]);
      } else {
        local = new Quaternion().fromArray(b.rotation);
        g = parentG.clone().multiply(local);
      }
      globals.set(b.name, g);
    }
    const o = (f * J + hipsIdx) * 3;
    const world = new Vector3(gen.positions[o] * scale, gen.positions[o + 1] * scale + floorY, gen.positions[o + 2] * scale);
    hipsT.push(world.applyMatrix4(hipsParentInv).toArray());
  }

  const tracks: MotionTrack[] = [...rot].map(([bone, values]) => ({ bone, property: 'rotation', times: [...times], values }));
  tracks.push({ bone: BONES.hips, property: 'translation', times: [...times], values: hipsT });
  const duration = times[times.length - 1] ?? 0;
  return {
    report,
    motion: {
      format: MOTION_FORMAT,
      version: MOTION_VERSION,
      name,
      createdAt: gen.provenance.generatedAt,
      duration,
      fps: gen.fps,
      frameCount: gen.frameCount,
      space: 'local',
      quaternionOrder: 'xyzw',
      interpolation: 'linear',
      rig: rigInfo(def, rawHeight),
      tracks,
      meta: { source: 'generative', rootMotion: 'clip', app: 'motion-recorder/text-to-motion-lab', generator: gen.provenance },
    },
  };
}
