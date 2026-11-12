import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { inverseKinematics as exp } from '../../../src/gaming-lab/experiments/inverseKinematics';
import { LIMBS, solveLimb } from '../../../src/gaming-lab/engine/ik/twoBone';
import { bakeExperiment } from '../../../src/gaming-lab/engine/bake';
import { validateMotion } from '../../../src/recording/motionFormat';
import { loadActor } from './helpers';

describe('gaming lab – inverse kinematics', () => {
  it('converges on reachable targets and preserves bone lengths', async () => {
    const actor = await loadActor();
    for (const target of [new Vector3(-0.2, 1.15, 0.25), new Vector3(-0.2, 1.8, 0), new Vector3(-0.45, 1.0, 0)]) {
      const state: Record<string, unknown> = {};
      exp.evaluate({ actor, t: 0.7, params: { ...exp.defaults, tx: target.x, ty: target.y, tz: target.z }, enabled: true, state, debug: null });
      expect(state.error as number).toBeLessThan(0.01);
      const fk = actor.fk();
      const upperLen = fk.get(LIMBS.armR.upper)!.position.distanceTo(fk.get(LIMBS.armR.lower)!.position);
      const lowerLen = fk.get(LIMBS.armR.lower)!.position.distanceTo(fk.get(LIMBS.armR.end)!.position);
      expect(upperLen).toBeCloseTo(actor.pose.translations.get(LIMBS.armR.lower)!.length(), 6);
      expect(lowerLen).toBeCloseTo(actor.pose.translations.get(LIMBS.armR.end)!.length(), 6);
      for (const b of [LIMBS.armR.upper, LIMBS.armR.lower]) expect(actor.rot(b).length()).toBeCloseTo(1, 6);
    }
  });

  it('handles unreachable targets by straightening toward them', async () => {
    const actor = await loadActor();
    const state: Record<string, unknown> = {};
    exp.evaluate({ actor, t: 0, params: { ...exp.defaults, tx: -0.4, ty: 1.3, tz: 1.8 }, enabled: true, state, debug: null });
    const fk = actor.fk();
    const s = fk.get(LIMBS.armR.upper)!.position, e = fk.get(LIMBS.armR.lower)!.position, h = fk.get(LIMBS.armR.end)!.position;
    const straight = s.distanceTo(h) / (s.distanceTo(e) + e.distanceTo(h));
    expect(straight).toBeGreaterThan(0.99);
    const dir = actor.worldToModel(new Vector3(-0.4, 1.3, 1.8)).sub(s).normalize();
    expect(h.clone().sub(s).normalize().dot(dir)).toBeGreaterThan(0.99);
    expect(Number.isFinite(state.error as number)).toBe(true);
  });

  it('is a no-op at strength 0 and when disabled', async () => {
    const actor = await loadActor();
    const ref: Record<string, unknown> = {};
    exp.evaluate({ actor, t: 1, params: exp.defaults, enabled: false, state: ref, debug: null });
    const q = actor.rot(LIMBS.armR.upper).clone();
    exp.evaluate({ actor, t: 1, params: { ...exp.defaults, strength: 0 }, enabled: true, state: {}, debug: null });
    expect(actor.rot(LIMBS.armR.upper).angleTo(q)).toBeLessThan(1e-6);
    expect(ref.error as number).toBeGreaterThan(0.05);
  });

  it('solves the degenerate pole case without NaNs', async () => {
    const actor = await loadActor();
    actor.sampleClip('Idle_Loop', 0);
    const s = actor.fk().get(LIMBS.armR.upper)!.position.clone();
    const res = solveLimb(actor, LIMBS.armR, s.clone().add(new Vector3(0, -0.3, 0)), new Vector3(0, -1, 0));
    expect(Number.isFinite(res.end.x + res.end.y + res.end.z)).toBe(true);
  });

  it('bakes into valid MotionRecorder data', async () => {
    const actor = await loadActor();
    const motion = bakeExperiment(exp, actor, exp.defaults, 'ik');
    expect(validateMotion(JSON.parse(JSON.stringify(motion)), actor.def).ok).toBe(true);
    expect(motion.frameCount).toBe(Math.round(2.5 * 30) + 1);
  });
});
