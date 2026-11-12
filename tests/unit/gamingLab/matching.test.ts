import { describe, expect, it } from 'vitest';
import { buildDatabase, poseFeatures, queryTrajectory, rankCandidates, POSE_DIMS } from '../../../src/gaming-lab/engine/motion/motionMatching';
import { motionMatching as mm, simulateMatching } from '../../../src/gaming-lab/experiments/motionMatching';
import { bakeExperiment } from '../../../src/gaming-lab/engine/bake';
import { validateMotion } from '../../../src/recording/motionFormat';
import { loadActor } from './helpers';

describe('gaming lab – motion matching', () => {
  it('extracts finite, normalisable features from real clips', async () => {
    const actor = await loadActor();
    const db = buildDatabase(actor);
    expect(db.frames.length).toBeGreaterThan(100);
    for (const f of db.frames) {
      expect(f.pose).toHaveLength(POSE_DIMS);
      for (const v of [...f.pose, ...f.traj]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(new Set(db.frames.map((f) => f.clip)).size).toBe(7);
  });

  it('ranks candidates by speed: idle, walk, sprint', async () => {
    const actor = await loadActor();
    const db = buildDatabase(actor);
    const pose = poseFeatures(actor, 'Walk_Loop', 0.3);
    const pick = (speed: number) => rankCandidates(db, pose, queryTrajectory(speed, 0), 0.2, 2)[0].clip;
    expect(pick(0)).toMatch(/Idle/);
    expect(pick(db.frames.find((f) => f.clip === 'Walk_Loop')!.speed)).toMatch(/Walk/);
    const fastest = [...db.frames].sort((a, b) => b.speed - a.speed)[0];
    expect(pick(fastest.speed)).toBe(fastest.clip);
    const ranked = rankCandidates(db, pose, queryTrajectory(1.2, 0), 1, 1);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].cost).toBeGreaterThanOrEqual(ranked[i - 1].cost);
  });

  it('selection is deterministic and changes with the input', async () => {
    const actor = await loadActor();
    const a = simulateMatching(actor, mm.defaults, true);
    const b = simulateMatching(actor, mm.defaults, true);
    expect(a.map((s) => `${s.clip}@${s.time.toFixed(4)}`)).toEqual(b.map((s) => `${s.clip}@${s.time.toFixed(4)}`));
    const clips = new Set(a.map((s) => s.clip));
    expect(clips.size).toBeGreaterThanOrEqual(3);
  });

  it('bakes to valid motion', async () => {
    const actor = await loadActor();
    const m = bakeExperiment(mm, actor, mm.defaults, 'mm', 10);
    expect(validateMotion(JSON.parse(JSON.stringify(m)), actor.def).ok).toBe(true);
  });
});
