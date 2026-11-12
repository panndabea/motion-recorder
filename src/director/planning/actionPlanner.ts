import type { ActionChanges, ActionMatch, ActionSpec, ActionType, DirectorAction, DirectorCommand, Hand } from '../ai/commandSchema';
import { LIMITS } from '../ai/commandSchema';
import { retime, type Measure } from '../timeline/retiming';

/** Actions whose duration is their content (not derived from speed). */
const CONTENT_TYPES: ActionType[] = ['pause', 'idle', 'look_around', 'look_at', 'bend'];
import { forwardXZ, isOnTable, rad, requireObject, wrapAngle, yawTowards, type DirectorScene, type Vec3 } from '../scene/sceneModel';
import { glassApproach, inReach, placementPoint, tableApproach, type Stand } from './sceneConstraints';

export type GlassPhase = 'on_table' | 'available' | 'reached' | 'held' | 'placed' | 'released';

/** Planner state before/after each action. Pure data; the composer turns it into motion. */
export interface PlanState {
  stand: Stand;
  held: string | null;
  hand: Hand;
  /** Glass world position while not held (or where it will be set down). */
  glassPos: Vec3;
  glassPhase: GlassPhase;
  /** Where the glass was originally picked up (preferred placement spot). */
  pickedFrom: Vec3 | null;
  /** Target of the last reach (cleared by any action that moves the body). */
  reaching: string | null;
}

export interface PlanStep {
  action: DirectorAction;
  before: PlanState;
  after: PlanState;
  /** Placement point for place actions. */
  placeAt?: Vec3;
}

export interface PlanIssue {
  index: number;
  code: 'out_of_reach' | 'not_reaching' | 'not_holding' | 'already_holding' | 'table_out_of_reach' | 'not_placed' | 'nothing_to_release' | 'invalid_target' | 'release_missing';
  message: string;
}

export interface Plan {
  steps: PlanStep[];
  issues: PlanIssue[];
  initial: PlanState;
  final: PlanState;
}

export const WALK_STEP_DISTANCE = 1.5;

const GAZE_ONLY: ActionType[] = ['look_at', 'look_around', 'pause', 'idle'];

export function initialState(scene: DirectorScene): PlanState {
  const actor = requireObject(scene, 'actor');
  const glass = requireObject(scene, 'glass');
  const table = requireObject(scene, 'table');
  return {
    stand: { pos: [actor.position[0], actor.position[2]], yaw: rad(actor.rotationY) },
    held: null,
    hand: 'right',
    glassPos: [...glass.position],
    glassPhase: isOnTable(glass, table) ? 'on_table' : 'available',
    pickedFrom: null,
    reaching: null,
  };
}

const clone = (s: PlanState): PlanState => ({
  ...s,
  stand: { pos: [...s.stand.pos], yaw: s.stand.yaw },
  glassPos: [...s.glassPos],
  pickedFrom: s.pickedFrom ? [...s.pickedFrom] : null,
});

