import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMannequin } from '../../src/rig/mannequinLoader';
import { ACTION_TYPES, validateCommands } from '../../src/director/ai/commandSchema';
import { runPromptWithModel } from '../../src/director/ai/directorSession';
import { buildMessages, DEFAULT_LLM_SETTINGS, expandMacros, extractJson, type FetchLike } from '../../src/director/ai/llmInterpreter';
import { ComposerContext } from '../../src/director/animation/motionComposer';
import { defaultScene } from '../../src/director/scene/sceneModel';

let ctx: ComposerContext;
const scene = defaultScene();
const settings = { ...DEFAULT_LLM_SETTINGS, enabled: true, timeoutMs: 2000 };
let n = 0;
const chatId = () => `c${++n}`;

beforeAll(async () => {
  const buf = readFileSync('public/models/mannequin.glb');
  ctx = new ComposerContext(await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
});

/** Fake OpenAI-compatible server answering with `content`; records the request bodies. */
function server(content: string | (() => never), status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const f: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    if (typeof content === 'function') content();
    return { ok: status < 300, status, json: async () => ({ choices: [{ message: { content } }] }), text: async () => 'error' };
  };
  return { f, bodies };
}

const project = () => ({ actions: [], chat: [], scene, nextId: 1 });

describe('local model interpreter', () => {
  it('describes every action type to the model and includes the current sequence and selection', () => {
    const msgs = buildMessages('walk', { objectIds: ['actor', 'chair'], actions: [{ id: 'a1', type: 'walk_to', target: 'table', speed: 1 }], durations: new Map([['a1', 2.345]]), selectedActionId: 'a1' });
    for (const t of ACTION_TYPES) expect(msgs[0].content).toContain(t);
    expect(msgs[1].content).toContain('a1 walk_to(table) 2.3s');
    expect(msgs[1].content).toContain('Selected action: a1');
  });

  it('expands the pick_up / put_down shorthands into engine steps', () => {
    expect(expandMacros([{ operation: 'append_actions', actions: [{ type: 'pick_up', speed: 0.5 }, { type: 'look_at', direction: 'left' }, { type: 'put_down', target: 'table' }] }])).toEqual([
      {
        operation: 'append_actions',
        actions: [
          { type: 'reach', target: 'glass', speed: 0.5 },
          { type: 'grip', target: 'glass', speed: 0.5 },
          { type: 'lift', speed: 0.5 },
          { type: 'look_at', direction: 'left' },
          { type: 'place', target: 'table' },
          { type: 'release' },
        ],
      },
    ]);
  });

  it('reads timing edits without a target as "it", not as the whole performance', () => {
    const v = validateCommands([{ operation: 'set_min_duration', match: {}, seconds: 8 }, { operation: 'scale_duration', factor: 2 }], { objectIds: ['actor'] });
    expect(v.ok && v.commands.map((c) => ('match' in c ? c.match : null))).toEqual([{ scope: 'context' }, { scope: 'context' }]);
  });

  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('Sure!\n```json\n{"commands": []}\n```')).toEqual({ commands: [] });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('applies validated model commands through the planner', async () => {
    const reply = JSON.stringify({
      interpretation: 'walk over, sit, come back',
      commands: [{ operation: 'create_sequence', actions: [{ type: 'walk_to', target: 'table' }, { type: 'sit', target: 'chair' }, { type: 'walk_to', target: 'start' }] }],
      unsupported: ['wave'],
    });
    const { f, bodies } = server(reply);
    const r = await runPromptWithModel(ctx, project(), 'stroll to the table, take a seat, come back and wave', null, chatId, settings, f);
    expect(r.usedModel).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.actions.map((a) => a.type)).toEqual(['walk_to', 'walk_to', 'sit', 'pause', 'stand_up', 'walk_to']);
    expect(r.reply).toContain('qwen2.5:3b: walk over, sit, come back.');
    expect(r.reply).toContain('Not applied (not supported): "wave"');
    expect(bodies[0]).toMatchObject({ model: 'qwen2.5:3b', temperature: 0, stream: false });
  });

  it('falls back to the rule-based parser when the model output is invalid', async () => {
    const { f } = server(JSON.stringify({ interpretation: 'x', commands: [{ operation: 'create_sequence', actions: [{ type: 'teleport', target: 'table' }] }], unsupported: [] }));
    const r = await runPromptWithModel(ctx, project(), 'Walk to the table.', null, chatId, settings, f);
    expect(r.usedModel).toBe(false);
    expect(r.reply).toMatch(/^\[Rule-based parser used: the model's commands were invalid \(.*teleport/);
    expect(r.actions.map((a) => a.type)).toEqual(['walk_to']);
    expect(r.entries[1].text).toBe(r.reply);
  });

  it('falls back when the server is unreachable or returns an error', async () => {
    const down = await runPromptWithModel(ctx, project(), 'Walk to the table.', null, chatId, settings, server(() => {
      throw new TypeError('Failed to fetch');
    }).f);
    expect(down.reply).toMatch(/model is unavailable \(Failed to fetch\)/);
    expect(down.actions).toHaveLength(1);
    const err = await runPromptWithModel(ctx, project(), 'Walk to the table.', null, chatId, settings, server('', 500).f);
    expect(err.reply).toMatch(/HTTP 500/);
  });

  it('never applies anything the planner rejects', async () => {
    const { f } = server(JSON.stringify({ interpretation: 'sit with the glass', commands: [{ operation: 'create_sequence', actions: [{ type: 'reach' }, { type: 'grip' }, { type: 'lift' }, { type: 'sit' }] }], unsupported: [] }));
    const r = await runPromptWithModel(ctx, project(), 'grab the glass and sit', null, chatId, settings, f);
    expect(r.usedModel).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.actions).toEqual([]);
  });
});
