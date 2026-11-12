import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { parseMannequin, type MannequinRig } from '../../src/rig/mannequinLoader';
import { rigSignature } from '../../src/rig/rigDefinition';
import { validateMotion } from '../../src/recording/motionFormat';
import { sampleMotion } from '../../src/recording/motionPlayback';
import { exportMotionGlb } from '../../src/export/glbExporter';
import { importMotionGlb } from '../../src/import/glbImporter';
import { parseDirection } from '../../src/director/ai/commandParser';
import { runPrompt } from '../../src/director/ai/directorSession';
import type { DirectorAction } from '../../src/director/ai/commandSchema';
import { ComposerContext, MIN_WALK_SPEED, composePerformance } from '../../src/director/animation/motionComposer';
import { bakeActorMotion } from '../../src/director/animation/animationBaker';
import { newProject, parseProjectText, serializeProject, type ChatEntry } from '../../src/director/persistence/directorProject';
import { defaultScene } from '../../src/director/scene/sceneModel';

let rig: MannequinRig;
let ctx: ComposerContext;
const scene = defaultScene();
const FULL = 'Walk to the table, pick up the glass, look around nervously and put it back on the table.';

beforeAll(async () => {
  const buf = readFileSync('public/models/mannequin.glb');
  rig = await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  ctx = new ComposerContext(rig);
});

/** A director chat session without UI (same pipeline as the store). */
function session() {
  let p = { actions: [] as DirectorAction[], chat: [] as ChatEntry[], scene, nextId: 1 };
  return {
    say(text: string, selected: string | null = null) {
      const r = runPrompt(ctx, p, text, selected);
      p = { ...p, actions: r.actions, nextId: r.nextId, chat: [...p.chat, ...r.entries] };
      return r;
    },
    get actions() {
      return p.actions;
    },
    perf() {
      return composePerformance(ctx, scene, p.actions);
    },
    clearChat() {
      p = { ...p, chat: [] };
    },
  };
}

const durOf = (perf: ReturnType<typeof composePerformance>, ids: string[]) => ids.reduce((acc, id) => acc + (perf.actionTimes.get(id)!.end - perf.actionTimes.get(id)!.start), 0);
const idsOf = (actions: DirectorAction[], ...types: string[]) => actions.filter((a) => types.includes(a.type)).map((a) => a.id);

function maxPoseJump(perf: ReturnType<typeof composePerformance>) {
  let prev = perf.evaluate(0);
  let max = 0;
  for (let t = 1 / 60; t <= perf.duration; t += 1 / 60) {
    const f = perf.evaluate(t);
    for (const [bone, q] of f.pose.rotations) max = Math.max(max, 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev.pose.rotations.get(bone)!)))));
    prev = f;
  }
  return max;
}

describe('timing parser', () => {
  const ctxSeq = { hasSequence: true, existingTypes: [] };
  const first = (t: string) => parseDirection(t, ctxSeq).commands[0];
  it('distinguishes exact, minimum, maximum and relative durations', () => {
    expect(first('Take at least 8 seconds to complete the movement.')).toEqual({ operation: 'set_min_duration', match: { scope: 'context' }, seconds: 8 });
    expect(first('Take at least 8 seconds.')).toEqual({ operation: 'set_min_duration', match: { scope: 'context' }, seconds: 8 });
    expect(first('Make the entire movement last 12 seconds.')).toEqual({ operation: 'set_duration', match: { scope: 'sequence' }, seconds: 12 });
    expect(first('Complete the action in exactly 5 seconds.')).toEqual({ operation: 'set_duration', match: { scope: 'context' }, seconds: 5 });
    expect(first('Finish the walk in at most 3 seconds.')).toEqual({ operation: 'set_max_duration', match: { type: 'walk_to' }, seconds: 3 });
    expect(first('Make it twice as slow.')).toEqual({ operation: 'scale_duration', match: { scope: 'context' }, factor: 2 });
    expect(first('Actually, make it twice as slow.')).toEqual({ operation: 'scale_duration', match: { scope: 'context' }, factor: 2 });
    expect(first('Slow down the last part.')).toEqual({ operation: 'scale_duration', match: { scope: 'last_part' }, factor: 1.4 });
    expect(first('Spend more time looking around.')).toEqual({ operation: 'scale_duration', match: { type: 'look_around' }, factor: 1.5 });
    expect(first('Pause for 2 seconds before releasing the glass.')).toMatchObject({ operation: 'insert_pause', position: 'before', anchor: { type: 'release' }, seconds: 2 });
    expect(first('Nimm dir mindestens acht Sekunden Zeit.')).toMatchObject({ operation: 'set_min_duration', seconds: 8 });
    const both = parseDirection('Make the walking faster but the placing slower.', ctxSeq).commands;
    expect(both).toEqual([
      { operation: 'modify_actions', match: { type: 'walk_to' }, changes: { speedFactor: 1.4 } },
      { operation: 'modify_actions', match: { type: 'place' }, changes: { speedFactor: 0.7 } },
    ]);
  });
  it('keeps "pause for N seconds" / "look around for N seconds" as actions', () => {
    expect(first('Pause for 2 seconds.')).toMatchObject({ operation: 'append_actions', actions: [{ type: 'pause', duration: 2 }] });
    expect(first('Look around for 3 seconds.')).toMatchObject({ operation: 'append_actions', actions: [{ type: 'look_around', duration: 3 }] });
  });
  it('mixes creation and timing in one prompt', () => {
    const cmds = parseDirection('Walk to the table and take at least 8 seconds.', { hasSequence: false, existingTypes: [] }).commands;
    expect(cmds.map((c) => c.operation)).toEqual(['create_sequence', 'set_min_duration']);
  });
});

