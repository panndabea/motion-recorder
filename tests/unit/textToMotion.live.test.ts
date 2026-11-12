/**
 * Offline evaluation of real generated takes (not part of CI): set T2M_DIR to a folder with
 * Kimodo backend responses (`*.response.json`) and/or lab exports (`*.motion.json`).
 * Each take is retargeted (responses), exported to Motion JSON and GLB, reimported and compared.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMannequin } from '../../src/rig/mannequinLoader';
import { serializeMotion } from '../../src/export/jsonExporter';
import { exportMotionGlb } from '../../src/export/glbExporter';
import { parseMotionJson } from '../../src/import/jsonImporter';
import { importMotionGlb } from '../../src/import/glbImporter';
import { forwardKinematics } from '../../src/rig/rigDefinition';
import { sampleMotion } from '../../src/recording/motionPlayback';
import { BONES } from '../../src/rig/rigSpec';
import { retargetToMannequin, type GeneratedMotion } from '../../src/lab/textToMotion/retarget';
import { SOMA_MAPPING } from '../../src/lab/textToMotion/skeletons';
import { maxPoseDeltaDeg } from '../../src/lab/textToMotion/poseDelta';
import type { KimodoResponse } from '../../src/lab/textToMotion/generators/kimodoHttp';
import type { MotionData } from '../../src/recording/motionFormat';

const dir = process.env.T2M_DIR;

describe.skipIf(!dir)('generated takes: retarget, export, reimport', () => {
  it('roundtrips every take', async () => {
    const buf = readFileSync('public/models/mannequin.glb');
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const rig = await parseMannequin(bytes);
    const summary: Record<string, unknown>[] = [];
    for (const file of readdirSync(dir!).filter((f) => !f.includes('.mr.') && (f.endsWith('.response.json') || f.endsWith('.motion.json'))).sort()) {
      let motion: MotionData;
      let report: unknown;
      if (file.endsWith('.response.json')) {
        const d = JSON.parse(readFileSync(join(dir!, file), 'utf8')) as KimodoResponse & { prompt?: string };
        const J = d.jointNames.length;
        const frames = d.positions.length / (J * 3);
        const gen: GeneratedMotion = {
          skeleton: { id: 'soma30', jointNames: d.jointNames, parents: d.parents, restPositions: d.restPositions, mapping: SOMA_MAPPING, hipsJoint: 'Hips', noAlign: ['LeftShoulder', 'RightShoulder'] },
          fps: d.fps, frameCount: frames, globalRotations: Float32Array.from(d.globalRotations), positions: Float32Array.from(d.positions),
          provenance: { generator: 'kimodo-http', model: d.model, modelRevision: d.modelRevision, runtime: d.runtime, prompt: d.prompt ?? file, seed: d.seed, fps: d.fps, frames, latencyMs: d.latencyMs, generatedAt: new Date().toISOString(), extra: d.extra },
        };
        const r = retargetToMannequin(gen, rig.definition, rig.rawHeight, file.replace('.response.json', ''));
        motion = r.motion;
        report = r.report;
      } else {
        const v = parseMotionJson(readFileSync(join(dir!, file), 'utf8'), rig.definition);
        if (!v.ok) throw new Error(v.errors.join('; '));
        motion = v.motion;
      }
      const json = parseMotionJson(serializeMotion(motion), rig.definition);
      const glbBytes = await exportMotionGlb(rig.sourceBytes, motion, rig.definition);
      const glb = await importMotionGlb(glbBytes.slice().buffer, rig.definition);
      expect(json.ok).toBe(true);
      expect(glb.motions.length).toBe(1);
      const jsonDelta = json.ok ? maxPoseDeltaDeg(motion, json.motion) : NaN;
      const glbDelta = maxPoseDeltaDeg(motion, glb.motions[0]);
      // Contact quality (metres): lowest toe height, and horizontal toe travel while a toe is within 3 cm of
      // its lowest height over the take (i.e. presumed planted) — a proxy for foot sliding.
      const s = 1.75 / rig.rawHeight;
      const toes = [BONES.toeL, BONES.toeR];
      const frames = Array.from({ length: motion.frameCount }, (_, f) => forwardKinematics(rig.definition, sampleMotion(motion, f / motion.fps)));
      const minToe = Math.min(...frames.flatMap((fk) => toes.map((t) => fk.get(t)!.position.y * s)));
      let slide = 0;
      for (let f = 1; f < frames.length; f++)
        for (const t of toes) {
          const a = frames[f - 1].get(t)!.position, b = frames[f].get(t)!.position;
          if (a.y * s < minToe + 0.03 && b.y * s < minToe + 0.03) slide += Math.hypot(b.x - a.x, b.z - a.z) * s;
        }
      const h0 = frames[0].get(BONES.hips)!.position, h1 = frames[frames.length - 1].get(BONES.hips)!.position;
      const hipsY = frames.map((fk) => fk.get(BONES.hips)!.position.y * s);
      const hips0 = [h0.x * s, h0.y * s, h0.z * s].map((v) => +v.toFixed(3));
      const hips1 = [h1.x * s, h1.y * s, h1.z * s].map((v) => +v.toFixed(3));
      const hipsRange = [+Math.min(...hipsY).toFixed(3), +Math.max(...hipsY).toFixed(3)];
      writeFileSync(join(dir!, file.replace(/\.(response|motion)\.json$/, '.mr.motion.json')), serializeMotion(motion));
      writeFileSync(join(dir!, file.replace(/\.(response|motion)\.json$/, '.mr.glb')), glbBytes);
      summary.push({ file, frames: motion.frameCount, fps: motion.fps, jsonDeltaDeg: +jsonDelta.toFixed(4), glbDeltaDeg: +glbDelta.toFixed(4), glbMiB: +(glbBytes.byteLength / 2 ** 20).toFixed(2), minToeM: +minToe.toFixed(3), toeSlideM: +slide.toFixed(2), hipsStart: hips0, hipsEnd: hips1, hipsHeightRange: hipsRange, travelM: +Math.hypot(hips1[0] - hips0[0], hips1[2] - hips0[2]).toFixed(2), report });
    }
    writeFileSync(join(dir!, 'roundtrip-summary.json'), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary, null, 1));
  }, 600_000);
});
