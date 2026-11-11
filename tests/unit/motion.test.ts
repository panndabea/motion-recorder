import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { loadRig } from './helpers';
import { MotionRecorder } from '../../src/recording/motionRecorder';
import type { MotionData } from '../../src/recording/motionFormat';
import { MotionPlayer, motionToClip, sampleMotion } from '../../src/recording/motionPlayback';
import { serializeMotion } from '../../src/export/jsonExporter';
import { parseMotionJson } from '../../src/import/jsonImporter';
import { BONES, DRIVEN_BONES, ROOT_MOTION_BONE, toThreeName } from '../../src/rig/rigSpec';
import type { LocalPose } from '../../src/rig/rigDefinition';

const axis = new Vector3(0, 0, 1);

/** Pose at time t: upper arm rotates about Z by t radians; hips bob vertically. */
function poseAt(t: number, rest: (b: string) => Quaternion): LocalPose {
  const rotations = new Map<string, Quaternion>();
  for (const b of DRIVEN_BONES) rotations.set(b, rest(b));
  rotations.set(BONES.upperArmL, rest(BONES.upperArmL).multiply(new Quaternion().setFromAxisAngle(axis, t)));
  const translations = new Map([[ROOT_MOTION_BONE, new Vector3(0, 0.05, 0.9167 + 0.1 * t)]]);
  return { rotations, translations };
}

async function recordSynthetic(durationS = 2, jitter = true): Promise<{ motion: MotionData; rest: (b: string) => Quaternion }> {
  const rig = await loadRig();
  const byName = new Map(rig.definition.bones.map((b) => [b.name, b]));
  const rest = (b: string) => new Quaternion().fromArray(byName.get(b)!.rotation);
  const rec = new MotionRecorder(DRIVEN_BONES, [ROOT_MOTION_BONE]);
  rec.start(1000);
  // Irregular frame times (dropped frames) between 0 and durationS.
  let t = 0;
  let i = 0;
  while (t <= durationS + 1e-9) {
    rec.addSample(1000 + t * 1000, poseAt(t, rest));
    t += jitter ? [1 / 60, 1 / 25, 1 / 12, 1 / 30][i++ % 4] : 1 / 30;
  }
  rec.addSample(1000 + durationS * 1000, poseAt(durationS, rest));
  const motion = rec.stop({
    name: 'Test motion',
    fps: 30,
    rig: rig.definition,
    rawHeight: rig.rawHeight,
    meta: { source: 'synthetic', rootMotion: 'vertical-grounded' },
  })!;
  return { motion, rest };
}

describe('MotionRecorder', () => {
  it('bakes irregular samples onto a uniform 30 fps time base', async () => {
    const { motion } = await recordSynthetic(2);
    expect(motion.fps).toBe(30);
    expect(motion.frameCount).toBe(61);
    expect(motion.duration).toBeCloseTo(2, 6);
    for (const track of motion.tracks) {
      expect(track.times.length).toBe(61);
      track.times.forEach((tm, i) => expect(tm).toBeCloseTo(i / 30, 5));
    }
    expect(motion.tracks.filter((t) => t.property === 'rotation').map((t) => t.bone)).toEqual([...DRIVEN_BONES]);
  });

  it('stores unit, hemisphere-continuous quaternions', async () => {
    const { motion } = await recordSynthetic(3);
    for (const track of motion.tracks.filter((t) => t.property === 'rotation')) {
      track.values.forEach((v, i) => {
        expect(Math.hypot(...v)).toBeCloseTo(1, 4);
        if (i > 0) {
          const p = track.values[i - 1];
          expect(p[0] * v[0] + p[1] * v[1] + p[2] * v[2] + p[3] * v[3]).toBeGreaterThan(0);
        }
      });
    }
  });

  it('returns null when nothing was captured', () => {
    const rec = new MotionRecorder(DRIVEN_BONES, []);
    rec.start(0);
    expect(rec.stop({ name: 'x', rig: { id: 'r', bones: [] }, rawHeight: 1, meta: { source: 'webcam', rootMotion: 'none' } })).toBeNull();
  });
});

