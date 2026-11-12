import type { ActionMatch, DirectorAction, DirectorCommand } from './commandSchema';

/**
 * Explicit editing context for follow-up instructions. "It", "the movement" or "do it more slowly" refer to the
 * selected action if there is one, otherwise to the actions the previous instruction created or changed.
 */
export interface EditContext {
  selectedActionId: string | null;
  /** Actions created/changed by the last applied instruction (non-automatic ones preferred). */
  lastAffected: string[];
}

export type Resolution = { kind: 'ok'; command: DirectorCommand; scopeNote?: string } | { kind: 'clarify'; question: string } | { kind: 'error'; message: string };

type Times = Map<string, { start: number; end: number }>;

const describeIds = (actions: DirectorAction[], ids: string[]) => {
  const types = actions.filter((a) => ids.includes(a.id)).map((a) => a.type);
  return types.length > 4 ? `${types.length} actions` : types.join(', ');
};

/** Resolves a match with a `scope` into concrete action ids. */
function resolveMatch(m: ActionMatch, actions: DirectorAction[], ctx: EditContext, times: Times): { match: ActionMatch; note?: string } | { clarify: true } | { error: string } {
  if (!m.scope) return { match: m };
  const rest: ActionMatch = { ...m };
  delete rest.scope;
  if (actions.length === 0) return { error: 'There is no performance yet. Tell me what the actor should do first, e.g. "Walk to the table."' };
  const all = actions.map((a) => a.id);
  let ids: string[];
  let note: string | undefined;
  switch (m.scope) {
    case 'sequence':
      ids = all;
      note = 'the whole performance';
      break;
    case 'first_part':
    case 'last_part': {
      const total = Math.max(...actions.map((a) => times.get(a.id)?.end ?? 0));
      const inPart = (a: DirectorAction) => {
        const t = times.get(a.id);
        if (!t) return false;
        const mid = (t.start + t.end) / 2;
        return m.scope === 'first_part' ? mid <= total / 3 : mid >= (2 * total) / 3;
      };
      ids = actions.filter(inPart).map((a) => a.id);
      if (ids.length === 0) ids = [m.scope === 'first_part' ? all[0] : all[all.length - 1]];
      note = `the ${m.scope === 'first_part' ? 'first' : 'last'} part (${describeIds(actions, ids)})`;
      break;
    }
    case 'context': {
      if (ctx.selectedActionId && all.includes(ctx.selectedActionId)) {
        ids = [ctx.selectedActionId];
        note = `the selected ${describeIds(actions, ids)}`;
      } else {
        const last = ctx.lastAffected.filter((id) => all.includes(id));
        const manual = actions.filter((a) => !a.auto);
        if (last.length) {
          ids = last;
          note = last.length === all.length ? 'the whole performance' : `the last edited ${describeIds(actions, ids)}`;
        } else if (manual.length === 1) {
          ids = [manual[0].id];
          note = manual[0].type;
        } else return { clarify: true };
      }
      break;
    }
  }
  return { match: { ...rest, ids }, note };
}

/** Replaces contextual scopes by concrete ids. Asks for clarification when "it" cannot be resolved. */
export function resolveCommand(cmd: DirectorCommand, actions: DirectorAction[], ctx: EditContext, times: Times): Resolution {
  const notes: string[] = [];
  let clarify = false;
  let error: string | null = null;
  const fix = (m: ActionMatch): ActionMatch => {
    const r = resolveMatch(m, actions, ctx, times);
    if ('clarify' in r) clarify = true;
    else if ('error' in r) error = r.error;
    else {
      if (r.note) notes.push(r.note);
      return r.match;
    }
    return m;
  };
  const out = { ...cmd } as DirectorCommand & { match?: ActionMatch; anchor?: ActionMatch; to?: unknown };
  if ('match' in cmd) out.match = fix(cmd.match);
  if ('anchor' in cmd) out.anchor = fix(cmd.anchor);
  if (cmd.operation === 'move_actions' && typeof cmd.to === 'object') out.to = { ...cmd.to, anchor: fix(cmd.to.anchor) };
  if (error) return { kind: 'error', message: error };
  if (clarify) {
    const types = [...new Set(actions.filter((a) => !a.auto).map((a) => a.type))].join(', ');
    return { kind: 'clarify', question: `Which part do you mean: the whole performance, or one action (${types})? Answer e.g. "the whole sequence" or "the walk", or select a clip in the timeline.` };
  }
  return { kind: 'ok', command: out, scopeNote: notes.join(', ') || undefined };
}

/** For a clarification answer: replaces `context` scopes in the original commands by the user's choice. */
export function substituteContext(commands: DirectorCommand[], answer: ActionMatch): DirectorCommand[] {
  const sub = (m: ActionMatch): ActionMatch => (m.scope === 'context' ? { ...answer } : m);
  return commands.map((c) => {
    const o = { ...c } as DirectorCommand & { match?: ActionMatch; anchor?: ActionMatch };
    if ('match' in c) o.match = sub(c.match);
    if ('anchor' in c) o.anchor = sub(c.anchor);
    return o;
  });
}
