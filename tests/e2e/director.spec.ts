import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

declare global {
  interface Window {
    __director?: { store: { getState: () => any; setState: (s: object) => void } };
    __marker?: number;
  }
}

const FULL = 'Walk to the table, pick up the glass, look around nervously and put it back on the table.';

interface DirState {
  actions: { id: string; type: string }[];
  duration: number;
  chat: string[];
}

const state = (page: Page): Promise<DirState> =>
  page.evaluate(() => {
    const s = window.__director!.store.getState();
    return { actions: s.project.actions.map((a: any) => ({ id: a.id, type: a.type })), duration: s.perf?.duration ?? 0, chat: s.project.chat.map((c: any) => c.text) };
  });

async function direct(page: Page, text: string) {
  const before = (await state(page)).chat.length;
  await page.getByTestId('director-input').fill(text);
  await page.getByTestId('director-send').click();
  await expect.poll(async () => (await state(page)).chat.length).toBe(before + 2);
}

async function seek(page: Page, t: number) {
  await page.evaluate((time) => window.__director!.store.setState({ playing: false, time }), t);
}

test('switch to Director, direct an object interaction, edit, export and return', async ({ page }) => {
  await page.goto('/?source=synthetic');
  await expect(page).toHaveURL(/\/recorder\?source=synthetic/);
  await expect(page.getByTestId('mode')).toBeVisible();
  await page.evaluate(() => (window.__marker = 42));
  await page.getByTestId('open-director').click();
  await expect(page).toHaveURL(/\/director/);
  await expect(page.getByTestId('director-stage')).toBeVisible();
  expect(await page.evaluate(() => window.__marker)).toBe(42); // client-side navigation, no reload
  expect(await page.evaluate(() => (window as any).__motionRecorder)).toBeUndefined(); // recorder engine (and camera) released
  for (const id of ['actor', 'table', 'glass', 'ground', 'camera']) await expect(page.getByTestId(`object-${id}`)).toBeVisible();

  await direct(page, FULL);
  const first = await state(page);
  expect(first.actions.map((a) => a.type)).toEqual(['walk_to', 'reach', 'grip', 'lift', 'look_around', 'place', 'release']);
  await expect(page.getByTestId('chat-director').last()).toContainText('New sequence');
  await expect(page.getByTestId('lane-glass').locator('.ds-clip')).toHaveCount(1);

  // Glass states over time (deterministic seek).
  const glassAt = async (t: number) => (await seek(page, t), await page.getByTestId('glass-state-live').innerText());
  expect(await glassAt(0.1)).toBe('on table');
  const ev = await page.evaluate(() => window.__director!.store.getState().perf.events.map((e: any) => e.time));
  expect(await glassAt(ev[0] + 0.3)).toBe('held right');
  expect(await glassAt(first.duration)).toBe('released');

  await page.getByTestId('director-play').click();
  await expect.poll(async () => page.evaluate(() => window.__director!.store.getState().time), { timeout: 10000 }).toBeGreaterThan(0.5);
  await page.getByTestId('director-play').click();

  // Follow-up edit keeps existing actions.
  await direct(page, 'Look around before putting down the glass.');
  const edited = await state(page);
  expect(edited.actions.filter((a) => a.type === 'look_around')).toHaveLength(2);
  for (const a of first.actions) expect(edited.actions.map((x) => x.id)).toContain(a.id);
  expect(edited.duration).toBeGreaterThan(first.duration);

  await page.getByTestId('undo').click();
  expect((await state(page)).actions).toEqual(first.actions);
  await page.getByTestId('redo').click();
  expect((await state(page)).actions).toEqual(edited.actions);

  // Timeline editing: select the first look_around and delete it.
  const lookId = edited.actions.find((a) => a.type === 'look_around')!.id;
  await page.getByTestId(`clip-${lookId}-head`).click();
  await expect(page.getByTestId('action-inspector')).toBeVisible();
  await page.getByTestId('delete-action').click();
  expect((await state(page)).actions.map((a) => a.id)).not.toContain(lookId);

  // Project save -> open.
  const [projDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-project').click()]);
  expect(projDl.suggestedFilename()).toMatch(/\.director\.json$/);
  const projPath = await projDl.path();
  const saved = JSON.parse(readFileSync(projPath, 'utf8'));
  expect(saved.format).toBe('director-project');
  await direct(page, 'Do it more slowly.');
  await page.getByTestId('open-project-input').setInputFiles(projPath);
  await expect.poll(async () => (await state(page)).actions.map((a) => a.id)).toEqual(saved.actions.map((a: any) => a.id));

  // Exports.
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-motion-json').click()]);
  const motion = JSON.parse(readFileSync(await jsonDl.path(), 'utf8'));
  expect(motion.format).toBe('motion-recorder');
  expect(motion.meta.source).toBe('director');
  const [glbDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('export-actor-glb').click()]);
  expect(glbDl.suggestedFilename()).toMatch(/\.glb$/);
  const [sceneDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTestId('export-scene-glb').click()]);
  expect(sceneDl.suggestedFilename()).toMatch(/\.scene\.glb$/);

  // Send to MotionRecorder: the take appears there and plays.
  await page.getByTestId('send-to-recorder').click();
  await expect(page).toHaveURL(/\/recorder/);
  await expect.poll(async () => page.evaluate(() => (window as any).__motionRecorder?.store.getState().recordings.map((r: any) => r.motion?.name ?? r.name) ?? []), { timeout: 20000 }).toContainEqual(
    expect.stringMatching(/^Director:/),
  );

  // Back to the Director: the project is restored.
  await page.getByTestId('open-director').click();
  await expect.poll(async () => page.evaluate(() => window.__director?.store.getState().project.actions.length ?? 0)).toBe(saved.actions.length);
});

