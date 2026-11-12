import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { gazeController as gaze } from '../../../src/gaming-lab/experiments/gazeController';
import { animationLayers as layers, layerMask } from '../../../src/gaming-lab/experiments/animationLayers';
import { blendLayer, boneMask, crossfadeWeight } from '../../../src/gaming-lab/engine/blending/layers';
import { clampAngles, simulateFollower } from '../../../src/gaming-lab/engine/gaze/gaze';
import { bakeExperiment } from '../../../src/gaming-lab/engine/bake';
import { validateMotion } from '../../../src/recording/motionFormat';
import { loadActor } from './helpers';

describe('gaming lab – gaze', () => {
  it('tracks a target within limits', async () => {
    const actor = await loadActor();
    const off: Record<string, unknown> = {};
    const on: Record<string, unknown> = {};
    gaze.evaluate({ actor, t: 3, params: gaze.defaults, enabled: false, state: off, debug: null });
    gaze.evaluate({ actor, t: 3, params: gaze.defaults, enabled: true, state: on, debug: null });
    expect(on.angleError as number).toBeLessThan(6);
    expect(off.angleError as number).toBeGreaterThan(25);
  });

  it('clamps angles', () => {
    const c = clampAngles(2, -1, { maxYaw: 1, maxPitch: 0.5 });
    expect(c).toEqual({ yaw: 1, pitch: -0.5 });
  });

  it('follower is smooth, rate limited and deterministic', () => {
    const target = (t: number) => ({ yaw: t < 0.5 ? 0 : 1.5, pitch: 0 });
    const a = simulateFollower(target, 1, 0.1, 90);
    expect(a).toEqual(simulateFollower(target, 1, 0.1, 90));
    // 0.5 s at most 90°/s => at most 45° turned
    expect(a.yaw).toBeLessThanOrEqual((Math.PI / 4) * 1.05);
    let prev = 0;
    for (let t = 0; t <= 2; t += 0.05) {
      const y = simulateFollower(target, t, 0.1, 90).yaw;
      expect(Math.abs(y - prev)).toBeLessThan((90 * Math.PI) / 180 * 0.05 + 0.03);
      prev = y;
    }
  });

  it('bakes to valid motion', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(gaze, actor, { ...gaze.defaults, target: 'moving' }, 'gaze', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
  });
});

describe('gaming lab – animation layers', () => {
  it('blend weights interpolate between base and layer', () => {
    const a = new Quaternion();
    const b = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1);
    const base = new Map([['x', a]]);
    const layer = new Map([['x', b]]);
    expect(blendLayer(base, layer, null, 0, 'override').get('x')!.angleTo(a)).toBeLessThan(1e-6);
    expect(blendLayer(base, layer, null, 1, 'override').get('x')!.angleTo(b)).toBeLessThan(1e-6);
    expect(blendLayer(base, layer, null, 0.5, 'override').get('x')!.angleTo(a)).toBeCloseTo(0.5, 5);
    const additive = blendLayer(new Map([['x', b.clone()]]), layer, null, 1, 'additive', new Map([['x', a]]));
    expect(additive.get('x')!.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2))).toBeLessThan(1e-6);
  });

  it('masks isolate bones and keep quaternions valid', async () => {
    const actor = await loadActor();
    const mask = boneMask(actor.def, ['DEF-shoulder.R']);
    expect(mask.has('DEF-hand.R')).toBe(true);
    expect(mask.has('DEF-hand.L')).toBe(false);
    actor.sampleClip('Walk_Loop', 0.4);
    const walk = new Map([...actor.pose.rotations].map(([k, q]) => [k, q.clone()]));
    layers.evaluate({ actor, t: 0.4, params: layers.defaults, enabled: true, state: {}, debug: null });
    for (const [bone, q] of actor.pose.rotations) {
      expect(q.length()).toBeCloseTo(1, 6);
      if (!mask.has(bone)) expect(q.angleTo(walk.get(bone)!)).toBeLessThan(1e-6);
    }
    expect(actor.rot('DEF-upper_arm.R').angleTo(walk.get('DEF-upper_arm.R')!)).toBeGreaterThan(0.3);
    expect(layerMask(actor, { maskUpper: false, maskLeftArm: false, maskRightArm: false })).toBeNull();
  });

  it('crossfade weight is continuous and bounded', () => {
    expect(crossfadeWeight(0, 1, 1)).toBe(0);
    expect(crossfadeWeight(2.5, 1, 1)).toBe(1);
    expect(crossfadeWeight(1.5, 1, 1)).toBeCloseTo(0.5, 6);
  });

  it('bakes to valid motion', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(layers, actor, layers.defaults, 'layers', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
  });
});
