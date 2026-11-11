import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { loadRig } from './helpers';
import { Retargeter, identityCalibration } from '../../src/rig/retargeting';
import { forwardKinematics, type LocalPose } from '../../src/rig/rigDefinition';
import { BONES, DRIVEN_BONES } from '../../src/rig/rigSpec';
import { landmarksFromPose, sampleClip } from '../../src/tracking/synthetic/synthesize';
import { LM, mediaPipeToBody } from '../../src/tracking/landmarks';

const DEG = 180 / Math.PI;

/** Bone segments whose world direction is fully observable from landmarks. */
const LIMBS: Array<[string, string]> = [
  [BONES.upperArmL, BONES.forearmL],
  [BONES.forearmL, BONES.handL],
  [BONES.upperArmR, BONES.forearmR],
  [BONES.forearmR, BONES.handR],
  [BONES.thighL, BONES.shinL],
  [BONES.shinL, BONES.footL],
  [BONES.thighR, BONES.shinR],
  [BONES.shinR, BONES.footR],
];

const emptyPose = (): LocalPose => ({ rotations: new Map(), translations: new Map() });

describe('Retargeter', () => {
  it('returns the rest pose for landmarks generated from the rest pose', async () => {
    const rig = await loadRig();
    const restFk = forwardKinematics(rig.definition);
    const frame = landmarksFromPose(rig.definition, emptyPose(), restFk, rig.scale, 0);
    const r = new Retargeter(rig.definition, { grounding: false });
    const result = r.solve(mediaPipeToBody(frame), identityCalibration());
    for (const name of DRIVEN_BONES) {
      expect(r.restLocalRotation(name).angleTo(result.rotations.get(name)!) * DEG, name).toBeLessThan(1);
    }
  });

  it.each(['Dance_Loop', 'Punch_Jab', 'Crouch_Idle_Loop', 'Walk_Loop', 'Sword_Attack'])(
    'reproduces limb directions, pelvis axis and head orientation of %s',
    async (clipName) => {
      const rig = await loadRig();
      const clip = rig.clips.find((c) => c.name === clipName)!;
      const restFk = forwardKinematics(rig.definition);
      const r = new Retargeter(rig.definition, { grounding: false });
      let worstLimb = 0;
      let worstPelvis = 0;
      let worstHead = 0;
      for (const [i, pose] of sampleClip(rig, clip, 15).entries()) {
        const frame = landmarksFromPose(rig.definition, pose, restFk, rig.scale, i / 15);
        const result = r.solve(mediaPipeToBody(frame), identityCalibration());
        const truth = forwardKinematics(rig.definition, pose);
        const solved = forwardKinematics(rig.definition, result);
        const dir = (fk: typeof truth, a: string, b: string) =>
          fk.get(b)!.position.clone().sub(fk.get(a)!.position).normalize();
        for (const [a, b] of LIMBS) worstLimb = Math.max(worstLimb, dir(truth, a, b).angleTo(dir(solved, a, b)));
        const lateral = (fk: typeof truth) => new Vector3(1, 0, 0).applyQuaternion(fk.get(BONES.hips)!.quaternion);
        worstPelvis = Math.max(worstPelvis, lateral(truth).angleTo(lateral(solved)));
        worstHead = Math.max(worstHead, truth.get(BONES.head)!.quaternion.angleTo(solved.get(BONES.head)!.quaternion));
      }
      expect(worstLimb * DEG).toBeLessThan(1);
      expect(worstPelvis * DEG).toBeLessThan(1);
      expect(worstHead * DEG).toBeLessThan(1);
    },
  );

  it('recovers upper-arm twist from the elbow bend plane', async () => {
    const rig = await loadRig();
    const restFk = forwardKinematics(rig.definition);
    const r = new Retargeter(rig.definition, { grounding: false });
    const restUpper = r.restLocalRotation(BONES.upperArmL);
    const restFore = r.restLocalRotation(BONES.forearmL);
    for (const twistDeg of [-60, 0, 45, 80]) {
      const pose = emptyPose();
      // Twist the upper arm about its own axis and bend the elbow about its natural hinge (local X).
      pose.rotations.set(BONES.upperArmL, restUpper.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), twistDeg / DEG)));
      pose.rotations.set(BONES.forearmL, restFore.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 70 / DEG)));
      const frame = landmarksFromPose(rig.definition, pose, restFk, rig.scale, 0);
      const result = r.solve(mediaPipeToBody(frame), identityCalibration());
      const err = pose.rotations.get(BONES.upperArmL)!.angleTo(result.rotations.get(BONES.upperArmL)!) * DEG;
      expect(err, `twist ${twistDeg}`).toBeLessThan(2);
    }
  });

  it('holds occluded limbs, then blends them back to rest', async () => {
    const rig = await loadRig();
    const restFk = forwardKinematics(rig.definition);
    const r = new Retargeter(rig.definition, { grounding: false, holdTime: 0.5, releaseTau: 0.2 });
    const pose = emptyPose();
    pose.rotations.set(BONES.upperArmL, r.restLocalRotation(BONES.upperArmL).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1)));
    const frame = mediaPipeToBody(landmarksFromPose(rig.definition, pose, restFk, rig.scale, 0));
    const tracked = r.solve(frame, identityCalibration()).rotations.get(BONES.upperArmL)!;

    frame.visibility[LM.leftElbow] = 0.1;
    const held = r.solve(frame, identityCalibration(), 0.1);
    expect(held.confidence.get(BONES.upperArmL)).toBe(0);
    expect(held.rotations.get(BONES.upperArmL)!.angleTo(tracked)).toBeLessThan(1e-4);

    let last = held;
    for (let i = 0; i < 40; i++) last = r.solve(frame, identityCalibration(), 0.1);
    expect(last.rotations.get(BONES.upperArmL)!.angleTo(r.restLocalRotation(BONES.upperArmL)) * DEG).toBeLessThan(1);
  });

  it('keeps the feet on the floor by lowering the hips while crouching', async () => {
    const rig = await loadRig();
    const clip = rig.clips.find((c) => c.name === 'Crouch_Idle_Loop')!;
    const restFk = forwardKinematics(rig.definition);
    const pose = sampleClip(rig, clip, 10)[0];
    const truth = forwardKinematics(rig.definition, pose);
    const r = new Retargeter(rig.definition, { grounding: true });
    const frame = mediaPipeToBody(landmarksFromPose(rig.definition, pose, restFk, rig.scale, 0));
    let result = r.solve(frame, identityCalibration());
    for (let i = 0; i < 60; i++) result = r.solve(frame, identityCalibration());
    const solved = forwardKinematics(rig.definition, result);
    const truthHips = truth.get(BONES.hips)!.position.y;
    const restHips = restFk.get(BONES.hips)!.position.y;
    expect(truthHips).toBeLessThan(restHips - 0.2);
    expect(Math.abs(solved.get(BONES.hips)!.position.y - truthHips)).toBeLessThan(0.06);
  });
});
