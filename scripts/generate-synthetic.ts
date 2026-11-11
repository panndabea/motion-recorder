/**
 * Generates src/tracking/synthetic/sequence.json: a repeatable landmark sequence made by sampling the
 * mannequin's own library clips and converting the posed skeleton to MediaPipe world landmarks.
 * Run with `npm run generate:synthetic`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Quaternion } from 'three';
import { parseMannequin } from '../src/rig/mannequinLoader';
import { forwardKinematics, type LocalPose } from '../src/rig/rigDefinition';
import { landmarksFromPose, sampleClip } from '../src/tracking/synthetic/synthesize';

const FPS = 30;
const SEGMENTS: Array<[string, number]> = [
  ['Idle_Loop', 2.5],
  ['Dance_Loop', 2],
  ['Punch_Jab', 1.7],
  ['Crouch_Idle_Loop', 2],
  ['Walk_Loop', 2.6],
  ['Idle_Loop', 1.2],
];
const BLEND_FRAMES = 8;

const root = join(import.meta.dirname, '..');
const buf = readFileSync(join(root, 'public/models/mannequin.glb'));
const rig = await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const restFk = forwardKinematics(rig.definition);

const poses: LocalPose[] = [];
const segments: Array<{ clip: string; start: number; duration: number }> = [];
for (const [name, duration] of SEGMENTS) {
  const clip = rig.clips.find((c) => c.name === name);
  if (!clip) throw new Error(`clip ${name} missing`);
  const seg = sampleClip(rig, clip, FPS, duration);
  const prev = poses[poses.length - 1];
  if (prev) {
    for (let i = 0; i < Math.min(BLEND_FRAMES, seg.length); i++) {
      const a = (i + 1) / (BLEND_FRAMES + 1);
      for (const [bone, q] of seg[i].rotations) q.copy(new Quaternion().copy(prev.rotations.get(bone)!).slerp(q, a));
      for (const [bone, p] of seg[i].translations) p.copy(prev.translations.get(bone)!.clone().lerp(p, a));
    }
  }
  segments.push({ clip: name, start: poses.length / FPS, duration: seg.length / FPS });
  poses.push(...seg);
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
const frames = poses.map((pose, i) =>
  landmarksFromPose(rig.definition, pose, restFk, rig.scale, (i * 1000) / FPS).world.map((p) => [r4(p.x), r4(p.y), r4(p.z), 0.99]),
);
const out = {
  fps: FPS,
  description: 'Synthetic MediaPipe world landmarks generated from the mannequin library clips (scripts/generate-synthetic.ts).',
  segments,
  frames,
};
writeFileSync(join(root, 'src/tracking/synthetic/sequence.json'), JSON.stringify(out));
console.log(`wrote ${frames.length} frames (${(frames.length / FPS).toFixed(1)} s)`);