/** Simulates the action list against the scene, recording each step's state and any rule violations. */
export function simulate(actions: DirectorAction[], scene: DirectorScene): Plan {
  const initial = initialState(scene);
  const startStand = initial.stand;
  const s = clone(initial);
  const steps: PlanStep[] = [];
  const issues: PlanIssue[] = [];
  const issue = (index: number, code: PlanIssue['code'], message: string) => issues.push({ index, code, message });

  actions.forEach((a, i) => {
    const before = clone(s);
    const hand = a.hand ?? s.hand;
    let placeAt: Vec3 | undefined;
    if (!GAZE_ONLY.includes(a.type) && a.type !== 'grip' && a.type !== 'release') s.reaching = null;
    if (s.glassPhase === 'placed' && !['release', ...GAZE_ONLY].includes(a.type)) {
      issue(i, 'release_missing', 'The glass must be released before the actor does something else.');
    }
    switch (a.type) {
      case 'walk_to': {
        if (a.target === 'table') {
          // Stand where the next object interaction at the table can actually be performed.
          const nextUse = actions.slice(i + 1).find((x) => ['walk_to', 'reach', 'grip', 'place'].includes(x.type));
          if (nextUse && (nextUse.type === 'reach' || nextUse.type === 'grip') && !s.held) s.stand = glassApproach(scene, s.glassPos, s.stand.pos, nextUse.hand ?? hand);
          else if (nextUse?.type === 'place' && s.held && s.pickedFrom) s.stand = glassApproach(scene, s.pickedFrom, s.stand.pos, s.hand);
          else s.stand = tableApproach(scene, s.stand.pos);
        }
        else if (a.target === 'glass') {
          if (s.held === 'glass') issue(i, 'invalid_target', 'The actor is already holding the glass.');
          else s.stand = glassApproach(scene, s.glassPos, s.stand.pos, hand);
        } else if (a.target === 'start') s.stand = { ...startStand, pos: [...startStand.pos] };
        else if (a.target === 'camera') {
          const cam = requireObject(scene, 'camera');
          const c: [number, number] = [cam.position[0], cam.position[2]];
          const yaw = yawTowards(s.stand.pos, c);
          const d = Math.max(0, Math.hypot(c[0] - s.stand.pos[0], c[1] - s.stand.pos[1]) - 1.2);
          const fw = forwardXZ(yaw);
          s.stand = { pos: [s.stand.pos[0] + fw[0] * d, s.stand.pos[1] + fw[1] * d], yaw };
        } else if (a.target) issue(i, 'invalid_target', `Cannot walk to "${a.target}".`);
        else {
          const turn = { forward: 0, left: Math.PI / 2, right: -Math.PI / 2, back: Math.PI, around: Math.PI, up: 0, down: 0 }[a.direction ?? 'forward'];
          const yaw = wrapAngle(s.stand.yaw + turn);
          const fw = forwardXZ(yaw);
          s.stand = { pos: [s.stand.pos[0] + fw[0] * WALK_STEP_DISTANCE, s.stand.pos[1] + fw[1] * WALK_STEP_DISTANCE], yaw };
        }
        break;
      }
      case 'turn': {
        if (a.target) {
          const o = scene.objects.find((x) => x.id === a.target);
          const p: [number, number] = a.target === 'glass' && s.held !== 'glass' ? [s.glassPos[0], s.glassPos[2]] : o ? [o.position[0], o.position[2]] : s.stand.pos;
          s.stand = { ...s.stand, yaw: yawTowards(s.stand.pos, p) };
        } else {
          const delta = { left: Math.PI / 2, right: -Math.PI / 2, around: Math.PI, back: Math.PI, forward: 0, up: 0, down: 0 }[a.direction ?? 'around'];
          s.stand = { ...s.stand, yaw: wrapAngle(s.stand.yaw + delta) };
        }
        break;
      }
      case 'reach':
      case 'grip': {
        const target = a.target ?? 'glass';
        if (s.held) issue(i, 'already_holding', `The ${s.held} is already held.`);
        else if (!inReach(s.stand, hand, [s.glassPos[0], s.glassPos[2]])) issue(i, 'out_of_reach', `The ${target} is out of reach.`);
        else if (a.type === 'reach') {
          s.reaching = target;
          s.glassPhase = s.glassPhase === 'on_table' || s.glassPhase === 'released' || s.glassPhase === 'available' ? 'reached' : s.glassPhase;
          s.hand = hand;
        } else if (s.reaching !== target) issue(i, 'not_reaching', `The actor has to reach for the ${target} before gripping it.`);
        else {
          s.held = target;
          s.hand = hand;
          s.glassPhase = 'held';
          s.pickedFrom = [...s.glassPos];
          s.reaching = null;
        }
        break;
      }
      case 'lift':
        if (s.held !== 'glass') issue(i, 'not_holding', 'The actor is not holding the glass.');
        break;
      case 'place': {
        if (s.held !== 'glass') issue(i, 'not_holding', 'The actor is not holding the glass.');
        else {
          const p = placementPoint(scene, s.stand, s.hand, s.pickedFrom ?? undefined);
          if (!p) issue(i, 'table_out_of_reach', 'The table is out of reach.');
          else {
            placeAt = p;
            s.glassPos = [...p];
            s.glassPhase = 'placed';
          }
        }
        break;
      }
      case 'release':
        if (s.held !== 'glass') issue(i, 'nothing_to_release', 'The actor is not holding anything.');
        else if (s.glassPhase !== 'placed') issue(i, 'not_placed', 'Releasing now would drop the glass; it has to be placed first.');
        else {
          s.held = null;
          s.glassPhase = 'released';
        }
        break;
      default:
        break;
    }
    steps.push({ action: a, before, after: clone(s), placeAt });
  });
  if (s.glassPhase === 'placed') issue(actions.length, 'release_missing', 'The placed glass is never released.');
  return { steps, issues, initial, final: s };
}

