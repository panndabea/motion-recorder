import type { Params } from '../../../src/gaming-lab/engine/experiment';
import { describe, expect, it } from 'vitest';
import { footLocking as foot, footLockConfig } from '../../../src/gaming-lab/experiments/footLocking';
import { cupWorld, objectInteraction as obj, phases, CUP_START } from '../../../src/gaming-lab/experiments/objectInteraction';
import { simulateFootLock } from '../../../src/gaming-lab/engine/locomotion/footLock';
import { attachedWorld, attachmentOffset, decompose } from '../../../src/gaming-lab/engine/constraints/attachment';
import { bakeExperiment } from '../../../src/gaming-lab/engine/bake';
import { validateMotion } from '../../../src/recording/motionFormat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { loadActor } from './helpers';

describe('gaming lab – foot locking', () => {
  it('detects planted, transition and swing states', async () => {
    const actor = await loadActor();
    const sim = simulateFootLock(actor, footLockConfig(actor, foot.defaults, false));
    const states = new Set(sim.frames.map((f) => f.left.state));
    expect(states).toEqual(new Set(['planted', 'transition', 'swing']));
    let switches = 0;
    for (let i = 1; i < sim.frames.length; i++) if (sim.frames[i].left.state !== sim.frames[i - 1].left.state) switches++;
    expect(switches).toBeGreaterThanOrEqual(4);
  });

  for (const preset of foot.presets.filter((p) => ['Normal walk', 'Slowed walk', 'Root too slow'].includes(p.name))) {
    it(`removes most planted-foot sliding: ${preset.name}`, async () => {
      const actor = await loadActor();
      const params = { ...foot.defaults, ...preset.params };
      const sim = simulateFootLock(actor, footLockConfig(actor, params as Params, true));
      expect(sim.slideBaseline).toBeGreaterThan(0.1);
      expect(sim.slideLocked).toBeLessThan(sim.slideBaseline * 0.35);
    });
  }

  it('still reduces sliding (partially) when the root is too fast', async () => {
    const actor = await loadActor();
    for (const name of ['Incorrect root speed', 'Root far too fast (limit)']) {
      const params = { ...foot.defaults, ...foot.presets.find((p) => p.name === name)!.params };
      const sim = simulateFootLock(actor, footLockConfig(actor, params as Params, true));
      expect(sim.slideLocked).toBeLessThan(sim.slideBaseline);
    }
  });

  it('releases without snapping', async () => {
    const actor = await loadActor();
    const sim = simulateFootLock(actor, footLockConfig(actor, foot.defaults, true));
    let maxStep = 0;
    for (let i = 1; i < sim.frames.length; i++) for (const s of ['left', 'right'] as const) maxStep = Math.max(maxStep, sim.frames[i][s].achieved.distanceTo(sim.frames[i - 1][s].achieved));
    // fastest swing foot moves ~5 m/s at 60 Hz ≈ 8 cm per step; a snap would be much larger
    expect(maxStep).toBeLessThan(0.12);
  });

  it('bakes to valid motion', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(foot, actor, foot.defaults, 'foot', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
  });
});

describe('gaming lab – object interaction', () => {
  it('attachment offset reproduces and preserves world transforms', () => {
    const hand = new Matrix4().compose(new Vector3(0.1, 1, 0.3), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7), new Vector3(1, 1, 1));
    const object = new Matrix4().makeTranslation(0.2, 0.9, 0.35);
    const off = attachmentOffset(hand, object);
    expect(decompose(attachedWorld(hand, off)).position.distanceTo(new Vector3(0.2, 0.9, 0.35))).toBeLessThan(1e-9);
  });

  it('cup follows the hand while held, never teleports and ends at the place target', async () => {
    const actor = await loadActor();
    const params = obj.defaults;
    const D = obj.duration(params);
    let prev: Vector3 | null = null;
    let maxJump = 0;
    let held = 0;
    const state = {};
    for (let t = 0; t <= D; t += 1 / 60) {
      obj.evaluate({ actor, t, params, enabled: true, state, debug: null });
      const p = (state as { cupPos: Vector3 }).cupPos.clone();
      if ((state as { attached: boolean }).attached) held++;
      if (prev) maxJump = Math.max(maxJump, p.distanceTo(prev));
      prev = p;
    }
    expect(held).toBeGreaterThan(60);
    expect(maxJump).toBeLessThan(0.03);
    expect(Math.hypot(prev!.x - Number(params.bx), prev!.z - Number(params.bz))).toBeLessThan(0.05);
    expect(prev!.y).toBeLessThan(0.8);
  });

  it('reconstructs state deterministically when seeking', async () => {
    const actor = await loadActor();
    const params = obj.defaults;
    const mid = (phases(params).find((p) => p.name === 'move')!.start + phases(params).find((p) => p.name === 'move')!.end) / 2;
    const a = decompose(cupWorld(actor, params, mid, true, {}).m).position;
    for (const t of [0, 5, 1, 3]) obj.evaluate({ actor, t, params, enabled: true, state: {}, debug: null });
    obj.evaluate({ actor, t: mid, params, enabled: true, state: {}, debug: null });
    const b = decompose(cupWorld(actor, params, mid, true, {}).m).position;
    expect(a.distanceTo(b)).toBeLessThan(1e-9);
    expect(a.distanceTo(CUP_START)).toBeGreaterThan(0.05);
  });

  it('without attachment the cup stays on the table', async () => {
    const actor = await loadActor();
    const state = {};
    obj.evaluate({ actor, t: 4, params: obj.defaults, enabled: false, state, debug: null });
    expect((state as { cupPos: Vector3 }).cupPos.distanceTo(CUP_START)).toBeLessThan(1e-9);
  });
});
