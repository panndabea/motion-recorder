import { LIMITS, type ActionType, type DirectorAction, type TimingOperation } from '../ai/commandSchema';

/** Measures the duration (s) of every action in a sequence, e.g. via `composePerformance(...).actionTimes`. */
export type Measure = (actions: DirectorAction[]) => Map<string, number>;

export interface RetimeResult {
  ok: boolean;
  actions: DirectorAction[];
  changed: string[];
  notes: string[];
  errors: string[];
  /** Total duration of the targeted actions before and after. */
  before: number;
  after: number;
}

/**
 * Plausible retiming range per action type, as factors of the action's natural duration (speed 1).
 * Locomotion has no upper bound: beyond the slowest plausible walk the composer adds an anticipation
 * phase. Gaze, pauses, idles and bends are "content" whose length is free.
 */
const FACTOR_RANGE: Record<ActionType, [number, number]> = {
  walk_to: [0.45, Infinity],
  turn: [0.4, Infinity],
  reach: [0.45, 4],
  grip: [0.5, 4],
  lift: [0.45, 4],
  place: [0.45, 4],
  release: [0.5, 4],
  look_at: [0.3, Infinity],
  look_around: [0.3, Infinity],
  pause: [0, Infinity],
  idle: [0, Infinity],
  bend: [0.3, Infinity],
  sit: [0.6, 3],
  stand_up: [0.6, 3],
};
const MIN_SECONDS = 0.15;

const fmt = (s: number) => `${s.toFixed(1)} s`;

export interface RetimeRequest {
  operation: TimingOperation;
  ids: string[];
  seconds?: number;
  factor?: number;
}

/**
 * Retimes a group of actions by writing their `duration` (the composer honours it for every action type, so
 * the timeline, playback, interaction events and bakes all follow). The group's total duration is matched
 * by scaling every member by a common factor, clamped to each action's plausible range (water-filling).
 */
export function retime(actions: DirectorAction[], req: RetimeRequest, measure: Measure): RetimeResult {
  const fail = (msg: string, before = 0): RetimeResult => ({ ok: false, actions, changed: [], notes: [], errors: [msg], before, after: before });
  const targets = actions.filter((a) => req.ids.includes(a.id));
  if (targets.length === 0) return fail('There are no actions to retime.');
  const current = measure(actions);
  const cur = targets.map((a) => current.get(a.id) ?? 0);
  const before = cur.reduce((x, y) => x + y, 0);

  let goal: number;
  switch (req.operation) {
    case 'set_duration':
      goal = req.seconds!;
      break;
    case 'set_min_duration':
      if (before >= req.seconds! - 1e-3) return { ok: true, actions, changed: [], notes: [`Already ${fmt(before)} (at least ${fmt(req.seconds!)}), so nothing changed.`], errors: [], before, after: before };
      goal = req.seconds!;
      break;
    case 'set_max_duration':
      if (before <= req.seconds! + 1e-3) return { ok: true, actions, changed: [], notes: [`Already ${fmt(before)} (at most ${fmt(req.seconds!)}), so nothing changed.`], errors: [], before, after: before };
      goal = req.seconds!;
      break;
    case 'scale_duration':
      goal = before * req.factor!;
      break;
  }

  const natural = measure(actions.map((a) => (req.ids.includes(a.id) && !['pause', 'idle', 'look_around', 'look_at', 'bend'].includes(a.type) ? { ...a, speed: 1, duration: undefined } : a)));
  const bounds = targets.map((a, i) => {
    const n = natural.get(a.id) ?? cur[i];
    const [lo, hi] = FACTOR_RANGE[a.type];
    return [Math.max(MIN_SECONDS, n * lo), Math.min(LIMITS.maxDuration, n * hi)] as const;
  });
  const minTotal = bounds.reduce((x, b) => x + b[0], 0);
  const maxTotal = bounds.reduce((x, b) => x + b[1], 0);
  const names = [...new Set(targets.map((a) => a.type))].join(', ');
  if (goal > maxTotal + 1e-3) {
    const fixed = targets.filter((a) => FACTOR_RANGE[a.type][1] !== Infinity).map((a) => a.type);
    return fail(
      `Cannot make ${names} last ${fmt(goal)}: at most ${fmt(maxTotal)} is plausible${fixed.length ? ` (${[...new Set(fixed)].join(', ')} cannot be slowed down further)` : ''}. Add a pause or a look-around to fill the time, or retime the whole sequence.`,
      before,
    );
  }
  if (goal < minTotal - 1e-3) return fail(`Cannot fit ${names} into ${fmt(goal)}: it needs at least ${fmt(minTotal)} to stay physically plausible.`, before);

  // Common factor f with sum(clamp(cur_i * f, lo_i, hi_i)) = goal (monotone in f -> bisection).
  const total = (f: number) => cur.reduce((acc, c, i) => acc + Math.min(bounds[i][1], Math.max(bounds[i][0], c * f)), 0);
  let lo = 0;
  let hi = Math.max(1, goal / Math.max(1e-6, before)) * 4 + 1;
  while (total(hi) < goal && hi < 1e6) hi *= 2;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (total(mid) < goal) lo = mid;
    else hi = mid;
  }
  const f = hi;
  const changed: string[] = [];
  const next = actions.map((a) => {
    const i = targets.indexOf(a);
    if (i < 0) return a;
    const d = Math.round(Math.min(bounds[i][1], Math.max(bounds[i][0], cur[i] * f)) * 1000) / 1000;
    if (Math.abs(d - cur[i]) < 1e-3) return a;
    changed.push(a.id);
    return { ...a, duration: d };
  });
  const measured = measure(next);
  const after = targets.reduce((acc, a) => acc + (measured.get(a.id) ?? 0), 0);
  if (changed.length === 0) return { ok: true, actions, changed, notes: [`${names} already lasts ${fmt(before)}; nothing changed.`], errors: [], before, after: before };
  const detail = targets.length === 1 ? `${targets[0].type}` : `${targets.length} actions (${names})`;
  return { ok: true, actions: next, changed, notes: [`Retimed ${detail}: ${fmt(before)} → ${fmt(after)}.`], errors: [], before, after };
}