export type IdFactory = () => string;

function autoAction(spec: ActionSpec, nextId: IdFactory, origin?: string): DirectorAction {
  return { speed: 1, ...spec, id: nextId(), auto: true, origin };
}

/**
 * Inserts the prerequisite actions needed to make the sequence executable (walk to the glass before reaching,
 * reach before grip, place before release, ...). Only adds or removes the minimum; existing actions keep
 * their ids and parameters. Returns notes describing every change and the issues that could not be fixed.
 */
export function resolveDependencies(input: DirectorAction[], scene: DirectorScene, nextId: IdFactory, origin?: string) {
  const actions = [...input];
  const notes: string[] = [];
  for (let guard = 0; guard < 4 * LIMITS.maxActions; guard++) {
    const plan = simulate(actions, scene);
    const first = plan.issues[0];
    if (!first) return { actions, notes, errors: [] as string[], plan };
    const i = first.index;
    const a = actions[i];
    const hand = a?.hand;
    const insert = (specs: ActionSpec[], why: string) => {
      actions.splice(i, 0, ...specs.map((sp) => autoAction(hand && sp.type !== 'walk_to' ? { ...sp, hand } : sp, nextId, origin)));
      notes.push(why);
    };
    switch (first.code) {
      case 'out_of_reach':
        insert([{ type: 'walk_to', target: 'glass', speed: a.speed }], `Added "walk to glass" before ${a.type}: the glass was out of reach.`);
        break;
      case 'not_reaching':
        insert([{ type: 'reach', target: 'glass' }], 'Added "reach" before grip.');
        break;
      case 'not_holding':
        insert([{ type: 'reach', target: 'glass' }, { type: 'grip', target: 'glass' }], `Added "reach" and "grip" before ${a.type}: the glass was not held.`);
        break;
      case 'table_out_of_reach':
        insert([{ type: 'walk_to', target: 'table', speed: a.speed }], 'Added "walk to table" before placing the glass.');
        break;
      case 'not_placed':
        insert([{ type: 'place', object: 'glass', target: 'table' }], 'Added "place" before release so the glass is not dropped.');
        break;
      case 'release_missing': {
        let j = i;
        if (j > actions.length || plan.steps[Math.min(j, plan.steps.length - 1)]?.after.glassPhase !== 'placed') j = i;
        actions.splice(j, 0, autoAction({ type: 'release', object: 'glass' }, nextId, origin));
        notes.push('Added "release" after placing the glass.');
        break;
      }
      case 'nothing_to_release':
      case 'already_holding':
      case 'invalid_target':
        if (a.auto) {
          actions.splice(i, 1);
          notes.push(`Removed an automatic "${a.type}" that is no longer needed.`);
          break;
        }
        return { actions: input, notes: [], errors: [`Action ${i + 1} (${a.type}): ${first.message}`], plan: simulate(input, scene) };
    }
  }
  return { actions: input, notes: [], errors: ['Could not resolve the action dependencies.'], plan: simulate(input, scene) };
}

