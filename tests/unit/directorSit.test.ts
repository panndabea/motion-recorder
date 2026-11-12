import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMannequin, type MannequinRig } from '../../src/rig/mannequinLoader';
import { rigSignature } from '../../src/rig/rigDefinition';
import { BONES } from '../../src/rig/rigSpec';
import { forwardKinematics } from '../../src/rig/rigDefinition';
import { parseDirection } from '../../src/director/ai/commandParser';
import { runPrompt } from '../../src/director/ai/directorSession';
import type { DirectorAction } from '../../src/director/ai/commandSchema';
import { ComposerContext, composePerformance } from '../../src/director/animation/motionComposer';
import { newProject, parseProjectText, serializeProject } from '../../src/director/persistence/directorProject';
import { defaultScene, DEFAULT_CHAIR_SIZE } from '../../src/director/scene/sceneModel';

let rig: MannequinRig;
let ctx: ComposerContext;
const scene = defaultScene();
const USER = 'walk to the table, just sit down, then walk back. then walk again to the table. pick up the glass. then look left and put down the glass';

beforeAll(async () => {
  const buf = readFileSync('public/models/mannequin.glb');
  rig = await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  ctx = new ComposerContext(rig);
});

const direct = (text: string, actions: DirectorAction[] = []) => runPrompt(ctx, { actions, chat: [], scene, nextId: 100 }, text);

function maxPoseJump(perf: ReturnType<typeof composePerformance>) {
  let prev = perf.evaluate(0);
  let max = 0;
  let at = 0;
  for (let t = 1 / 60; t <= perf.duration; t += 1 / 60) {
    const f = perf.evaluate(t);
    for (const [bone, q] of f.pose.rotations) {
      const d = 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev.pose.rotations.get(bone)!))));
      if (d > max) [max, at] = [d, t];
    }
    prev = f;
  }
  return { max, at };
}

describe('sitting on the chair', () => {
  it('parses sit / stand up / walk back', () => {
    const acts = (t: string) => (parseDirection(t, { hasSequence: false, existingTypes: [] }).commands[0] as { actions: unknown[] }).actions;
    expect(acts('Sit down.')).toEqual([{ type: 'sit', target: 'chair' }]);
    expect(acts('Take a seat.')).toEqual([{ type: 'sit', target: 'chair' }]);
    expect(acts('Setz dich hin.')).toEqual([{ type: 'sit', target: 'chair' }]);
    expect(acts('Stand up.')).toEqual([{ type: 'stand_up' }]);
    expect(acts('Walk back.')).toEqual([{ type: 'walk_to', target: 'start' }]);
    expect(acts('Walk backwards.')).toEqual([{ type: 'walk_to', direction: 'back' }]);
    expect(acts('Walk to the chair.')).toEqual([{ type: 'walk_to', target: 'chair' }]);
    expect(acts('Schlendere gemütlich zum Tisch, setz dich kurz hin und komm dann wieder zurück.')).toEqual([
      { type: 'walk_to', target: 'table' },
      { type: 'sit', target: 'chair' },
      { type: 'walk_to', target: 'start' },
    ]);
    expect(acts('Geh zum Tisch und dann wieder zurück.')).toEqual([{ type: 'walk_to', target: 'table' }, { type: 'walk_to', target: 'start' }]);
  });

  it('performs the full user prompt in order, adding the steps it implies', () => {
    const r = direct(USER);
    expect(r.ok, r.reply).toBe(true);
    expect(r.reply).not.toMatch(/not supported|not applied/i);
    expect(r.actions.map((a) => a.type + (a.target ? `(${a.target})` : a.direction ? `(${a.direction})` : '') + (a.auto ? '*' : ''))).toEqual([
      'walk_to(table)',
      'walk_to(chair)*',
      'sit(chair)',
      'pause*',
      'stand_up*',
      'walk_to(start)',
      'walk_to(table)',
      'reach(glass)',
      'grip(glass)',
      'lift',
      'look_at(left)',
      'place(table)',
      'release*',
    ]);
    const perf = composePerformance(ctx, scene, r.actions);
    expect(perf.issues).toEqual([]);
    expect(perf.events.map((e) => e.type)).toEqual(['attach', 'release']);
    const end = perf.evaluate(perf.duration);
    expect(end.glassState).toBe('released');

    // Seated: hips above the seat, actor at the chair.
    const sit = r.actions.find((a) => a.type === 'sit')!;
    const st = perf.actionTimes.get(sit.id)!;
    const chair = scene.objects.find((o) => o.id === 'chair')!;
    const f = perf.evaluate(st.end + 0.1);
    const hips = forwardKinematics(rig.definition, f.pose).get(BONES.hips)!.position.clone().multiplyScalar(ctx.scale);
    expect(Math.hypot(hips.x - chair.position[0], hips.z - chair.position[2])).toBeLessThan(0.15);
    expect(hips.y - DEFAULT_CHAIR_SIZE[1]).toBeGreaterThan(0);
    expect(hips.y - DEFAULT_CHAIR_SIZE[1]).toBeLessThan(0.2);
    const standing = forwardKinematics(rig.definition, perf.evaluate(0).pose).get(BONES.hips)!.position.y * ctx.scale;
    expect(standing - hips.y).toBeGreaterThan(0.2);
    // ... and back up after stand_up.
    const up = perf.actionTimes.get(r.actions[4].id)!;
    expect(forwardKinematics(rig.definition, perf.evaluate(up.end).pose).get(BONES.hips)!.position.y * ctx.scale).toBeCloseTo(standing, 1);
    // Smooth throughout.
    const jump = maxPoseJump(perf);
    expect(jump.max, `at ${jump.at.toFixed(2)} s`).toBeLessThan(0.3);
    // "walk back" returns to the start mark.
    const back = perf.actionTimes.get(r.actions[5].id)!;
    const p = perf.evaluate(back.end).actor.position;
    const actor = scene.objects.find((o) => o.id === 'actor')!;
    expect(Math.hypot(p[0] - actor.position[0], p[2] - actor.position[2])).toBeLessThan(1e-6);
  });

  it('stands up automatically before walking, and can look around while seated', () => {
    const r = direct('Sit down, look around, then walk to the table.');
    expect(r.actions.map((a) => a.type)).toEqual(['walk_to', 'sit', 'look_around', 'stand_up', 'walk_to']);
    expect(direct('Sit down, then walk to the table.').actions.map((a) => a.type)).toEqual(['walk_to', 'sit', 'pause', 'stand_up', 'walk_to']);
  });

  it('rejects sitting while holding the glass', () => {
    const r = direct('Pick up the glass and sit down.');
    expect(r.ok).toBe(false);
    expect(r.reply).toMatch(/Put the glass down before sitting/);
  });

  it('adds the chair to projects saved before it existed', () => {
    const rigRef = { id: rig.definition.id, signature: rigSignature(rig.definition) };
    const old = JSON.parse(serializeProject(newProject(rigRef)));
    old.scene.objects = old.scene.objects.filter((o: { id: string }) => o.id !== 'chair');
    const v = parseProjectText(JSON.stringify(old), rigRef);
    if (!v.ok) throw new Error(v.errors.join(' '));
    expect(v.project.scene.objects.map((o) => o.id)).toContain('chair');
  });
});
