import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { NodeIO } from '@gltf-transform/core';
// @ts-expect-error gltf-validator ships without type declarations
import validator from 'gltf-validator';
import { loadRig, mannequinBytes } from './helpers';
import { exportMotionGlb } from '../../src/export/glbExporter';
import { importMotionGlb } from '../../src/import/glbImporter';
import { MotionRecorder } from '../../src/recording/motionRecorder';
import { sampleMotion, MotionPlayer } from '../../src/recording/motionPlayback';
import { parseMannequin } from '../../src/rig/mannequinLoader';
import { Retargeter, identityCalibration } from '../../src/rig/retargeting';
import { forwardKinematics } from '../../src/rig/rigDefinition';
import { DRIVEN_BONES, ROOT_MOTION_BONE } from '../../src/rig/rigSpec';
import { landmarksFromPose, sampleClip } from '../../src/tracking/synthetic/synthesize';
import { mediaPipeToBody } from '../../src/tracking/landmarks';

/** Records ~2 s of the Dance_Loop clip through the full landmark -> retarget -> record pipeline. */
async function recordDance() {
  const rig = await loadRig();
  const clip = rig.clips.find((c) => c.name === 'Dance_Loop')!;
  const restFk = forwardKinematics(rig.definition);
  const r = new Retargeter(rig.definition);
  const rec = new MotionRecorder(DRIVEN_BONES, [ROOT_MOTION_BONE]);
  rec.start(0);
  sampleClip(rig, clip, 30, 2).forEach((pose, i) => {
    const frame = landmarksFromPose(rig.definition, pose, restFk, rig.scale, (i * 1000) / 30);
    rec.addSample((i * 1000) / 30, r.solve(mediaPipeToBody(frame), identityCalibration(), 1 / 30));
  });
  const motion = rec.stop({ name: 'Dance capture', rig: rig.definition, rawHeight: rig.rawHeight, meta: { source: 'synthetic', rootMotion: 'vertical-grounded' } })!;
  return { rig, motion };
}

describe('GLB export', () => {
  it('produces a glTF-valid GLB with skin and exactly one animation targeting the joints', async () => {
    const { rig, motion } = await recordDance();
    const glb = await exportMotionGlb(mannequinBytes(), motion, rig.definition);

    const report = await validator.validateBytes(glb);
    expect(report.issues.numErrors, JSON.stringify(report.issues.messages.slice(0, 5))).toBe(0);

    const doc = await new NodeIO().readBinary(glb);
    const root = doc.getRoot();
    expect(root.listAnimations()).toHaveLength(1);
    expect(root.listSkins()).toHaveLength(1);
    expect(root.listMeshes().map((m) => m.getName())).toEqual(['Mannequin']);
    const joints = root.listSkins()[0].listJoints().map((j) => j.getName());
    expect(joints).toEqual(rig.definition.bones.map((b) => b.name));
    const anim = root.listAnimations()[0];
    expect(anim.getName()).toBe('Dance capture');
    const targets = new Set(anim.listChannels().map((c) => `${c.getTargetNode()!.getName()}/${c.getTargetPath()}`));
    for (const b of DRIVEN_BONES) expect(targets.has(`${b}/rotation`), b).toBe(true);
    expect(targets.has(`${ROOT_MOTION_BONE}/translation`)).toBe(true);
    // Every joint has a rotation channel (rest-pose channels for untracked joints).
    for (const j of joints) expect(targets.has(`${j}/rotation`), j).toBe(true);
    for (const s of anim.listSamplers()) {
      const times = s.getInput()!.getArray()!;
      expect(times[times.length - 1]).toBeCloseTo(motion.duration, 4);
      expect(s.getInterpolation()).toBe('LINEAR');
    }
    // Root node transforms are untouched (no coordinate-system change).
    const rootBone = root.listNodes().find((n) => n.getName() === 'root')!;
    expect(rootBone.getRotation().map((v) => +v.toFixed(4))).toEqual([-0.7071, 0, 0, 0.7071]);
    // Library clips are not bundled, so the file is much smaller than the source.
    expect(glb.byteLength).toBeLessThan(mannequinBytes().byteLength / 2);
  });

  it('reimports into a fresh mannequin and replays the same pose as the recording', async () => {
    const { rig, motion } = await recordDance();
    const glb = await exportMotionGlb(mannequinBytes(), motion, rig.definition);
    const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;

    const imported = await importMotionGlb(bytes, rig.definition);
    expect(imported.errors).toEqual([]);
    expect(imported.motions).toHaveLength(1);
    const back = imported.motions[0];
    expect(back.duration).toBeCloseTo(motion.duration, 4);

    // Play the GLB's own clip on a fresh instance built from the exported file itself.
    const fresh = await parseMannequin(bytes);
    expect(fresh.clips).toHaveLength(1);
    const player = new MotionPlayer(fresh);
    player.load(back);
    for (const t of [0, 0.4, 1.111, motion.duration]) {
      player.seek(t);
      const expected = sampleMotion(motion, t);
      for (const b of DRIVEN_BONES) {
        // Stored values are rounded to 6 decimals, so normalise before comparing angles.
        const q = fresh.bones.get(b)!.quaternion.clone().normalize();
        expect(q.angleTo(expected.rotations.get(b)!), `${b} @ ${t}`).toBeLessThan(1e-3);
      }
      expect(fresh.bones.get(ROOT_MOTION_BONE)!.position.distanceTo(expected.translations.get(ROOT_MOTION_BONE)!)).toBeLessThan(1e-4);
      // Untracked bones stay at rest.
      const restFinger = new Quaternion().fromArray(rig.definition.bones.find((x) => x.name === 'DEF-f_index.02.L')!.rotation);
      expect(fresh.bones.get('DEF-f_index.02.L')!.quaternion.angleTo(restFinger)).toBeLessThan(1e-4);
    }
  });

  it('rejects GLBs with a different skeleton', async () => {
    const { rig } = await recordDance();
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(mannequinBytes()));
    doc.getRoot().listNodes().find((n) => n.getName() === 'DEF-hand.L')!.setName('Hand_L');
    const glb = await io.writeBinary(doc);
    const res = await importMotionGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, rig.definition);
    expect(res.motions).toHaveLength(0);
    expect(res.errors.join()).toMatch(/skeleton/);
  });
});
