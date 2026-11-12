/**
 * Runs prompts against a real local model. Skipped unless DIRECTOR_LLM_URL is set, e.g.
 * DIRECTOR_LLM_URL=http://localhost:11434/v1 DIRECTOR_LLM_MODEL=qwen2.5:3b npx vitest run tests/unit/directorLlm.live.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMannequin } from '../../src/rig/mannequinLoader';
import { runPromptWithModel } from '../../src/director/ai/directorSession';
import { DEFAULT_LLM_SETTINGS } from '../../src/director/ai/llmInterpreter';
import { ComposerContext, composePerformance } from '../../src/director/animation/motionComposer';
import type { DirectorProject } from '../../src/director/persistence/directorProject';
import { defaultScene } from '../../src/director/scene/sceneModel';

const url = process.env.DIRECTOR_LLM_URL;
const settings = { ...DEFAULT_LLM_SETTINGS, enabled: true, baseUrl: url ?? '', model: process.env.DIRECTOR_LLM_MODEL ?? DEFAULT_LLM_SETTINGS.model, timeoutMs: 240000 };
const label = (p: Pick<DirectorProject, 'actions'>) => p.actions.map((a) => `${a.type}${a.target ? `(${a.target})` : a.direction ? `(${a.direction})` : ''}${a.auto ? '*' : ''}`);

describe.skipIf(!url)('live local model', () => {
  it('turns free-form prompts into valid performances', { timeout: 1_200_000 }, async () => {
    const buf = readFileSync('public/models/mannequin.glb');
    const ctx = new ComposerContext(await parseMannequin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
    const scene = defaultScene();
    let n = 0;
    const chatId = () => `c${++n}`;
    const conversations = [
      ['walk to the table, just sit down, then walk back. then walk again to the table. pick up the glass. then look left and put down the glass'],
      ['Schlendere gemütlich zum Tisch, setz dich kurz hin und komm dann wieder zurück.'],
      ['Grab the glass, have a quick look to the right and set it back down carefully.', 'Make that take at least 8 seconds.'],
    ];
    for (const turns of conversations) {
      let project: Pick<DirectorProject, 'actions' | 'chat' | 'scene' | 'nextId'> = { actions: [], chat: [], scene, nextId: 1 };
      for (const text of turns) {
        const t0 = Date.now();
        const r = await runPromptWithModel(ctx, project, text, null, chatId, settings);
        project = { ...project, actions: r.actions, nextId: r.nextId, chat: [...project.chat, ...r.entries] };
        const perf = composePerformance(ctx, scene, r.actions);
        console.log(`\n> ${text}\n  ${((Date.now() - t0) / 1000).toFixed(1)} s, model=${r.usedModel}, ok=${r.ok}\n  ${r.reply}\n  ${label(project).join(' → ')}  [${perf.duration.toFixed(1)} s]`);
        expect(r.ok).toBe(true);
        expect(perf.issues).toEqual([]);
      }
    }
  });
});
