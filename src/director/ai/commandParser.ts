import type { ActionMatch, ActionSpec, ActionType, DirectorCommand, Direction } from './commandSchema';
import { ACTION_TYPES } from './commandSchema';

/**
 * Deterministic, rule-based director: understands a fixed set of English (and simple German) phrasings and
 * turns them into structured commands. It never guesses: anything it cannot map is reported as unsupported.
 */
export interface ParseResult {
  commands: DirectorCommand[];
  /** Human-readable explanation of the interpretation. */
  interpretation: string[];
  /** Clauses that could not be understood. */
  unsupported: string[];
}

export interface ParseContext {
  /** Whether a sequence already exists (new action phrases then append instead of replacing it). */
  hasSequence: boolean;
  /** Action types present in the current sequence. */
  existingTypes: ActionType[];
}

const has = (s: string, re: RegExp) => re.test(s);

const TARGET_PATTERNS: [string, RegExp][] = [
  ['table', /\b(table|desk|tisch)\b/],
  ['glass', /\b(glass|cup|glas|becher)\b/],
  ['camera', /\b(camera|kamera|viewer|zuschauer)\b/],
  ['start', /\b(start|starting (point|position)|where (he|she|it) (started|was)|startpunkt|anfang|zurück zum start)\b/],
];

function findTarget(s: string, exclude: string[] = []): string | undefined {
  return TARGET_PATTERNS.find(([id, re]) => !exclude.includes(id) && re.test(s))?.[0];
}

function findDirection(s: string): Direction | undefined {
  if (has(s, /\b(left|links)\b/)) return 'left';
  if (has(s, /\b(right|rechts)\b/)) return 'right';
  if (has(s, /\b(up|upwards|nach oben|hoch)\b/)) return 'up';
  if (has(s, /\b(down|downwards|nach unten|runter)\b/)) return 'down';
  if (has(s, /\b(around|um(dreh|kehr))\b/)) return 'around';
  if (has(s, /\b(back|backwards|zurück)\b/)) return 'back';
  if (has(s, /\b(forward|ahead|straight|vorwärts|geradeaus|nach vorne?)\b/)) return 'forward';
  return undefined;
}

function seconds(s: string): number | undefined {
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(s|sec|secs|second|seconds|sekunden?)\b/);
  if (m) return Math.min(20, Math.max(0.1, parseFloat(m[1].replace(',', '.'))));
  if (has(s, /\b(a moment|briefly|kurz|einen moment)\b/)) return 0.8;
  if (has(s, /\b(a while|long|lange|eine weile)\b/)) return 2.5;
  return undefined;
}

function speedWord(s: string): number | undefined {
  if (has(s, /\b(very slowly|sehr langsam)\b/)) return 0.4;
  if (has(s, /\b(slowly|slow|langsam)\b/)) return 0.6;
  if (has(s, /\b(quickly|fast|rasch|schnell|hurried(ly)?|eilig)\b/)) return 1.5;
  return undefined;
}

function styleWord(s: string): ActionSpec['style'] {
  if (has(s, /\b(nervous(ly)?|anxious(ly)?|nervös|ängstlich)\b/)) return 'nervous';
  if (has(s, /\b(cautious(ly)?|careful(ly)?|vorsichtig)\b/)) return 'cautious';
  if (has(s, /\b(exaggerated(ly)?|dramatic(ally)?|übertrieben)\b/)) return 'exaggerated';
  if (has(s, /\b(calm(ly)?|relaxed(ly)?|ruhig|entspannt)\b/)) return 'calm';
  if (has(s, /\b(hesitant(ly)?|zögerlich|zögernd)\b/)) return 'hesitant';
  return undefined;
}

const withOpt = (spec: ActionSpec, s: string): ActionSpec => {
  const out = { ...spec };
  const sp = speedWord(s);
  if (sp !== undefined) out.speed = sp;
  const st = styleWord(s);
  if (st) out.style = st;
  return out;
};

