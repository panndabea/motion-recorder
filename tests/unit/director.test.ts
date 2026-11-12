import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { parseMannequin, type MannequinRig } from '../../src/rig/mannequinLoader';
import { rigSignature } from '../../src/rig/rigDefinition';
import { validateMotion } from '../../src/recording/motionFormat';
import { sampleMotion } from '../../src/recording/motionPlayback';
import { exportMotionGlb } from '../../src/export/glbExporter';
import { importMotionGlb } from '../../src/import/glbImporter';
import { validateCommands, type DirectorAction, type DirectorCommand } from '../../src/director/ai/commandSchema';
import { parseDirection } from '../../src/director/ai/commandParser';
import { applyCommand, resolveDependencies, simulate } from '../../src/director/planning/actionPlanner';
import { ComposerContext, composePerformance } from '../../src/director/animation/motionComposer';
import { bakeActorMotion, bakeGlass } from '../../src/director/animation/animationBaker';
import { exportSceneGlb, verifySceneGlb } from '../../src/director/export/directorExporter';
import { newProject, parseProjectText, serializeProject } from '../../src/director/persistence/directorProject';
import { UndoHistory } from '../../src/director/timeline/undoRedo';
import { defaultScene, type DirectorScene } from '../../src/director/scene/sceneModel';

let rig: MannequinRig;
let ctx: ComposerContext;
const scene: DirectorScene = defaultScene();
const objectIds = scene.objects.map((o) => o.id);

beforeAll(async () => {
  const buf = readFileSync('public/models/mannequin.glb');
  rig = await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  ctx = new ComposerContext(rig);
});

function ids() {
  let n = 0;
  return () => `a${++n}`;
}

/** Applies a sequence of prompts like the Director chat does. */
function direct(prompts: string[], start: DirectorAction[] = [], next = ids()) {
  let actions = start;
  for (const p of prompts) {
    const parsed = parseDirection(p, { hasSequence: actions.length > 0, existingTypes: actions.map((a) => a.type) });
    expect(parsed.unsupported, p).toEqual([]);
    const v = validateCommands(parsed.commands, { objectIds });
    if (!v.ok) throw new Error(v.errors.join(' '));
    for (const c of v.commands) {
      const r = applyCommand(actions, c, scene, next);
      expect(r.errors, p).toEqual([]);
      actions = r.actions;
    }
  }
  return actions;
}

const FULL = 'Walk to the table, pick up the glass, look around nervously and put it back on the table.';

