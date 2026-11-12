import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';

test('lab reports a missing WebGPU model instead of substituting motion', async ({ page }) => {
  await page.goto('/lab/text-to-motion');
  await expect(page.getByTestId('t2m-status')).toContainText('Ready', { timeout: 60_000 });
  await page.getByTestId('t2m-prompt').fill('A person hopping on one leg.');
  await page.getByTestId('t2m-generate').click();
  await expect(page.getByTestId('t2m-status')).toContainText('Generation failed (no fallback motion is substituted)', { timeout: 60_000 });
  await expect(page.getByTestId('t2m-provenance')).toHaveCount(0);
  await expect(page.getByTestId('t2m-scrub')).toHaveCount(0);
});

const fixture = 'tests/fixtures/ardy-generated.motion.json';
test('a real ARDY take imports, plays and survives JSON/GLB roundtrip', async ({ page }) => {
  test.skip(!existsSync(fixture), 'no generated fixture');
  await page.goto('/lab/text-to-motion');
  await expect(page.getByTestId('t2m-status')).toContainText('Ready', { timeout: 60_000 });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByTestId('t2m-status')).toContainText('Imported');
  await expect(page.getByTestId('t2m-provenance')).toContainText('ardy-mini-webgpu');
  await page.getByTestId('t2m-roundtrip').click();
  await expect(page.getByTestId('t2m-roundtrip-result')).toContainText('JSON ✓', { timeout: 60_000 });
  await expect(page.getByTestId('t2m-roundtrip-result')).toContainText('GLB ✓');
  const t1 = await page.evaluate(() => (window as unknown as { __t2m: { player: { time: number } } }).__t2m.player.time);
  await page.waitForTimeout(600);
  const t2 = await page.evaluate(() => (window as unknown as { __t2m: { player: { time: number } } }).__t2m.player.time);
  expect(t2).not.toBe(t1);
});