describe('acceptance: conversational retiming', () => {
  it('A: "Take at least 8 seconds." extends a short walk with coherent locomotion', () => {
    const s = session();
    s.say('Walk to the table.');
    const walkId = idsOf(s.actions, 'walk_to')[0];
    const before = durOf(s.perf(), [walkId]);
    expect(before).toBeLessThan(5);
    const r = s.say('Take at least 8 seconds.');
    expect(r.ok, r.reply).toBe(true);
    expect(r.reply).not.toMatch(/not supported/i);
    const perf = s.perf();
    expect(durOf(perf, [walkId])).toBeGreaterThanOrEqual(8 - 1e-3);
    expect(durOf(perf, [walkId])).toBeLessThan(8.05);
    expect(s.actions.map((a) => a.id)).toEqual([walkId]); // modified, not regenerated
    // Locomotion stays plausible: a real walk at >= MIN_WALK_SPEED plus an anticipation phase that is not frozen.
    const walkSeg = perf.segments.find((x) => x.phase === 'walk')!;
    const walkT = walkSeg.end - walkSeg.start;
    const a0 = perf.evaluate(walkSeg.start).actor.position;
    const a1 = perf.evaluate(walkSeg.end).actor.position;
    const len = Math.hypot(a1[0] - a0[0], a1[2] - a0[2]);
    expect(len / (walkT - 0.5)).toBeGreaterThanOrEqual(MIN_WALK_SPEED * 0.95);
    const prep = perf.segments.find((x) => x.phase === 'prepare');
    if (prep) {
      expect(prep.end - prep.start).toBeLessThan(durOf(perf, [walkId]) * 0.6);
      const h0 = perf.evaluate(prep.start + 0.2).pose.rotations.get('DEF-spine.003')!;
      const h1 = perf.evaluate((prep.start + prep.end) / 2).pose.rotations.get('DEF-spine.003')!;
      expect(h0.angleTo(h1)).toBeGreaterThan(1e-3);
    }
    expect(maxPoseJump(perf)).toBeLessThan(0.3);
    // Arrives where the un-retimed walk arrived.
    const end = perf.evaluate(perf.duration).actor.position;
    const ref = composePerformance(ctx, scene, s.actions.map((a) => ({ ...a, duration: undefined })));
    const refEnd = ref.evaluate(ref.duration).actor.position;
    end.forEach((v, i) => expect(v).toBeCloseTo(refEnd[i], 6));
  });

  it('B: "Take at least 8 seconds." keeps a 10 second performance unchanged', () => {
    const s = session();
    s.say(FULL);
    s.say('Make the entire performance last exactly 10 seconds.');
    expect(s.perf().duration).toBeCloseTo(10, 1);
    const snapshot = JSON.stringify(s.actions);
    const r = s.say('Take at least 8 seconds.');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.reply).toMatch(/No change.*already/i);
    expect(JSON.stringify(s.actions)).toBe(snapshot);
    expect(s.perf().duration).toBeCloseTo(10, 1);
  });

  it('C: "Make the pickup twice as slow." doubles the pickup only', () => {
    const s = session();
    s.say('Walk to the table.');
    s.say('Pick up the glass.');
    const pick = idsOf(s.actions, 'reach', 'grip', 'lift');
    const walk = idsOf(s.actions, 'walk_to');
    const p0 = s.perf();
    const before = durOf(p0, pick);
    const r = s.say('Make the pickup twice as slow.');
    expect(r.ok, r.reply).toBe(true);
    const p1 = s.perf();
    expect(durOf(p1, pick)).toBeCloseTo(before * 2, 1);
    expect(durOf(p1, walk)).toBeCloseTo(durOf(p0, walk), 6);
    expect(p1.events[0].time - p0.events[0].time).toBeGreaterThan(0.3); // attach moved with the slower grip
  });

  it('contextual "Do it more slowly." after "Pick up the glass." changes the pickup, not the scene', () => {
    const s = session();
    s.say('Walk to the table.');
    s.say('Pick up the glass.');
    const walk = idsOf(s.actions, 'walk_to');
    const pick = idsOf(s.actions, 'reach', 'grip', 'lift');
    const p0 = s.perf();
    s.say('Do it more slowly.');
    const p1 = s.perf();
    expect(durOf(p1, walk)).toBeCloseTo(durOf(p0, walk), 6);
    expect(durOf(p1, pick)).toBeGreaterThan(durOf(p0, pick) * 1.2);
    // ... and "Actually, make it twice as slow." refers to the same actions.
    s.say('Actually, make it twice as slow.');
    expect(durOf(s.perf(), pick)).toBeCloseTo(durOf(p1, pick) * 2, 1);
    expect(durOf(s.perf(), walk)).toBeCloseTo(durOf(p0, walk), 6);
  });

  it('D: "Look around for 2 seconds before placing it." inserts and shifts dependent actions', () => {
    const s = session();
    s.say('Pick up the glass and put it on the table.');
    const p0 = s.perf();
    const place = idsOf(s.actions, 'place')[0];
    s.say('Look around for 2 seconds before placing it.');
    const p1 = s.perf();
    const look = s.actions.find((a) => a.type === 'look_around')!;
    expect(s.actions.indexOf(look)).toBe(s.actions.findIndex((a) => a.id === place) - 1);
    expect(durOf(p1, [look.id])).toBeCloseTo(2, 3);
    expect(p1.actionTimes.get(place)!.start - p0.actionTimes.get(place)!.start).toBeCloseTo(2, 3);
    expect(p1.events[1].time - p0.events[1].time).toBeCloseTo(2, 3); // release shifted too
    expect(p1.events[0].time).toBeCloseTo(p0.events[0].time, 6); // earlier attach unchanged
  });

  it('"Pause for 2 seconds before releasing the glass." inserts an exact pause', () => {
    const s = session();
    s.say(FULL);
    s.say('Pause for 2 seconds before releasing the glass.');
    const i = s.actions.findIndex((a) => a.type === 'release');
    expect(s.actions[i - 1]).toMatchObject({ type: 'pause', duration: 2 });
  });

  it('E: "Make the entire performance last exactly 15 seconds." distributes time and keeps interactions', () => {
    const s = session();
    s.say(FULL);
    const p0 = s.perf();
    const r = s.say('Make the entire performance last exactly 15 seconds.');
    expect(r.ok, r.reply).toBe(true);
    const p1 = s.perf();
    expect(p1.duration).toBeCloseTo(15, 2);
    expect(p1.issues).toEqual([]);
    expect(p1.events.map((e) => e.type)).toEqual(['attach', 'release']);
    // Every action got slower (proportional distribution), order and ids are unchanged.
    for (const a of s.actions) expect(durOf(p1, [a.id])).toBeGreaterThan(durOf(p0, [a.id]));
    const end = p1.evaluate(p1.duration);
    expect(end.glassState).toBe('released');
    const g = scene.objects.find((o) => o.id === 'glass')!;
    end.glass.position.forEach((v, i) => expect(v).toBeCloseTo(g.position[i], 6));
    expect(maxPoseJump(p1)).toBeLessThan(0.3);
    // Impossible constraints are explained and change nothing.
    const bad = s.say('Make the entire performance last exactly 1 second.');
    expect(bad.ok).toBe(false);
    expect(bad.reply).toMatch(/needs at least/);
    expect(s.perf().duration).toBeCloseTo(15, 2);
  });

  it('F: a retimed performance exports and re-imports with the edited timing', async () => {
    const s = session();
    s.say(FULL);
    s.say('Make the entire performance last exactly 15 seconds.');
    const perf = s.perf();
    const motion = bakeActorMotion(perf, rig.definition, rig.rawHeight, 'retimed');
    const v = validateMotion(JSON.parse(JSON.stringify(motion)), rig.definition);
    if (!v.ok) throw new Error(v.errors.join(' '));
    expect(v.motion.duration).toBeCloseTo(15, 1);
    const glb = await exportMotionGlb(rig.sourceBytes, v.motion, rig.definition);
    const back = await importMotionGlb(glb.slice().buffer as ArrayBuffer, rig.definition);
    expect(back.motions[0].duration).toBeCloseTo(15, 1);
    // Pose at the (shifted) attach time matches the live performance.
    const t = perf.events[0].time;
    const live = perf.evaluate(t).pose.rotations.get('DEF-hand.R')!;
    expect(sampleMotion(back.motions[0], t).rotations.get('DEF-hand.R')!.angleTo(live)).toBeLessThan(0.03);
    // The project file keeps the retimed actions.
    const rigRef = { id: rig.definition.id, signature: rigSignature(rig.definition) };
    const proj = parseProjectText(serializeProject({ ...newProject(rigRef), actions: s.actions }), rigRef);
    if (!proj.ok) throw new Error(proj.errors.join(' '));
    expect(composePerformance(ctx, scene, proj.project.actions).duration).toBeCloseTo(15, 2);
  });

  it('applies different speed edits to different actions', () => {
    const s = session();
    s.say(FULL);
    const p0 = s.perf();
    const walk = idsOf(s.actions, 'walk_to');
    const place = idsOf(s.actions, 'place');
    s.say('Make the walking faster but the placing slower.');
    const p1 = s.perf();
    expect(durOf(p1, walk)).toBeLessThan(durOf(p0, walk));
    expect(durOf(p1, place)).toBeGreaterThan(durOf(p0, place));
  });

  it('"Slow down the last part." and "Spend more time looking around." only touch their targets', () => {
    const s = session();
    s.say(FULL);
    const p0 = s.perf();
    const look = idsOf(s.actions, 'look_around');
    s.say('Spend more time looking around.');
    expect(durOf(s.perf(), look)).toBeCloseTo(durOf(p0, look) * 1.5, 2);
    const p1 = s.perf();
    const walk = idsOf(s.actions, 'walk_to');
    const release = idsOf(s.actions, 'release');
    s.say('Slow down the last part.');
    const p2 = s.perf();
    expect(durOf(p2, walk)).toBeCloseTo(durOf(p1, walk), 6);
    expect(durOf(p2, release)).toBeGreaterThan(durOf(p1, release));
  });

  it('uses the selected action as context', () => {
    const s = session();
    s.say(FULL);
    const look = s.actions.find((a) => a.type === 'look_around')!;
    const p0 = s.perf();
    s.say('Take at least 5 seconds.', look.id);
    const p1 = s.perf();
    expect(durOf(p1, [look.id])).toBeCloseTo(5, 2);
    for (const a of s.actions) if (a.id !== look.id) expect(durOf(p1, [a.id])).toBeCloseTo(durOf(p0, [a.id]), 6);
  });

  it('asks a specific question when "it" is ambiguous, then applies the answer', () => {
    const s = session();
    s.say(FULL);
    s.clearChat(); // e.g. a project whose history no longer says what was edited last
    const q = s.say('Take at least 8 seconds.');
    expect(q.ok).toBe(false);
    expect(q.changed).toBe(false);
    expect(q.reply).toMatch(/Which part do you mean/);
    expect(q.entries[1].clarify).toEqual({ prompt: 'Take at least 8 seconds.' });
    const walk = idsOf(s.actions, 'walk_to');
    const a = s.say('The walk.');
    expect(a.ok, a.reply).toBe(true);
    expect(durOf(s.perf(), walk)).toBeGreaterThanOrEqual(8 - 1e-3);
  });

  it('explains when there is nothing to retime yet', () => {
    const s = session();
    const r = s.say('Take at least 8 seconds.');
    expect(r.ok).toBe(false);
    expect(r.reply).toMatch(/no performance yet/);
  });

  it('speed edits stay effective on actions with an explicit duration', () => {
    const s = session();
    s.say('Walk to the table.');
    s.say('Make it last 6 seconds.');
    const walk = idsOf(s.actions, 'walk_to');
    expect(durOf(s.perf(), walk)).toBeCloseTo(6, 2);
    s.say('Walk faster.');
    expect(durOf(s.perf(), walk)).toBeLessThan(5);
    expect(new Vector3().length()).toBe(0);
  });
});