/** Indices of actions matching `m` (all occurrences unless m.occurrence says otherwise). */
export function matchActions(actions: DirectorAction[], m: ActionMatch, defaultOccurrence: 'first' | 'last' | 'all' = 'all'): number[] {
  const types = m.type === undefined ? null : Array.isArray(m.type) ? m.type : [m.type];
  const idx: number[] = [];
  actions.forEach((a, i) => {
    if (m.ids && !m.ids.includes(a.id)) return;
    if (types && !types.includes(a.type)) return;
    if (m.target && a.target !== m.target && a.object !== m.target) return;
    idx.push(i);
  });
  const occ = m.occurrence ?? defaultOccurrence;
  if (occ === 'first') return idx.slice(0, 1);
  if (occ === 'last') return idx.slice(-1);
  return idx;
}

export interface ApplyResult {
  ok: boolean;
  actions: DirectorAction[];
  notes: string[];
  errors: string[];
  /** Ids of actions added or changed by this command. */
  changed: string[];
}

export interface ApplyEnv {
  /** Needed for timing operations: measures each action's duration in a candidate sequence. */
  measure?: Measure;
}

function describeMatch(m: ActionMatch): string {
  const t = m.type === undefined ? 'action' : Array.isArray(m.type) ? m.type.join('/') : m.type;
  return m.target ? `${t} (${m.target})` : t;
}