describe('Playback', () => {
  it('interpolates between keys (slerp) and matches the recorded pose', async () => {
    const { motion, rest } = await recordSynthetic(2, false);
    for (const t of [0, 0.5, 1.01, 1.37, 2]) {
      const pose = sampleMotion(motion, t);
      const expected = poseAt(t, rest).rotations.get(BONES.upperArmL)!;
      expect(pose.rotations.get(BONES.upperArmL)!.angleTo(expected)).toBeLessThan(1e-3);
      expect(pose.translations.get(ROOT_MOTION_BONE)!.z).toBeCloseTo(0.9167 + 0.1 * t, 4);
    }
  });

  it('generates an AnimationClip bound to sanitised mannequin bone names', async () => {
    const { motion } = await recordSynthetic(1);
    const clip = motionToClip(motion);
    expect(clip.duration).toBeCloseTo(1, 6);
    expect(clip.tracks.map((t) => t.name)).toContain(`${toThreeName('DEF-upper_arm.L')}.quaternion`);
    expect(clip.tracks.map((t) => t.name)).toContain('DEF-hips.position');
    expect(clip.validate()).toBe(true);
  });

  it('drives a fresh mannequin instance deterministically (play, seek, restart)', async () => {
    const { motion, rest } = await recordSynthetic(2, false);
    const rig = await loadRig();
    const player = new MotionPlayer(rig);
    player.setLoop(false);
    player.load(motion);
    const bone = rig.bones.get(BONES.upperArmL)!;
    player.seek(1.25);
    expect(bone.quaternion.angleTo(poseAt(1.25, rest).rotations.get(BONES.upperArmL)!)).toBeLessThan(1e-3);
    player.play();
    player.update(0.5);
    expect(player.time).toBeCloseTo(1.75, 5);
    expect(bone.quaternion.angleTo(poseAt(1.75, rest).rotations.get(BONES.upperArmL)!)).toBeLessThan(1e-3);
    player.update(5);
    expect(player.finished).toBe(true);
    player.restart();
    expect(player.time).toBe(0);
    player.unload();
    expect(bone.quaternion.angleTo(rest(BONES.upperArmL))).toBeLessThan(1e-6);
  });
});

describe('Motion JSON', () => {
  it('round-trips through serialisation and validation without loss', async () => {
    const rig = await loadRig();
    const { motion } = await recordSynthetic(2);
    const result = parseMotionJson(serializeMotion(motion), rig.definition);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.motion.tracks).toEqual(motion.tracks);
    expect(result.motion.duration).toBe(motion.duration);
    expect(result.motion.name).toBe(motion.name);
    expect(result.motion.rig.signature).toBe(motion.rig.signature);
  });

  const mutate = async (fn: (m: Record<string, unknown>) => void) => {
    const rig = await loadRig();
    const { motion } = await recordSynthetic(1);
    const copy = JSON.parse(serializeMotion(motion));
    fn(copy);
    return parseMotionJson(JSON.stringify(copy), rig.definition);
  };

  it.each([
    ['wrong format', (m: any) => (m.format = 'bvh'), /Unknown format/],
    ['future version', (m: any) => (m.version = 99), /newer than supported/],
    ['other rig', (m: any) => (m.rig.id = 'mixamo'), /rig "mixamo"/],
    ['other skeleton', (m: any) => (m.rig.signature = 'deadbeef'), /does not match/],
    ['non-monotonic times', (m: any) => (m.tracks[0].times[3] = 0), /strictly increasing/],
    ['mismatched lengths', (m: any) => m.tracks[0].values.pop(), /times but/],
    ['non-unit quaternion', (m: any) => (m.tracks[0].values[2] = [0, 0, 0, 3]), /not unit length/],
    ['NaN value', (m: any) => (m.tracks[0].values[2] = [0, 0, null, 1]), /finite numbers/],
    ['time beyond duration', (m: any) => (m.duration = 0.5), /beyond the duration/],
    ['missing tracks', (m: any) => delete m.tracks, /Missing tracks/],
  ])('rejects %s', async (_label, fn, pattern) => {
    const r = await mutate(fn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(pattern);
  });

  it('rejects malformed JSON and non-objects', async () => {
    const rig = await loadRig();
    expect(parseMotionJson('{"format": ', rig.definition).ok).toBe(false);
    expect(parseMotionJson('[1,2,3]', rig.definition).ok).toBe(false);
  });

  it('skips unknown bones with a warning', async () => {
    const r = await mutate((m: any) => m.tracks.push({ bone: 'DEF-tail', property: 'rotation', times: [0], values: [[0, 0, 0, 1]] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/DEF-tail/);
  });

  it('normalises slightly denormalised quaternions', async () => {
    const r = await mutate((m: any) => (m.tracks[0].values[1] = m.tracks[0].values[1].map((v: number) => v * 1.05)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.hypot(...r.motion.tracks[0].values[1])).toBeCloseTo(1, 6);
  });
});
