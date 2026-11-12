/**
 * Optional local language-model interpreter (Ollama, LM Studio or any OpenAI-compatible server on the user's
 * machine). The model only translates the instruction into the director's command JSON; its output is untrusted
 * and goes through `validateCommands`, the planner and the composer exactly like the rule-based parser's.
 */
import { STYLES, type DirectorAction } from './commandSchema';

export interface LlmSettings {
  enabled: boolean;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio). */
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b', timeoutMs: 180000 };

export interface LlmContext {
  objectIds: string[];
  actions: DirectorAction[];
  durations: Map<string, number>;
  selectedActionId: string | null;
}

export interface LlmResult {
  commands: unknown;
  interpretation: string;
  unsupported: string[];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>;

const SYSTEM_PROMPT = `You translate instructions for a 3D animation director into JSON commands for a fixed action engine.
Reply with JSON only: {"interpretation": "<short English summary>", "commands": [...], "unsupported": ["<parts you cannot express>"]}.

Scene: actor, table, glass (standing on the table), chair (next to the table), camera. "start" is the actor's start mark.

Action = {"type": TYPE, ...optional fields}. TYPE is one of:
- walk_to: "target" (table | glass | chair | start | camera) or "direction" (forward | back | left | right). "walk back", "go back", "return" = {"type":"walk_to","target":"start"}. "walk backwards" = direction "back".
- turn: "direction" (left | right | around) or "target".
- pick_up: target "glass". Use it for "pick up", "grab", "take" the glass.
- put_down: target "table". Use it for "put down", "set down", "put back" the glass.
- reach, grip, lift, place, release: the single steps of pick_up / put_down, only when the user names one step on its own.
- look_at: "target" or "direction" (left | right | up | down).
- look_around
- pause, idle: "duration" in seconds.
- bend: "bend" in degrees.
- sit: target "chair". stand_up.
Optional on any action: "speed" (0.2-3, 1 = normal), "duration" (seconds), "style" (${STYLES.join(' | ')}), "amplitude" (0-2.5), "hand" (right | left).
Keep the user's order and include every step the user mentions, also repeated ones. The engine inserts missing steps itself (walking to the glass or chair, standing up before walking, releasing after placing), so you may leave those out.

Operations:
- {"operation":"create_sequence","actions":[...]}: a new performance, replacing the current one. Use it when there is no sequence yet or the user describes a whole new scene.
- {"operation":"append_actions","actions":[...]}: add to the end.
- {"operation":"insert_actions","position":"before"|"after","anchor":MATCH,"actions":[...]}
- {"operation":"modify_actions","match":MATCH,"changes":{"speedFactor"?, "speed"?, "style"?, "amplitude"?, "bend"?, "duration"?, "durationFactor"?, "hand"?}}
- {"operation":"move_actions","match":MATCH,"to":"start"|"end"|{"position":"before"|"after","anchor":MATCH}}
- {"operation":"delete_actions","match":MATCH}
- {"operation":"set_duration"|"set_min_duration"|"set_max_duration","match":MATCH,"seconds":N}: exactly / at least / at most N seconds.
- {"operation":"scale_duration","match":MATCH,"factor":N}: 2 = twice as slow, 0.5 = twice as fast.
- {"operation":"insert_pause","position":"before"|"after","anchor":MATCH,"seconds":N}
- {"operation":"modify_style","match":MATCH,"style"?:STYLE,"amplitude"?:N}
MATCH = {"type"?: TYPE or [TYPE], "target"?: id, "occurrence"?: "first"|"last"|"all", "ids"?: [action ids], "scope"?: "context"|"sequence"|"first_part"|"last_part"}.
"it", "that", "the movement" = {"scope":"context"}. "the whole performance" = {"scope":"sequence"}.
Never invent action types, objects or fields. Anything you cannot express goes into "unsupported" and is left out of "commands".

Example. Sequence: none. Instruction: "Stroll over to the glass, grab it and take a sip-like pause, then put it back."
{"interpretation":"walk to the glass, pick it up, pause, put it back","commands":[{"operation":"create_sequence","actions":[{"type":"walk_to","target":"glass","speed":0.8},{"type":"pick_up","target":"glass"},{"type":"pause","duration":1.5},{"type":"put_down","target":"table"}]}],"unsupported":[]}

Example. Sequence: none. Instruction: "go over to the camera, turn around, go back and then go to the chair and sit"
{"interpretation":"walk to the camera, turn around, walk back to the start, walk to the chair, sit","commands":[{"operation":"create_sequence","actions":[{"type":"walk_to","target":"camera"},{"type":"turn","direction":"around"},{"type":"walk_to","target":"start"},{"type":"walk_to","target":"chair"},{"type":"sit","target":"chair"}]}],"unsupported":[]}

Example. Sequence: a1 walk_to(table) 2.4s, a2 reach(glass) 0.9s. Instruction: "make it take at least 6 seconds and do a backflip"
{"interpretation":"the last change lasts at least 6 s","commands":[{"operation":"set_min_duration","match":{"scope":"context"},"seconds":6}],"unsupported":["do a backflip"]}

Example. Sequence: a1 walk_to(table) 2.4s, a2 look_at(left) 1.0s. Instruction: "look right instead of left, and walk faster"
{"interpretation":"look right instead of left; walk faster","commands":[{"operation":"delete_actions","match":{"type":"look_at"}},{"operation":"append_actions","actions":[{"type":"look_at","direction":"right"}]},{"operation":"modify_actions","match":{"type":"walk_to"},"changes":{"speedFactor":1.4}}],"unsupported":[]}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    interpretation: { type: 'string' },
    commands: { type: 'array', items: { type: 'object' } },
    unsupported: { type: 'array', items: { type: 'string' } },
  },
  required: ['interpretation', 'commands', 'unsupported'],
};

function describeAction(a: DirectorAction, durations: Map<string, number>) {
  const arg = a.target ?? a.direction ?? '';
  const d = durations.get(a.id);
  return `${a.id} ${a.type}${arg ? `(${arg})` : ''}${d !== undefined ? ` ${d.toFixed(1)}s` : ''}${a.auto ? ' [auto]' : ''}`;
}

const MACROS: Record<string, { steps: string[]; target: string }> = {
  pick_up: { steps: ['reach', 'grip', 'lift'], target: 'glass' },
  put_down: { steps: ['place', 'release'], target: 'table' },
};

/** Expands the model-only shorthands pick_up / put_down into the engine's steps (before validation). */
export function expandMacros(commands: unknown): unknown {
  if (!Array.isArray(commands)) return commands;
  return commands.map((c) => {
    if (typeof c !== 'object' || c === null || !Array.isArray((c as { actions?: unknown }).actions)) return c;
    const actions = ((c as { actions: unknown[] }).actions).flatMap((a) => {
      const m = typeof a === 'object' && a !== null ? MACROS[(a as { type?: string }).type ?? ''] : undefined;
      if (!m) return [a];
      const { type: _t, target, ...rest } = a as Record<string, unknown>;
      void _t;
      return m.steps.map((type, i) => ({ ...rest, type, ...(i === 0 || type === 'grip' ? { target: target ?? m.target } : {}) }));
    });
    return { ...c, actions };
  });
}

export function buildMessages(text: string, c: LlmContext) {
  const seq = c.actions.length ? c.actions.map((a) => describeAction(a, c.durations)).join(', ') : 'none';
  const user = `Scene objects: ${c.objectIds.join(', ')}.\nSequence: ${seq}.\nSelected action: ${c.selectedActionId ?? 'none'}.\nInstruction: "${text}"`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Extracts the JSON object from a model reply (tolerates code fences and surrounding prose). */
export function extractJson(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the reply contained no JSON object');
  return JSON.parse(content.slice(start, end + 1));
}

const endpoint = (s: LlmSettings, path: string) => `${s.baseUrl.replace(/\/+$/, '')}${path}`;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`no answer within ${Math.round(ms / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Asks the model to translate `text`. Throws on network, HTTP or format errors (callers fall back to the parser). */
export async function interpretWithModel(text: string, c: LlmContext, s: LlmSettings, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<LlmResult> {
  const body = (format: object | undefined) =>
    JSON.stringify({ model: s.model, messages: buildMessages(text, c), temperature: 0, seed: 0, stream: false, ...(format ? { response_format: format } : {}) });
  return withTimeout(s.timeoutMs, async (signal) => {
    const post = (format?: object) => fetchImpl(endpoint(s, '/chat/completions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(format), signal });
    let res = await post({ type: 'json_schema', json_schema: { name: 'director_commands', strict: false, schema: RESPONSE_SCHEMA } });
    // Servers without structured-output support reject response_format; the prompt alone still asks for JSON.
    if (res.status === 400) res = await post();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('unexpected response format');
    const json = extractJson(content) as Record<string, unknown>;
    return {
      commands: expandMacros(json.commands ?? json),
      interpretation: typeof json.interpretation === 'string' ? json.interpretation.trim().replace(/[.\s]+$/, '') : '',
      unsupported: Array.isArray(json.unsupported) ? json.unsupported.filter((u): u is string => typeof u === 'string' && u.trim() !== '') : [],
    };
  });
}

/** Lists the server's models (GET /models) to check the connection from the settings panel. */
export async function listModels(s: LlmSettings, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  return withTimeout(5000, async (signal) => {
    const res = await fetchImpl(endpoint(s, '/models'), { method: 'GET', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  });
}