test('unsupported instructions change nothing and are reported', async ({ page }) => {
  await page.goto('/director?source=synthetic');
  await expect(page.getByTestId('director-stage')).toBeVisible();
  await direct(page, 'Do a backflip.');
  expect((await state(page)).actions).toEqual([]);
  await expect(page.getByTestId('chat-director').last()).toContainText('Not supported');
  await direct(page, 'Put the glass down.');
  // Placing a glass that is not held: the planner inserts walk/reach/grip first.
  expect((await state(page)).actions.map((a) => a.type)).toEqual(['walk_to', 'reach', 'grip', 'place', 'release']);
});

test('conversational timing edits retime the action and are undoable and persisted', async ({ page }) => {
  await page.goto('/director?source=synthetic');
  await expect(page.getByTestId('director-stage')).toBeVisible();
  await direct(page, 'Walk to the table.');
  const short = (await state(page)).duration;
  expect(short).toBeLessThan(5);
  await direct(page, 'Take at least 8 seconds to complete the movement.');
  await expect(page.getByTestId('chat-director').last()).not.toContainText(/not supported/i);
  const long = await state(page);
  expect(long.duration).toBeGreaterThanOrEqual(7.99);
  expect(long.actions.map((a) => a.type)).toEqual(['walk_to']);
  await direct(page, 'Take at least 8 seconds.');
  await expect(page.getByTestId('chat-director').last()).toContainText('No change');
  expect((await state(page)).duration).toBeCloseTo(long.duration, 3);
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await state(page)).duration).toBeCloseTo(short, 3);
  await page.getByTestId('redo').click();
  await expect.poll(async () => (await state(page)).duration).toBeCloseTo(long.duration, 3);
  await page.waitForTimeout(800); // autosave debounce
  await page.reload();
  await expect.poll(async () => page.evaluate(() => window.__director?.store.getState().perf?.duration ?? 0), { timeout: 15000 }).toBeCloseTo(long.duration, 3);
});
