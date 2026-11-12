import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMannequin, type MannequinRig } from '../../src/rig/mannequinLoader';
import { forwardKinematics } from '../../src/rig/rigDefinition';
import { BONES } from '../../src/rig/rigSpec';
import { sampleMotion } from '../../src/recording/motionPlayback';
import { validateMotion } from '../../src/recording/motionFormat';
import { retargetToMannequin, type GeneratedMotion } from '../../src/lab/textToMotion/retarget';
import { core27Skeleton } from '../../src/lab/textToMotion/skeletons';

const fx = JSON.parse(readFileSync('tests/fixtures/ardyCore27.json', 'utf8'));
const skel = core27Skeleton(fx.joint_names, fx.parents, fx.neutral_joints);
let rig: MannequinRig;
beforeAll(async () => {
  const buf = readFileSync('public/models/mannequin.glb');
  rig = await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
});

/** Two frames: rest, then the left arm swung down 90° about +Z (world) and hips raised by 0.1 m. */
function fakeMotion(): GeneratedMotion {
  const J = skel.jointNames.length;
  const rot = new Float32Array(2 * J * 4);
  const pos = new Float32Array(2 * J * 3);
  const down = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const lowest = Math.min(...fx.neutral_joints.map((p: number[]) => p[1]));
  for (let f = 0; f < 2; f++)
    for (let j = 0; j < J; j++) {
      const name = skel.jointNames[j];
      const inLeftArm = /^Left(Arm|ForeArm|Hand)/.test(name);
      const q = f === 1 && inLeftArm ? down : new Quaternion();
      rot.set([q.x, q.y, q.z, q.w], (f * J + j) * 4);
      const p = fx.neutral_joints[j];
      pos.set([p[0], p[1] - lowest + (f === 1 ? 0.1 : 0), p[2]], (f * J + j) * 3);
    }
  return {
    skeleton: skel, fps: 20, frameCount: 2, globalRotations: rot, positions: pos,
    provenance: { generator: 'test', model: 'none', runtime: 'test', prompt: 't', seed: 0, fps: 20, frames: 2, latencyMs: 0, generatedAt: new Date(0).toISOString() },
  };
}

describe('text-to-motion retargeting onto the mannequin', () => {
  it('maps the source rest pose to the mannequin rest pose and keeps it a valid motion', () => {
    const { motion, report } = retargetToMannequin(fakeMotion(), rig.definition, rig.rawHeight, 't');
    expect(validateMotion(motion, rig.definition).ok).toBe(true);
    expect(motion.meta.source).toBe('generative');
    for (const deg of Object.values(report.restMismatchDeg)) expect(deg).toBeLessThan(25);
    expect(report.restMismatchDeg).not.toHaveProperty(BONES.shoulderL);
    const pose = sampleMotion(motion, 0);
    for (const b of rig.definition.bones) {
      const q = pose.rotations.get(b.name);
      if (q && !b.name.startsWith('DEF-toe')) expect(q.angleTo(new Quaternion().fromArray(b.rotation)) * 57.3).toBeLessThan(25);
    }
  });

  it('reproduces world-space limb directions and the scaled hips path', () => {
    const { motion, report } = retargetToMannequin(fakeMotion(), rig.definition, rig.rawHeight, 't');
    const fk0 = forwardKinematics(rig.definition, sampleMotion(motion, 0));
    const fk1 = forwardKinematics(rig.definition, sampleMotion(motion, motion.duration));
    const dir = (fk: typeof fk1, a: string, b: string) => fk.get(b)!.position.clone().sub(fk.get(a)!.position).normalize();
    expect(dir(fk1, BONES.upperArmL, BONES.forearmL).angleTo(new Vector3(0, -1, 0)) * 57.3).toBeLessThan(3);
    expect(dir(fk1, BONES.forearmL, BONES.handL).angleTo(new Vector3(0, -1, 0)) * 57.3).toBeLessThan(3);
    expect(dir(fk1, BONES.upperArmR, BONES.forearmR).angleTo(new Vector3(-1, 0, 0)) * 57.3).toBeLessThan(3);
    const rise = fk1.get(BONES.hips)!.position.y - fk0.get(BONES.hips)!.position.y;
    expect(rise).toBeCloseTo(0.1 * report.heightScale, 3);
    expect(Math.abs(fk0.get(BONES.hips)!.position.y - forwardKinematics(rig.definition).get(BONES.hips)!.position.y)).toBeLessThan(0.02);
  });
});