/** Applies one validated command to the action list without touching unrelated actions. */
export function applyCommand(actions: DirectorAction[], cmd: DirectorCommand, scene: DirectorScene, nextId: IdFactory, origin?: string, env: ApplyEnv = {}): ApplyResult {
  // Convenience operations are expressed through the core ones.
  if (cmd.operation === 'insert_pause') return applyCommand(actions, { operation: 'insert_actions', position: cmd.position, anchor: cmd.anchor, actions: [{ type: 'pause', duration: cmd.seconds }] }, scene, nextId, origin, env);
  if (cmd.operation === 'modify_style') {
    const changes: ActionChanges = {};
    if (cmd.style !== undefined) changes.style = cmd.style;
    if (cmd.amplitude !== undefined) changes.amplitude = cmd.amplitude;
    return applyCommand(actions, { operation: 'modify_actions', match: cmd.match, changes }, scene, nextId, origin, env);
  }
  const make = (specs: ActionSpec[]) => specs.map((sp) => ({ ...sp, speed: sp.speed ?? 1, id: nextId(), origin }) as DirectorAction);
  let next: DirectorAction[];
  let changed: string[] = [];
  const fail = (msg: string): ApplyResult => ({ ok: false, actions, notes: [], errors: [msg], changed: [] });
  switch (cmd.operation) {
    case 'create_sequence':
      next = make(cmd.actions);
      changed = next.map((a) => a.id);
      break;
    case 'append_actions': {
      const added = make(cmd.actions);
      next = [...actions, ...added];
      changed = added.map((a) => a.id);
      break;
    }
    case 'insert_actions': {
      const at = matchActions(actions, cmd.anchor, cmd.position === 'before' ? 'first' : 'last');
      if (at.length === 0) return fail(`There is no ${describeMatch(cmd.anchor)} in the current sequence to insert ${cmd.position}.`);
      const added = make(cmd.actions);
      const pos = cmd.position === 'before' ? at[0] : at[at.length - 1] + 1;
      next = [...actions.slice(0, pos), ...added, ...actions.slice(pos)];
      changed = added.map((a) => a.id);
      break;
    }
    case 'modify_actions': {
      const idx = matchActions(actions, cmd.match);
      if (idx.length === 0) return fail(`There is no ${describeMatch(cmd.match)} in the current sequence to change.`);
      const c = cmd.changes;
      next = actions.map((a, i) => {
        if (!idx.includes(i)) return a;
        const b: DirectorAction = { ...a };
        // An explicit duration overrides speed, so speed edits rescale it to keep the edit effective.
        if (c.speed !== undefined) {
          if (b.duration !== undefined && !CONTENT_TYPES.includes(b.type)) b.duration = Math.min(LIMITS.maxDuration, Math.max(0.15, (b.duration * b.speed) / c.speed));
          b.speed = c.speed;
        }
        if (c.speedFactor !== undefined) {
          const sp = Math.min(LIMITS.maxSpeed, Math.max(LIMITS.minSpeed, b.speed * c.speedFactor));
          if (b.duration !== undefined && !CONTENT_TYPES.includes(b.type)) b.duration = Math.min(LIMITS.maxDuration, Math.max(0.15, b.duration / c.speedFactor));
          b.speed = sp;
        }
        if (c.style !== undefined) b.style = c.style;
        if (c.amplitude !== undefined) b.amplitude = c.amplitude;
        if (c.bend !== undefined) b.bend = c.bend;
        if (c.hand !== undefined) b.hand = c.hand;
        if (c.duration !== undefined) b.duration = c.duration;
        if (c.durationFactor !== undefined && b.duration !== undefined) b.duration = Math.min(LIMITS.maxDuration, b.duration * c.durationFactor);
        changed.push(b.id);
        return b;
      });
      break;
    }
    case 'move_actions': {
      const idx = matchActions(actions, cmd.match);
      if (idx.length === 0) return fail(`There is no ${describeMatch(cmd.match)} in the current sequence to move.`);
      const moving = idx.map((i) => actions[i]);
      const rest = actions.filter((_, i) => !idx.includes(i));
      let pos: number;
      if (cmd.to === 'start') pos = 0;
      else if (cmd.to === 'end') pos = rest.length;
      else {
        const at = matchActions(rest, cmd.to.anchor, cmd.to.position === 'before' ? 'first' : 'last');
        if (at.length === 0) return fail(`There is no ${describeMatch(cmd.to.anchor)} to move the actions ${cmd.to.position}.`);
        pos = cmd.to.position === 'before' ? at[0] : at[at.length - 1] + 1;
      }
      // "end" while the glass is still in hand / being placed would leave it hanging: the resolver fixes order.
      next = [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
      changed = moving.map((a) => a.id);
      break;
    }
    case 'set_duration':
    case 'set_min_duration':
    case 'set_max_duration':
    case 'scale_duration': {
      if (!env.measure) return fail('Timing edits need the motion composer.');
      const idx = matchActions(actions, cmd.match);
      if (idx.length === 0) return fail(`There is no ${describeMatch(cmd.match)} in the current sequence to retime.`);
      const r = retime(actions, { operation: cmd.operation, ids: idx.map((i) => actions[i].id), seconds: 'seconds' in cmd ? cmd.seconds : undefined, factor: 'factor' in cmd ? cmd.factor : undefined }, env.measure);
      if (!r.ok) return { ok: false, actions, notes: [], errors: r.errors, changed: [] };
      return { ok: true, actions: r.actions, notes: r.notes, errors: [], changed: r.changed };
    }
    case 'delete_actions': {
      const idx = matchActions(actions, cmd.match);
      if (idx.length === 0) return fail(`There is no ${describeMatch(cmd.match)} in the current sequence to delete.`);
      next = actions.filter((_, i) => !idx.includes(i));
      break;
    }
  }
  if (next.length > LIMITS.maxActions) return fail(`A sequence can have at most ${LIMITS.maxActions} actions.`);
  const resolved = resolveDependencies(next, scene, nextId, origin);
  if (resolved.errors.length) return { ok: false, actions, notes: [], errors: resolved.errors, changed: [] };
  const known = new Set(actions.map((a) => a.id));
  for (const a of resolved.actions) if (!known.has(a.id) && !changed.includes(a.id)) changed.push(a.id);
  return { ok: true, actions: resolved.actions, notes: resolved.notes, errors: [], changed };
}
