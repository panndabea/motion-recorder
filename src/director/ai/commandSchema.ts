/**
 * Structured director commands. Every interpreter (rule-based parser or local LLM) must produce this
 * format; nothing reaches the animation engine without passing `validateCommands`.
 */
export const ACTION_TYPES = [
  'walk_to',
  'turn',
  'reach',
  'grip',
  'lift',
  'place',
  'release',
  'look_at',
  'look_around',
  'pause',
  'bend',
  'idle',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const STYLES = ['normal', 'nervous', 'cautious', 'exaggerated', 'calm', 'hesitant'] as const;
export type ActionStyle = (typeof STYLES)[number];

export const DIRECTIONS = ['left', 'right', 'up', 'down', 'forward', 'back', 'around'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type Hand = 'right' | 'left';

/** Targets the planner understands: scene object ids plus the actor's start position. */
export const TARGETS = ['table', 'glass', 'start', 'camera'] as const;

export interface ActionSpec {
  type: ActionType;
  target?: string;
  /** Object being placed/released (defaults to the held object). */
  object?: string;
  direction?: Direction;
  hand?: Hand;
  /** Multiplier on the action's natural speed (1 = normal). */
  speed?: number;
  /** Explicit duration in seconds (pause, look_around, idle, bend; otherwise derived). */
  duration?: number;
  style?: ActionStyle;
  /** Bend: degrees. Walk: forward lean in degrees. */
  bend?: number;
  /** Motion amplitude multiplier (walk arm/leg swing, look-around range). */
  amplitude?: number;
}

export interface DirectorAction extends ActionSpec {
  id: string;
  speed: number;
  /** Inserted by the planner to satisfy a dependency (e.g. walk before reaching). */
  auto?: boolean;
  /** Which chat turn created it. */
  origin?: string;
}

export interface ActionMatch {
  type?: ActionType | ActionType[];
  target?: string;
  /** Which matches to use; default 'all' for modify/delete, 'first' for anchors. */
  occurrence?: 'first' | 'last' | 'all';
  /** Restrict to these action ids. */
  ids?: string[];
}

export interface ActionChanges {
  speedFactor?: number;
  speed?: number;
  style?: ActionStyle;
  amplitude?: number;
  bend?: number;
  duration?: number;
  durationFactor?: number;
  hand?: Hand;
}

export type DirectorCommand =
  | { operation: 'create_sequence'; actions: ActionSpec[] }
  | { operation: 'append_actions'; actions: ActionSpec[] }
  | { operation: 'insert_actions'; position: 'before' | 'after'; anchor: ActionMatch; actions: ActionSpec[] }
  | { operation: 'modify_actions'; match: ActionMatch; changes: ActionChanges }
  | { operation: 'move_actions'; match: ActionMatch; to: 'start' | 'end' | { position: 'before' | 'after'; anchor: ActionMatch } }
  | { operation: 'delete_actions'; match: ActionMatch };

export const OPERATIONS = ['create_sequence', 'append_actions', 'insert_actions', 'modify_actions', 'move_actions', 'delete_actions'] as const;

export const LIMITS = { maxActions: 64, minSpeed: 0.2, maxSpeed: 3, maxDuration: 20, maxBend: 70, maxAmplitude: 2.5 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export interface ValidationContext {
  objectIds: string[];
}

export type CommandValidation = { ok: true; commands: DirectorCommand[] } | { ok: false; errors: string[] };

function validateSpec(v: unknown, where: string, ctx: ValidationContext, errors: string[]): ActionSpec | null {
  if (!isObj(v)) return errors.push(`${where}: not an object.`), null;
  if (!oneOf(ACTION_TYPES, v.type)) return errors.push(`${where}: unsupported action "${String(v.type)}". Supported: ${ACTION_TYPES.join(', ')}.`), null;
  const spec: ActionSpec = { type: v.type };
  const targets = new Set([...ctx.objectIds, 'start']);
  for (const key of ['target', 'object'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'string' || !targets.has(v[key] as string)) {
      errors.push(`${where}: unknown ${key} "${String(v[key])}". Scene objects: ${ctx.objectIds.join(', ')}.`);
      return null;
    }
    spec[key] = v[key] as string;
  }
  if (v.direction !== undefined) {
    if (!oneOf(DIRECTIONS, v.direction)) return errors.push(`${where}: unknown direction "${String(v.direction)}".`), null;
    spec.direction = v.direction;
  }
  if (v.hand !== undefined) {
    if (v.hand !== 'right' && v.hand !== 'left') return errors.push(`${where}: hand must be "right" or "left".`), null;
    spec.hand = v.hand;
  }
  if (v.style !== undefined) {
    if (!oneOf(STYLES, v.style)) return errors.push(`${where}: unknown style "${String(v.style)}".`), null;
    spec.style = v.style;
  }
  const num = (key: 'speed' | 'duration' | 'bend' | 'amplitude', min: number, max: number) => {
    if (v[key] === undefined) return true;
    if (!isNum(v[key]) || (v[key] as number) < min || (v[key] as number) > max) {
      errors.push(`${where}: ${key} must be a number between ${min} and ${max}.`);
      return false;
    }
    spec[key] = v[key] as number;
    return true;
  };
  if (!num('speed', LIMITS.minSpeed, LIMITS.maxSpeed) || !num('duration', 0.05, LIMITS.maxDuration) || !num('bend', -30, LIMITS.maxBend) || !num('amplitude', 0, LIMITS.maxAmplitude)) return null;
  if ((spec.type === 'reach' || spec.type === 'grip') && spec.target === undefined) spec.target = 'glass';
  if ((spec.type === 'reach' || spec.type === 'grip') && spec.target !== 'glass') {
    return errors.push(`${where}: only the glass can be gripped (got "${spec.target}").`), null;
  }
  if (spec.type === 'walk_to' && spec.target === undefined && spec.direction === undefined) {
    return errors.push(`${where}: walk_to needs a target or direction.`), null;
  }
  return spec;
}

function validateMatch(v: unknown, where: string, errors: string[]): ActionMatch | null {
  if (!isObj(v)) return errors.push(`${where}: match must be an object.`), null;
  const m: ActionMatch = {};
  if (v.type !== undefined) {
    const types = Array.isArray(v.type) ? v.type : [v.type];
    if (!types.every((t) => oneOf(ACTION_TYPES, t))) return errors.push(`${where}: unknown action type in match.`), null;
    m.type = types as ActionType[];
  }
  if (v.target !== undefined) {
    if (typeof v.target !== 'string') return errors.push(`${where}: target must be a string.`), null;
    m.target = v.target;
  }
  if (v.occurrence !== undefined) {
    if (!oneOf(['first', 'last', 'all'] as const, v.occurrence)) return errors.push(`${where}: occurrence must be first, last or all.`), null;
    m.occurrence = v.occurrence;
  }
  if (v.ids !== undefined) {
    if (!Array.isArray(v.ids) || !v.ids.every((i) => typeof i === 'string')) return errors.push(`${where}: ids must be strings.`), null;
    m.ids = v.ids as string[];
  }
  return m;
}

function validateChanges(v: unknown, where: string, errors: string[]): ActionChanges | null {
  if (!isObj(v)) return errors.push(`${where}: changes must be an object.`), null;
  const c: ActionChanges = {};
  const num = (key: keyof ActionChanges, min: number, max: number) => {
    if (v[key] === undefined) return true;
    if (!isNum(v[key]) || (v[key] as number) < min || (v[key] as number) > max) return errors.push(`${where}: ${key} out of range [${min}, ${max}].`), false;
    (c as Record<string, unknown>)[key] = v[key];
    return true;
  };
  if (
    !num('speedFactor', 0.1, 5) ||
    !num('speed', LIMITS.minSpeed, LIMITS.maxSpeed) ||
    !num('amplitude', 0, LIMITS.maxAmplitude) ||
    !num('bend', -30, LIMITS.maxBend) ||
    !num('duration', 0.05, LIMITS.maxDuration) ||
    !num('durationFactor', 0.1, 10)
  )
    return null;
  if (v.style !== undefined) {
    if (!oneOf(STYLES, v.style)) return errors.push(`${where}: unknown style "${String(v.style)}".`), null;
    c.style = v.style;
  }
  if (v.hand !== undefined) {
    if (v.hand !== 'right' && v.hand !== 'left') return errors.push(`${where}: invalid hand.`), null;
    c.hand = v.hand;
  }
  if (Object.keys(c).length === 0) return errors.push(`${where}: no changes given.`), null;
  return c;
}

/** Validates untrusted command JSON (e.g. LLM output). Accepts a single command, an array, or `{commands: [...]}`. */
export function validateCommands(input: unknown, ctx: ValidationContext): CommandValidation {
  const errors: string[] = [];
  const list = Array.isArray(input) ? input : isObj(input) && Array.isArray(input.commands) ? input.commands : [input];
  const out: DirectorCommand[] = [];
  list.forEach((raw, i) => {
    const where = `Command ${i + 1}`;
    if (!isObj(raw)) return void errors.push(`${where}: not an object.`);
    const op = raw.operation;
    if (!oneOf(OPERATIONS, op)) return void errors.push(`${where}: unknown operation "${String(op)}".`);
    const specs = () => {
      if (!Array.isArray(raw.actions) || raw.actions.length === 0) return errors.push(`${where}: actions must be a non-empty array.`), null;
      if (raw.actions.length > LIMITS.maxActions) return errors.push(`${where}: too many actions.`), null;
      const res = raw.actions.map((a, j) => validateSpec(a, `${where}, action ${j + 1}`, ctx, errors));
      return res.every(Boolean) ? (res as ActionSpec[]) : null;
    };
    if (op === 'create_sequence' || op === 'append_actions') {
      const actions = specs();
      if (actions) out.push({ operation: op, actions });
    } else if (op === 'insert_actions') {
      const actions = specs();
      const anchor = validateMatch(raw.anchor, `${where} anchor`, errors);
      if (raw.position !== 'before' && raw.position !== 'after') return void errors.push(`${where}: position must be before or after.`);
      if (actions && anchor) out.push({ operation: op, position: raw.position, anchor, actions });
    } else if (op === 'modify_actions') {
      const match = validateMatch(raw.match ?? {}, `${where} match`, errors);
      const changes = validateChanges(raw.changes, `${where} changes`, errors);
      if (match && changes) out.push({ operation: op, match, changes });
    } else if (op === 'move_actions') {
      const match = validateMatch(raw.match, `${where} match`, errors);
      let to: Extract<DirectorCommand, { operation: 'move_actions' }>['to'] | null = null;
      if (raw.to === 'start' || raw.to === 'end') to = raw.to;
      else if (isObj(raw.to) && (raw.to.position === 'before' || raw.to.position === 'after')) {
        const anchor = validateMatch(raw.to.anchor, `${where} destination`, errors);
        if (anchor) to = { position: raw.to.position, anchor };
      } else errors.push(`${where}: "to" must be start, end or {position, anchor}.`);
      if (match && to) out.push({ operation: op, match, to });
    } else {
      const match = validateMatch(raw.match, `${where} match`, errors);
      if (match) out.push({ operation: 'delete_actions', match });
    }
  });
  if (errors.length || out.length === 0) return { ok: false, errors: errors.length ? errors : ['No commands.'] };
  return { ok: true, commands: out };
}