/** Phrases that describe a part of the sequence (for edits). */
function scopeMatch(s: string): ActionMatch | null {
  if (has(s, /\b(walk(ing)?|gang|gehen|laufen|lauf)\b/)) return { type: 'walk_to' };
  if (has(s, /\b(look(ing)? around|umschauen|umsehen)\b/)) return { type: 'look_around' };
  if (has(s, /\b(look(ing)?|gaze|blick)\b/)) return { type: ['look_at', 'look_around'] };
  if (has(s, /\b(hesitation|pause|wait(ing)?|zögern|pausen?)\b/)) return { type: 'pause' };
  if (has(s, /\b(pick(ing)? ?up|grab(bing)?|aufheben|greifen)\b/)) return { type: ['reach', 'grip', 'lift'] };
  if (has(s, /\b(put(ting)? (it )?down|plac(e|ing)|abstellen|hinstellen)\b/)) return { type: 'place' };
  if (has(s, /\b(releas(e|es|ing)|let(ting)? go|loslassen|loslässt)\b/)) return { type: 'release' };
  if (has(s, /\b(reach(ing)?)\b/)) return { type: 'reach' };
  if (has(s, /\b(bend(ing)?|bücken)\b/)) return { type: 'bend' };
  if (has(s, /\b(turn(ing)?|drehung|drehen)\b/)) return { type: 'turn' };
  return null;
}

