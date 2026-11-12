import type { DirectorProject, ChatEntry } from '../persistence/directorProject';
import { composePerformance, type ComposerContext, type Performance } from '../animation/motionComposer';
import { applyCommand } from '../planning/actionPlanner';
import type { Measure } from '../timeline/retiming';
import { parseDirection, parseScopeAnswer, type ParseResult } from './commandParser';
import { interpretWithModel, type FetchLike, type LlmSettings } from './llmInterpreter';
import { validateCommands, TIMING_OPERATIONS, type DirectorAction, type DirectorCommand } from './commandSchema';
import { resolveCommand, substituteContext, type EditContext } from './editContext';

export const actionDurations = (perf: Performance) => new Map([...perf.actionTimes].map(([id, t]) => [id, t.end - t.start]));

/** Ids the last applied instruction created or changed (persisted in the chat, so it survives reloads). */
export function lastAffected(chat: ChatEntry[]): string[] {
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i];
    if (c.role === 'director' && c.ok && c.affected?.length) return c.affected;
  }
  return [];
}

export interface PromptOutcome {
  ok: boolean;
  reply: string;
  /** Whether the action list changed (an undoable edit). */
  changed: boolean;
  actions: DirectorAction[];
  nextId: number;
  /** The user's entry and the director's reply. */
  entries: [ChatEntry, ChatEntry];
}

let fallbackId = 0;

/**
 * One director turn: parse → validate → resolve contextual references ("it", "the whole sequence") against the
 * selection and the previous instruction → apply. Pure apart from id generation. Unknown phrasing changes
 * nothing; ambiguous references produce a clarification question whose short answer completes the prompt.
 */
export function runPrompt(
  ctx: ComposerContext,
  project: Pick<DirectorProject, 'actions' | 'chat' | 'scene' | 'nextId'>,
  text: string,
  selectedActionId: string | null = null,
  chatId: () => string = () => `c${++fallbackId}`,
  interpreted?: ParseResult,
): PromptOutcome {
  const trimmed = text.trim();
  const userEntry: ChatEntry = { id: chatId(), role: 'user', text: trimmed };
  const pctx = { hasSequence: project.actions.length > 0, existingTypes: project.actions.map((a) => a.type) };
  const lastDirector = [...project.chat].reverse().find((c) => c.role === 'director');
  let parsed = interpreted ?? parseDirection(trimmed, pctx);
  // A short reply to a clarification question ("the walk") names the target instead of being a new action.
  const answer = lastDirector?.clarify && !interpreted ? parseScopeAnswer(trimmed) : null;
  if (answer && lastDirector?.clarify) {
    const original = parseDirection(lastDirector.clarify.prompt, pctx);
    parsed = { ...original, commands: substituteContext(original.commands, answer), interpretation: [`"${lastDirector.clarify.prompt}" →`, ...original.interpretation] };
  }
  const measure: Measure = (acts) => actionDurations(composePerformance(ctx, project.scene, acts));
  const times = (acts: DirectorAction[]) => composePerformance(ctx, project.scene, acts).actionTimes;
  let reply: string;
  let ok = false;
  let clarify: ChatEntry['clarify'];
  let actions = project.actions;
  let n = project.nextId;
  const nextId = () => `a${n++}`;
  const applied: DirectorCommand[] = [];
  const affected = new Set<string>();
  if (parsed.commands.length === 0) {
    reply = parsed.interpretation.length ? parsed.interpretation.join(' ') : `I don't know how to perform "${trimmed}".`;
    ok = parsed.unsupported.length === 0 && parsed.interpretation.length > 0;
  } else {
    const valid = validateCommands(parsed.commands, { objectIds: project.scene.objects.map((o) => o.id) });
    if (!valid.ok) reply = `Rejected: ${valid.errors.join(' ')}`;
    else {
      const notes: string[] = [];
      let error: string | null = null;
      const ectx: EditContext = { selectedActionId, lastAffected: lastAffected(project.chat) };
      for (const cmd of valid.commands) {
        const res = resolveCommand(cmd, actions, ectx, times(actions));
        if (res.kind === 'clarify') {
          clarify = { prompt: trimmed };
          error = res.question;
          break;
        }
        if (res.kind === 'error') {
          error = res.message;
          break;
        }
        const r = applyCommand(actions, res.command, project.scene, nextId, userEntry.id, { measure });
        if (!r.ok) {
          error = r.errors.join(' ');
          break;
        }
        const known = new Set(actions.map((a) => a.id));
        actions = r.actions;
        if (res.scopeNote) notes.push(`(Applied to ${res.scopeNote}.)`);
        notes.push(...r.notes);
        applied.push(res.command);
        const manual = r.changed.filter((id) => !actions.find((a) => a.id === id)?.auto);
        const now = manual.length ? manual : r.changed;
        if (now.length) {
          for (const id of now) affected.add(id);
          ectx.lastAffected = now;
          if (now.some((id) => !known.has(id))) ectx.selectedActionId = null;
        } else if ((TIMING_OPERATIONS as readonly string[]).includes(cmd.operation) && 'match' in res.command && res.command.match.ids) {
          // An already-satisfied timing constraint still establishes what "it" refers to.
          for (const id of res.command.match.ids) affected.add(id);
        }
      }
      if (clarify) reply = error!;
      else if (error) reply = `Not applied: ${error}`;
      else {
        ok = true;
        const unchanged = JSON.stringify(actions) === JSON.stringify(project.actions);
        reply = unchanged ? `No change. ${notes.join(' ')}`.trim() : [...parsed.interpretation, ...notes].join(' ');
        if (parsed.unsupported.length) reply += ` Not applied (not supported): "${parsed.unsupported.join('", "')}".`;
        if (unchanged) applied.length = 0;
      }
    }
  }
  const changed = ok && applied.length > 0;
  const dirEntry: ChatEntry = { id: chatId(), role: 'director', text: reply, ok, commands: applied.length ? applied : undefined, affected: affected.size ? [...affected] : undefined, clarify };
  return { ok, reply, changed, actions: changed ? actions : project.actions, nextId: n, entries: [userEntry, dirEntry] };
}