describe('command schema', () => {
  it('accepts the PRD example and fills defaults', () => {
    const v = validateCommands(
      {
        operation: 'create_sequence',
        actions: [
          { type: 'walk_to', target: 'table', speed: 0.7 },
          { type: 'reach', target: 'glass' },
          { type: 'grip', target: 'glass' },
          { type: 'look_around', duration: 1.8, style: 'nervous' },
          { type: 'place', object: 'glass', target: 'table', speed: 0.5 },
        ],
      },
      { objectIds },
    );
    expect(v.ok).toBe(true);
  });
  it('rejects unknown actions, missing objects and out-of-range values', () => {
    for (const bad of [
      { operation: 'create_sequence', actions: [{ type: 'dance' }] },
      { operation: 'create_sequence', actions: [{ type: 'walk_to', target: 'sofa' }] },
      { operation: 'create_sequence', actions: [{ type: 'walk_to', target: 'table', speed: 99 }] },
      { operation: 'create_sequence', actions: [{ type: 'grip', target: 'table' }] },
      { operation: 'teleport', actions: [] },
      'rm -rf',
    ]) {
      const v = validateCommands(bad, { objectIds });
      expect(v.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('rule-based parser', () => {
  const empty = { hasSequence: false, existingTypes: [] };
  const existing = { hasSequence: true, existingTypes: [] };
  it('maps supported instructions (English and German)', () => {
    const types = (t: string, c = empty) => (parseDirection(t, c).commands[0] as { actions: { type: string }[] }).actions.map((a) => a.type);
    expect(types('Walk to the table.')).toEqual(['walk_to']);
    expect(types('Pick up the glass.')).toEqual(['reach', 'grip', 'lift']);
    expect(types('Look to the left.')).toEqual(['look_at']);
    expect(types('Look around nervously.')).toEqual(['look_around']);
    expect(types(FULL)).toEqual(['walk_to', 'reach', 'grip', 'lift', 'look_around', 'place']);
    expect(types('Geh zum Tisch und nimm das Glas.')).toEqual(['walk_to', 'reach', 'grip', 'lift']);
    const walk = (parseDirection('Walk slowly while bending forward.', empty).commands[0] as { actions: { speed?: number; bend?: number }[] }).actions[0];
    expect(walk.speed).toBeLessThan(1);
    expect(walk.bend).toBeGreaterThan(0);
  });
  it('maps follow-up edits to targeted operations', () => {
    const op = (t: string) => parseDirection(t, existing).commands[0];
    expect(op('Do it more slowly.')).toMatchObject({ operation: 'modify_actions', changes: { speedFactor: 0.7 } });
    expect(op('Make him more cautious.')).toMatchObject({ operation: 'modify_actions', changes: { style: 'cautious' } });
    expect(op('Look around before putting down the glass.')).toMatchObject({ operation: 'insert_actions', position: 'before', anchor: { type: 'place' } });
    expect(op('Pause before releasing the glass.')).toMatchObject({ operation: 'insert_pause', anchor: { type: 'release' } });
    expect(op('Move the hesitation to the end.')).toMatchObject({ operation: 'move_actions', to: 'end' });
    expect(op('Make the walk more exaggerated.')).toMatchObject({ operation: 'modify_style', match: { type: 'walk_to' } });
    expect(parseDirection('Keep the first part unchanged.', existing).commands).toEqual([]);
  });
  it('reports unsupported instructions instead of inventing motion', () => {
    const r = parseDirection('Do a backflip and juggle.', empty);
    expect(r.commands).toEqual([]);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });
});

describe('planner', () => {
  it('inserts prerequisites (walk, reach, release) and keeps user actions', () => {
    const r = applyCommand([], { operation: 'create_sequence', actions: [{ type: 'grip', target: 'glass' }, { type: 'place', object: 'glass', target: 'table' }] }, scene, ids());
    expect(r.ok).toBe(true);
    expect(r.actions.map((a) => a.type)).toEqual(['walk_to', 'reach', 'grip', 'place', 'release']);
    expect(r.actions.filter((a) => a.auto).map((a) => a.type)).toEqual(['walk_to', 'reach', 'release']);
    expect(simulate(r.actions, scene).issues).toEqual([]);
  });
  it('rejects invalid state transitions it cannot fix', () => {
    const r = applyCommand([], { operation: 'create_sequence', actions: [{ type: 'release', object: 'glass' }] }, scene, ids());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not holding/);
  });
  it('fails clearly when an edit references a missing action', () => {
    const r = applyCommand([], { operation: 'insert_actions', position: 'before', anchor: { type: 'place' }, actions: [{ type: 'pause' }] }, scene, ids());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no place/);
  });
  it('tracks the glass state machine', () => {
    const actions = direct([FULL]);
    const phases = simulate(actions, scene).steps.map((s) => s.after.glassPhase);
    expect(phases).toEqual(['on_table', 'reached', 'held', 'held', 'held', 'placed', 'released']);
  });
});

describe('motion composer', () => {
  it('is deterministic and seek-order independent', () => {
    const actions = direct([FULL]);
    const a = composePerformance(ctx, scene, actions);
    const b = composePerformance(ctx, scene, actions);
    const ts = [5.1, 0.3, 3.3, 7, 1.7];
    for (const t of ts) {
      const fa = a.evaluate(t);
      const fb = b.evaluate(t);
      for (const [bone, q] of fa.pose.rotations) expect(q.equals(fb.pose.rotations.get(bone)!), `${bone}@${t}`).toBe(true);
      expect(fa.glass.position).toEqual(fb.glass.position);
      expect(fa.glassState).toBe(fb.glassState);
    }
  });

  it('produces continuous, valid motion and reaches the glass', () => {
    const actions = direct([FULL]);
    const perf = composePerformance(ctx, scene, actions);
    expect(perf.issues).toEqual([]);
    let prev = perf.evaluate(0);
    let maxJump = 0;
    for (let t = 1 / 60; t <= perf.duration; t += 1 / 60) {
      const f = perf.evaluate(t);
      for (const [bone, q] of f.pose.rotations) {
        expect(Math.abs(q.length() - 1)).toBeLessThan(1e-4);
        const p = prev.pose.rotations.get(bone)!;
        maxJump = Math.max(maxJump, 2 * Math.acos(Math.min(1, Math.abs(q.dot(p)))));
      }
      const g0 = new Vector3(...prev.glass.position);
      expect(g0.distanceTo(new Vector3(...f.glass.position))).toBeLessThan(0.05);
      prev = f;
    }
    expect(maxJump).toBeLessThan(0.3);
    const grip = perf.segments.find((s) => s.type === 'grip')!;
    const f = perf.evaluate(grip.end);
    const glass = scene.objects.find((o) => o.id === 'glass')!;
    expect(f.palm.right.distanceTo(new Vector3(glass.position[0], glass.position[1] + 0.066, glass.position[2]))).toBeLessThan(0.09);
  });

  it('attaches the glass to the hand, follows it, and releases it on the table', () => {
    const actions = direct([FULL]);
    const perf = composePerformance(ctx, scene, actions);
    const [attach, release] = perf.events;
    expect(attach).toMatchObject({ type: 'attach', hand: 'right' });
    expect(release).toMatchObject({ type: 'release' });
    const placeSeg = perf.segments.find((s) => s.type === 'place')!;
    const offsets: number[] = [];
    for (let t = attach.time + 0.01; t < placeSeg.start + 0.5; t += 0.1) {
      const f = perf.evaluate(t);
      expect(f.heldBy).toBe('right');
      expect(f.glassState === 'held_right' || f.glassState === 'being_placed').toBe(true);
      offsets.push(f.palm.right.distanceTo(new Vector3(...f.glass.position)));
    }
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(1e-6);
    const before = perf.evaluate(attach.time - 0.5);
    expect(before.glassState).toBe('being_reached');
    const end = perf.evaluate(perf.duration);
    expect(end.glassState).toBe('released');
    expect(end.heldBy).toBeNull();
    const g = scene.objects.find((o) => o.id === 'glass')!;
    end.glass.position.forEach((v, i) => expect(v).toBeCloseTo(g.position[i], 6));
    // The glass is held while moving: its position changed during the hold.
    const mid = perf.evaluate((attach.time + placeSeg.start) / 2);
    expect(new Vector3(...mid.glass.position).distanceTo(new Vector3(...g.position))).toBeGreaterThan(0.05);
  });

  it('applies iterative edits without disturbing unrelated actions', () => {
    const next = ids();
    const base = direct([FULL], [], next);
    const p0 = composePerformance(ctx, scene, base);
    const edited = direct(['Look around before putting down the glass.'], base, next);
    const p1 = composePerformance(ctx, scene, edited);
    const baseIds = base.map((a) => a.id);
    expect(edited.filter((a) => baseIds.includes(a.id))).toEqual(base);
    const firstLook = base.find((a) => a.type === 'look_around')!;
    // Everything up to the first look-around is unchanged, frame for frame.
    const until = p0.actionTimes.get(firstLook.id)!.end;
    for (let t = 0; t < until; t += 0.25) {
      const a = p0.evaluate(t);
      const b = p1.evaluate(t);
      expect(a.pose.rotations.get('DEF-hand.R')!.angleTo(b.pose.rotations.get('DEF-hand.R')!)).toBeLessThan(1e-6);
    }
    expect(p1.duration).toBeGreaterThan(p0.duration);
    const slower = direct(['Do it more slowly.'], edited, next);
    expect(slower.map((a) => a.id)).toEqual(edited.map((a) => a.id));
    expect(composePerformance(ctx, scene, slower).duration).toBeGreaterThan(p1.duration * 1.2);
    const pauseEnd = direct(['Pause before releasing the glass.', 'Move the hesitation to the end.'], edited, next);
    expect(pauseEnd[pauseEnd.length - 1].type).toBe('pause');
    expect(simulate(pauseEnd, scene).issues).toEqual([]);
  });

  it('re-plans when the scene changes', () => {
    const actions = direct([FULL]);
    const moved: DirectorScene = { ...scene, objects: scene.objects.map((o) => (o.id === 'glass' ? { ...o, position: [0.4, 0.75, 1.85] } : o)) };
    const r = resolveDependencies(actions, moved, ids());
    expect(r.errors).toEqual([]);
    const perf = composePerformance(ctx, moved, r.actions);
    expect(perf.issues).toEqual([]);
    const end = perf.evaluate(perf.duration);
    expect(end.glass.position[0]).toBeCloseTo(0.4, 6);
  });
});

describe('undo history', () => {
  it('undoes and redoes snapshots', () => {
    const h = new UndoHistory<number>();
    h.push(1);
    h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    h.push(5);
    expect(h.canRedo).toBe(false);
  });
});

describe('project, motion and GLB round trips', () => {
  it('reopens a project deterministically and rejects other rigs', () => {
    const rigRef = { id: rig.definition.id, signature: rigSignature(rig.definition) };
    const project = { ...newProject(rigRef, 'Glass scene'), actions: direct([FULL]), nextId: 20 };
    const text = serializeProject(project);
    const v = parseProjectText(text, rigRef);
    if (!v.ok) throw new Error(v.errors.join(' '));
    expect(v.project.actions).toEqual(project.actions);
    expect(v.project.scene).toEqual(project.scene);
    const a = composePerformance(ctx, project.scene, project.actions).evaluate(4);
    const b = composePerformance(ctx, v.project.scene, v.project.actions).evaluate(4);
    expect(a.glass.position).toEqual(b.glass.position);
    expect(parseProjectText(text, { ...rigRef, signature: 'deadbeef' }).ok).toBe(false);
    expect(parseProjectText('{"format":"director-project","version":9}').ok).toBe(false);
    expect(parseProjectText('not json').ok).toBe(false);
  });

  it('bakes MotionRecorder-compatible motion that survives JSON and GLB round trips', async () => {
    const perf = composePerformance(ctx, scene, direct([FULL]));
    const motion = bakeActorMotion(perf, rig.definition, rig.rawHeight, 'director take');
    const v = validateMotion(JSON.parse(JSON.stringify(motion)), rig.definition);
    if (!v.ok) throw new Error(v.errors.join(' '));
    expect(v.motion.meta.source).toBe('director');
    const t = 4.0;
    const frame = perf.evaluate(t);
    const sampled = sampleMotion(v.motion, t);
    for (const bone of ['DEF-hand.R', 'DEF-head', 'root']) {
      expect(sampled.rotations.get(bone)!.angleTo(frame.pose.rotations.get(bone)!)).toBeLessThan(0.02);
    }
    expect(sampled.translations.get('root')!.distanceTo(frame.pose.translations.get('root')!)).toBeLessThan(0.02);

    const glb = await exportMotionGlb(rig.sourceBytes, v.motion, rig.definition);
    const back = await importMotionGlb(glb.slice().buffer as ArrayBuffer, rig.definition);
    expect(back.motions).toHaveLength(1);
    const re = sampleMotion(back.motions[0], t);
    expect(re.rotations.get('DEF-hand.R')!.angleTo(sampled.rotations.get('DEF-hand.R')!)).toBeLessThan(1e-3);
  });

  it('exports a scene GLB with actor, table and animated glass', async () => {
    const perf = composePerformance(ctx, scene, direct([FULL]));
    const motion = bakeActorMotion(perf, rig.definition, rig.rawHeight, 'scene');
    const glass = bakeGlass(perf);
    const bytes = await exportSceneGlb(rig.sourceBytes, motion, rig.definition, scene, glass);
    const check = await verifySceneGlb(bytes, rig.definition, glass);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    const moved = glass.positions.some((p) => Math.hypot(p[0] - glass.positions[0][0], p[1] - glass.positions[0][1], p[2] - glass.positions[0][2]) > 0.1);
    expect(moved).toBe(true);
    expect(new Quaternion().fromArray([0, 0, 0, 1]).length()).toBe(1);
  });
});

export type { DirectorCommand };