/** Interprets one clause as an edit of the existing sequence. */
function parseEdit(s: string, ctx: ParseContext, out: ParseResult): boolean {
  if (!ctx.hasSequence) return false;
  if (has(s, /\b(keep|leave|lass|behalte)\b.*\b(first part|beginning|start|rest|unchanged|anfang|ersten teil|unverändert)\b/)) {
    out.interpretation.push('Keeping the existing actions unchanged (edits only touch the actions they name).');
    return true;
  }
  // "look around before putting down the glass" / "pause before releasing" -> insert
  const ins = s.match(/^(.*?)\b(before|after|bevor|vor dem|vor|nach dem|nachdem|nach)\b(.*)$/);
  if (ins && !has(ins[1], /\b(move|verschieb)/)) {
    const anchor = scopeMatch(ins[3]);
    const specs = parseActions(ins[1], out, true);
    if (anchor && specs && specs.length) {
      const position = /^(before|bevor|vor)/.test(ins[2]) ? 'before' : 'after';
      out.commands.push({ operation: 'insert_actions', position, anchor: { ...anchor, occurrence: position === 'before' ? 'first' : 'last' }, actions: specs });
      out.interpretation.push(`Insert ${specs.map((x) => x.type).join(', ')} ${position} ${describe(anchor)}.`);
      return true;
    }
  }
  const mv = s.match(/\b(move|put|verschieb\w*|setz\w*)\b(.*)\b(to the (end|start|beginning)|ans ende|an den anfang|zum schluss)\b/);
  if (mv) {
    const m = scopeMatch(mv[2]);
    if (m) {
      const to = /end|ende|schluss/.test(mv[3]) ? 'end' : 'start';
      out.commands.push({ operation: 'move_actions', match: m, to });
      out.interpretation.push(`Move ${describe(m)} to the ${to}.`);
      return true;
    }
  }
  if (has(s, /\b(remove|delete|drop|skip|don't|do not|without|entfern\w*|lösch\w*|ohne|weglassen)\b/)) {
    const m = scopeMatch(s);
    if (m) {
      out.commands.push({ operation: 'delete_actions', match: m });
      out.interpretation.push(`Delete ${describe(m)}.`);
      return true;
    }
  }
  const scope: ActionMatch = scopeMatch(s.replace(/\b(do it|mach es|das ganze)\b/, '')) ?? {};
  const changes: Extract<DirectorCommand, { operation: 'modify_actions' }>['changes'] = {};
  if (has(s, /\b(much )?(slower|more slowly|langsamer)\b/)) changes.speedFactor = has(s, /\bmuch|viel\b/) ? 0.5 : 0.7;
  if (has(s, /\b(faster|quicker|more quickly|schneller)\b/)) changes.speedFactor = has(s, /\bmuch|viel\b/) ? 2 : 1.4;
  if (has(s, /\b(more )?(cautious|careful|vorsichtiger|vorsichtig)\b/)) {
    changes.style = 'cautious';
    changes.speedFactor = (changes.speedFactor ?? 1) * 0.8;
  }
  if (has(s, /\b(more )?(nervous|nervöser|nervös)\b/)) changes.style = 'nervous';
  if (has(s, /\b(more )?(exaggerated|dramatic|übertriebener|übertrieben)\b/)) {
    changes.style = 'exaggerated';
    changes.amplitude = 1.6;
  }
  if (has(s, /\b(subtler|more subtle|smaller|dezenter|kleiner)\b/)) changes.amplitude = 0.6;
  if (has(s, /\b(calmer|more relaxed|ruhiger)\b/)) changes.style = 'calm';
  if (has(s, /\b(bend(ing)? (more|further)|more bent|bend forward|tiefer gebückt|mehr bücken)\b/)) changes.bend = 25;
  if (has(s, /\b(left hand|linke[nr]? hand)\b/)) changes.hand = 'left';
  if (has(s, /\b(right hand|rechte[nr]? hand)\b/)) changes.hand = 'right';
  const secs = seconds(s);
  if (secs !== undefined && has(s, /\b(longer|shorter|last|länger|kürzer|dauern?)\b/)) changes.duration = secs;
  else if (has(s, /\b(longer|länger)\b/)) changes.durationFactor = 1.5;
  else if (has(s, /\b(shorter|kürzer)\b/)) changes.durationFactor = 0.6;
  if (Object.keys(changes).length === 0) return false;
  if (changes.durationFactor !== undefined && !scope.type) scope.type = ['pause', 'look_around', 'look_at', 'idle', 'bend'];
  if (changes.hand) scope.type = ['reach', 'grip', 'lift', 'place', 'release'];
  out.commands.push({ operation: 'modify_actions', match: scope, changes });
  out.interpretation.push(`Change ${scope.type ? describe(scope) : 'all actions'}: ${Object.entries(changes).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`).join(', ')}.`);
  return true;
}

function describe(m: ActionMatch): string {
  const t = m.type === undefined ? ['actions'] : Array.isArray(m.type) ? m.type : [m.type];
  return t.join('/');
}

/** Parses action phrases in a clause. Returns null if the clause has no recognisable action. */
function parseActions(s: string, out: ParseResult, quiet = false): ActionSpec[] | null {
  const specs: ActionSpec[] = [];
  const parts = s.split(/\b(?:and then|then|and|und dann|dann|danach|anschließend|und)\b|,/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts.length ? parts : [s]) {
    const res = parseOne(p);
    if (!res) {
      if (!quiet) out.unsupported.push(p);
      else return null;
      continue;
    }
    specs.push(...res);
  }
  return specs.length ? specs : null;
}

function parseOne(p: string): ActionSpec[] | null {
  const bendWhile = has(p, /\b(bending|bent|stooped|hunched|leaning)\b( forward)?|\bgebückt|vorgebeugt/);
  if (has(p, /\b(walk|go|move|step|stroll|head|come|approach|geh\w*|lauf\w*|lauf|schreit\w*|komm\w*)\b/) && !has(p, /\b(look|schau)/)) {
    const target = findTarget(p);
    const spec: ActionSpec = target ? { type: 'walk_to', target } : { type: 'walk_to', direction: findDirection(p) ?? 'forward' };
    if (has(p, /\b(back to the start|back to start|zurück\b)/) && !target) spec.target = 'start';
    if (spec.target) delete spec.direction;
    const w = withOpt(spec, p);
    if (bendWhile) w.bend = 25;
    return [w];
  }
  if (has(p, /\b(pick(s|ing)? (it |the \w+ )?up|grab|take|nimm|nehm\w*|heb\w* .*auf|aufheben|hol\w*)\b/)) {
    return [withOpt({ type: 'reach', target: 'glass' }, p), withOpt({ type: 'grip', target: 'glass' }, p), withOpt({ type: 'lift', object: 'glass' }, p)];
  }
  if (has(p, /\b(reach(es)?( out)?( for| to)?|streck\w*|greif\w* nach)\b/)) return [withOpt({ type: 'reach', target: 'glass' }, p)];
  if (has(p, /\b(grip|grasp|hold|greif\w*|halt\w*|pack\w*)\b/)) return [withOpt({ type: 'grip', target: 'glass' }, p)];
  if (has(p, /\b(lift|raise|heb\w*|anheben)\b/)) return [withOpt({ type: 'lift', object: 'glass' }, p)];
  if (has(p, /\b(place|put|set|lay|stell\w*|setz\w*|leg\w*|abstellen)\b/)) return [withOpt({ type: 'place', object: 'glass', target: 'table' }, p)];
  if (has(p, /\b(release|let go|drop it|open (the |his |her )?hand|los(lassen|lässt|lass))\b/)) return [withOpt({ type: 'release', object: 'glass' }, p)];
  if (has(p, /\b(look(s|ing)? around|glance around|scan the room|schau\w* (sich |dich )?um|umschauen|umsehen|sieh\w* (sich |dich )?um)\b/)) {
    const spec = withOpt({ type: 'look_around' }, p);
    const d = seconds(p);
    if (d) spec.duration = d;
    return [spec];
  }
  if (has(p, /\b(look|glance|stare|gaze|watch|schau\w*|blick\w*|sieh\w*|guck\w*)\b/)) {
    const target = findTarget(p);
    const spec: ActionSpec = target ? { type: 'look_at', target } : { type: 'look_at', direction: findDirection(p) ?? 'forward' };
    const d = seconds(p);
    if (d) spec.duration = d;
    return [withOpt(spec, p)];
  }
  if (has(p, /\b(pause|wait|hesitate|stop for|freeze|warte\w*|zöger\w*|innehalten|halt inne)\b/)) {
    return [{ type: 'pause', duration: seconds(p) ?? (has(p, /hesitat|zöger/) ? 1.2 : 1) }];
  }
  if (has(p, /\b(turn|rotate|face|dreh\w*|wend\w*)\b/)) {
    const target = findTarget(p);
    return [withOpt(target ? { type: 'turn', target } : { type: 'turn', direction: findDirection(p) ?? 'around' }, p)];
  }
  if (has(p, /\b(bend|bow|stoop|lean|bück\w*|beug\w*)\b/)) {
    const m = p.match(/(\d+)\s*(°|deg|degrees|grad)/);
    const spec: ActionSpec = { type: 'bend', bend: m ? Math.min(70, +m[1]) : 35 };
    const d = seconds(p);
    if (d) spec.duration = d;
    return [withOpt(spec, p)];
  }
  if (has(p, /\b(idle|stand( still)?|relax|rest|steh\w*|ruh\w*)\b/)) {
    const d = seconds(p);
    return [d ? { type: 'idle', duration: d } : { type: 'idle' }];
  }
  return null;
}

export function parseDirection(text: string, ctx: ParseContext): ParseResult {
  const out: ParseResult = { commands: [], interpretation: [], unsupported: [] };
  const norm = text.toLowerCase().replace(/[“”"!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return out;
  const sentences = norm.split(/[.;]|\b(?:but|aber|also|außerdem)\b/).map((x) => x.trim()).filter(Boolean);
  let createNew = !ctx.hasSequence || has(norm, /\b(start over|from scratch|new (scene|take|sequence)|instead|neu anfangen|von vorne?|stattdessen)\b/);
  const pending: ActionSpec[] = [];
  for (const sRaw of sentences) {
    const s = sRaw.replace(/\b(start over|from scratch|instead|stattdessen|please|bitte|now|jetzt|the actor|he|she|er|sie)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (!createNew && parseEdit(s, ctx, out)) continue;
    const specs = parseActions(s, out);
    if (specs) pending.push(...specs);
  }
  if (pending.length) {
    const operation = createNew ? 'create_sequence' : 'append_actions';
    out.commands.unshift({ operation, actions: pending });
    out.interpretation.unshift(`${createNew ? 'New sequence' : 'Append'}: ${pending.map((p) => p.type + (p.target ? `(${p.target})` : p.direction ? `(${p.direction})` : '')).join(' → ')}.`);
    createNew = false;
  }
  if (out.unsupported.length && out.commands.length === 0) {
    out.interpretation.push(`Not supported: "${out.unsupported.join('", "')}". Supported actions: ${ACTION_TYPES.join(', ')}.`);
  }
  return out;
}