type Project = Pick<DirectorProject, 'actions' | 'chat' | 'scene' | 'nextId'>;

/**
 * A director turn interpreted by a local language model. The model's JSON is validated before anything is applied;
 * if the server is unreachable, times out, replies with invalid commands or understands nothing, the rule-based
 * parser handles the prompt instead and the reply says why.
 */
export async function runPromptWithModel(
  ctx: ComposerContext,
  project: Project,
  text: string,
  selectedActionId: string | null,
  chatId: () => string,
  settings: LlmSettings,
  fetchImpl?: FetchLike,
): Promise<PromptOutcome & { usedModel: boolean }> {
  const lastDirector = [...project.chat].reverse().find((c) => c.role === 'director');
  if (lastDirector?.clarify && parseScopeAnswer(text.trim())) return { ...runPrompt(ctx, project, text, selectedActionId, chatId), usedModel: false };
  const objectIds = project.scene.objects.map((o) => o.id);
  let why: string;
  try {
    const durations = actionDurations(composePerformance(ctx, project.scene, project.actions));
    const r = await interpretWithModel(text.trim(), { objectIds, actions: project.actions, durations, selectedActionId }, settings, fetchImpl);
    const valid = validateCommands(r.commands, { objectIds });
    if (valid.ok) {
      const interpretation = [`${settings.model}: ${r.interpretation || 'interpreted'}.`];
      return { ...runPrompt(ctx, project, text, selectedActionId, chatId, { commands: valid.commands, interpretation, unsupported: r.unsupported }), usedModel: true };
    }
    why = Array.isArray(r.commands) && r.commands.length === 0 ? 'the model found nothing to do' : `the model's commands were invalid (${valid.errors.slice(0, 2).join(' ')})`;
  } catch (e) {
    why = `the model is unavailable (${(e as Error).message})`;
  }
  const out = runPrompt(ctx, project, text, selectedActionId, chatId);
  const note = `[Rule-based parser used: ${why}.] `;
  out.reply = note + out.reply;
  out.entries[1] = { ...out.entries[1], text: note + out.entries[1].text };
  return { ...out, usedModel: false };
}
