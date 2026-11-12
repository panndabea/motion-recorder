import { expect, test } from '@playwright/test';

const CONCEPTS = [
  ['inverse-kinematics', 'Inverse Kinematics'],
  ['foot-locking', 'Foot Locking / Foot IK'],
  ['motion-warping', 'Motion Warping'],
  ['animation-layers', 'Animation Layers & Blending'],
  ['gaze', 'Look-at / Gaze Controller'],
  ['motion-matching', 'Motion Matching'],
  ['secondary-motion', 'Procedural Secondary Motion'],
  ['object-interaction', 'Object Interaction & Constraints'],
  ['retiming', 'Animation Retiming / Time Warping'],
] as const;

test('gaming lab: navigation, all nine experiments load and switch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('open-gaming-lab').click();
  await expect(page).toHaveURL(/\/gaming-lab/);
  await expect(page.getByTestId('gaming-lab')).toBeVisible();
  for (const [id, title] of CONCEPTS) {
    const btn = page.getByTestId(`concept-${id}`);
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(page.getByTestId('experiment-title')).toHaveText(title);
    await expect(page.getByTestId('concept-explanation')).toContainText('What is it?');
    await expect(page.getByTestId('concept-explanation')).not.toContainText('No explanation available');
    await expect(page.getByTestId('readouts')).not.toBeEmpty();
  }
  expect(errors).toEqual([]);
});

test('gaming lab: controls update the model, transport, split-screen, reset, bake', async ({ page }) => {
  await page.goto('/gaming-lab');
  await page.getByTestId('concept-inverse-kinematics').click();
  const readouts = page.getByTestId('readouts');
  // the idle clip keeps playing, so only compare the parameter-driven readouts
  await expect(readouts).toContainText(/Reachable\s*yes/);
  await page.getByTestId('preset-Unreachable target').click();
  await expect(readouts).toContainText(/Reachable\s*no/);
  await page.getByTestId('reset-params').click();
  await expect(readouts).toContainText(/Reachable\s*yes/);
  await expect(readouts).toContainText(/Hand → target error\s*0\.\d cm/);

  await page.getByTestId('concept-foot-locking').click();
  await page.getByTestId('play-toggle').click(); // pause
  const time = page.getByTestId('time');
  const t0 = await time.innerText();
  await page.getByTestId('step-forward').click();
  await page.getByTestId('step-forward').click();
  await expect.poll(() => time.innerText()).not.toBe(t0);
  await page.getByTestId('rewind').click();
  await expect(time).toContainText(/^0\.00/);

  const split = page.getByTestId('split-toggle');
  if (!(await split.isChecked())) await split.check();
  await expect(page.getByText('Technique OFF (baseline)')).toBeVisible();
  await expect(page.getByText('Technique ON')).toBeVisible();
  await split.uncheck();
  await expect(page.getByText('Technique OFF (baseline)')).toHaveCount(0);

  const enabled = page.getByTestId('ctl-enabled');
  const slideOn = await readouts.innerText();
  await enabled.uncheck();
  await expect.poll(() => readouts.innerText()).not.toBe(slideOn);
  await enabled.check();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('bake-json').click()]);
  const path = await download.path();
  const fs = await import('node:fs');
  const text = fs.readFileSync(path!, 'utf8');
  const json = JSON.parse(text);
  expect(json).toBeTruthy();
  expect(text).toContain('DEF-thigh.L');
});

test('gaming lab: baked motion plays in MotionRecorder', async ({ page }) => {
  await page.goto('/gaming-lab');
  await page.getByTestId('concept-gaze').click();
  await page.getByTestId('bake-recorder').click();
  await expect(page.getByTestId('bake-notice')).toBeVisible();
  await page.getByTestId('lab-to-recorder').click();
  await expect(page).toHaveURL(/\/recorder/);
  await expect(page.getByTestId('recording-item').first()).toBeVisible();
});
