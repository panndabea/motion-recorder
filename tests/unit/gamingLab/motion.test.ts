import { describe, expect, it } from 'vitest';
import { animationRetiming as ret, inverseTimeMap, originalDuration, timeMap } from '../../../src/gaming-lab/experiments/animationRetiming';
import { secondaryMotion as sec, secondaryAngles, MAX_DEG } from '../../../src/gaming-lab/experiments/secondaryMotion';
import { motionWarping as warp, warpedHeading, warpedRoot } from '../../../src/gaming-lab/experiments/motionWarping';
import { estimateClipSpeed } from '../../../src/gaming-lab/engine/locomotion/gait';
import { bakeExperiment } from '../../../src/gaming-lab/engine/bake';
import { validateMotion } from '../../../src/recording/motionFormat';
import { loadActor } from './helpers';

describe('gaming lab – retiming', () => {
  for (const method of ['uniform', 'eased', 'phased']) {
    it(`${method}: hits the target duration, is monotonic and continuous`, () => {
      for (const T of [3, 5, 8, 12]) {
        const p = { ...ret.defaults, method, target: T };
        const D = 0.83;
        expect(timeMap(0, D, p)).toBeCloseTo(0, 6);
        expect(timeMap(T, D, p)).toBeCloseTo(D, 6);
        let prev = 0;
        for (let i = 1; i <= 600; i++) {
          const s = timeMap((i / 600) * T, D, p);
          expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
          expect(s - prev).toBeLessThan(0.1);
          prev = s;
        }
        expect(timeMap(inverseTimeMap(0.4, D, p), D, p)).toBeCloseTo(0.4, 3);
      }
    });
  }

  it('baked retimed action lasts the target duration with valid quaternions', async () => {
    const actor = await loadActor();
    const p = { ...ret.defaults, target: 8 };
    const m = bakeExperiment(ret, actor, p, 'retime', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
    expect(m.duration).toBeCloseTo(Math.max(8, originalDuration(p, actor)) + 0.8, 6);
    for (const tr of m.tracks) if (tr.property === 'rotation') for (const v of tr.values) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  it('measures a plausible natural walk speed', async () => {
    const actor = await loadActor();
    const v = estimateClipSpeed(actor, 'Walk_Loop');
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(2);
  });
});

describe('gaming lab – secondary motion', () => {
  it('is deterministic per seed and bounded', () => {
    const p = { ...sec.defaults, nervous: 1, head: 1, sway: 1, breathing: 1, shoulders: 1, follow: 1 };
    const other = { ...p, seed: 8 };
    let differs = false;
    for (let t = 0; t < 8; t += 0.1) {
      const a = secondaryAngles(p, t);
      expect(a).toEqual(secondaryAngles(p, t));
      expect(Math.abs(a.breathing)).toBeLessThanOrEqual(MAX_DEG.breathing + 1e-9);
      expect(Math.abs(a.sway.roll)).toBeLessThanOrEqual(MAX_DEG.sway + 1e-9);
      expect(Math.abs(a.head.yaw)).toBeLessThanOrEqual(MAX_DEG.head + 1e-9);
      expect(Math.abs(a.nervous.a)).toBeLessThanOrEqual(MAX_DEG.nervous + 1e-9);
      expect(Math.abs(a.follow)).toBeLessThanOrEqual(MAX_DEG.follow + 1e-9);
      if (Math.abs(secondaryAngles(other, t).head.yaw - a.head.yaw) > 1e-3) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('resets to the base pose when disabled and is smooth over time', async () => {
    const actor = await loadActor();
    sec.evaluate({ actor, t: 2, params: sec.defaults, enabled: false, state: {}, debug: null });
    const base = actor.rot('DEF-head').clone();
    actor.sampleClip('Idle_Loop', 0);
    expect(actor.rot('DEF-head').angleTo(base)).toBeLessThan(1e-9);
    let prev = null;
    for (let t = 0; t < 2; t += 1 / 30) {
      sec.evaluate({ actor, t, params: { ...sec.defaults, nervous: 1 }, enabled: true, state: {}, debug: null });
      const q = actor.rot('DEF-head').clone();
      if (prev) expect(q.angleTo(prev)).toBeLessThan(0.05);
      prev = q;
    }
  });

  it('bakes to valid motion', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(sec, actor, sec.defaults, 'sec', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
  });
});

describe('gaming lab – motion warping', () => {
  it('ends exactly at the target with the target orientation', async () => {
    const actor = await loadActor();
    const v = estimateClipSpeed(actor, 'Walk_Loop');
    for (const [tx, tz, yaw] of [[1.2, 2.2, 60], [-0.8, 4.2, 0], [1.6, 2, 90]]) {
      const p = { ...warp.defaults, tx, tz, yaw };
      const end = warpedRoot(10, v, p);
      expect(end.x).toBeCloseTo(tx, 6);
      expect(end.z).toBeCloseTo(tz, 6);
      expect(Math.abs(Math.atan2(Math.sin(warpedHeading(10, v, p) - (yaw * Math.PI) / 180), Math.cos(warpedHeading(10, v, p) - (yaw * Math.PI) / 180)))).toBeLessThan(0.02);
    }
  });

  it('trajectory and heading are smooth', async () => {
    const actor = await loadActor();
    const v = estimateClipSpeed(actor, 'Walk_Loop');
    const p = warp.defaults;
    for (let t = 0; t < 4.7; t += 0.02) {
      expect(warpedRoot(t + 0.02, v, p).distanceTo(warpedRoot(t, v, p))).toBeLessThan(0.08);
      expect(Math.abs(warpedHeading(t + 0.02, v, p) - warpedHeading(t, v, p))).toBeLessThan(0.1);
    }
  });

  it('bakes root motion into the hips track', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(warp, actor, warp.defaults, 'warp', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
    const hips = m.tracks.find((t) => t.bone === 'DEF-hips' && t.property === 'translation')!;
    const first = hips.values[0];
    const last = hips.values[hips.values.length - 1];
    expect(Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) * actor.scale).toBeGreaterThan(2);
  });
});
