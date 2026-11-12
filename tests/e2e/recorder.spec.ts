import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Quat = [number, number, number, number];

declare global {
  interface Window {
    // Test hook exposed by the app with ?source=synthetic (see src/App.tsx).
    __motionRecorder?: any;
  }
}


async function boneQuat(page: Page, bone: string): Promise<Quat> {
  return page.evaluate((name) => {
    const b = window.__motionRecorder!.engine.rig.bones.get(name)!;
    return [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w] as [number, number, number, number];
  }, bone);
}

const angle = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

async function startAndCalibrate(page: Page) {
  await page.goto('/?source=synthetic');
  await expect(page.getByTestId('mode')).toHaveText('Camera Disabled');
  await page.getByTestId('start-camera').click();
  await expect(page.getByTestId('mode')).toHaveText(/Tracking|Calibrating|Ready/);
  await page.getByTestId('calibrate').click();
  await expect(page.getByTestId('mode')).toHaveText('Ready', { timeout: 30_000 });
  await expect(page.getByTestId('calibration-status')).toContainText(/full body|upper body/);
}

async function record(page: Page, name: string, ms: number) {
  await page.getByTestId('animation-name').fill(name);
  const t0 = Date.now();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('mode')).toHaveText('Recording');
  await page.waitForTimeout(ms);
  await page.getByTestId('stop-recording').click();
  await expect(page.getByTestId('recording-item').filter({ hasText: name })).toBeVisible();
  return (Date.now() - t0) / 1000;
}

test('live tracking drives the mannequin, records, plays back, and exports/imports JSON + GLB', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await startAndCalibrate(page);

  // Live retargeting moves the arm away from the rest pose.
  const restArm = await page.evaluate(() => {
    const e = window.__motionRecorder!.engine;
    const q = e.retargeter.restLocalRotation('DEF-upper_arm.L');
    return [q.x, q.y, q.z, q.w] as [number, number, number, number];
  });
  await page.waitForTimeout(500);
  expect(angle(await boneQuat(page, 'DEF-upper_arm.L'), restArm)).toBeGreaterThan(0.05);

  const elapsed = await record(page, 'E2E Take', 2500);
  const duration = Number((await page.getByTestId('duration').textContent())?.replace(/[^\d.:]/g, '').split(':').reduce((a, b) => a * 60 + Number(b), 0));
  // Duration follows the real Record→Stop interval (clicks can lag on slow CI runners).
  expect(duration).toBeGreaterThan(2.2);
  expect(duration).toBeLessThanOrEqual(elapsed + 0.2);

  // Playback: live tracking must not drive the bones; scrubbing is deterministic.
  await page.getByTestId('play').click();
  await expect(page.getByTestId('mode')).toHaveText('Playback');
  await page.getByTestId('pause').click();
  await page.evaluate(() => window.__motionRecorder!.engine.seek(1.0));
  await page.waitForTimeout(300);
  const at1a = await boneQuat(page, 'DEF-forearm.L');
  await page.waitForTimeout(500);
  const at1b = await boneQuat(page, 'DEF-forearm.L');
  expect(angle(at1a, at1b)).toBeLessThan(1e-6);
  await page.evaluate(() => window.__motionRecorder!.engine.seek(1.0));
  await page.waitForTimeout(100);
  expect(angle(await boneQuat(page, 'DEF-forearm.L'), at1a)).toBeLessThan(1e-6);

  // JSON export
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  const jsonPath = info.outputPath('take.motion.json');
  await jsonDl.saveAs(jsonPath);
  const motion = JSON.parse(await readFile(jsonPath, 'utf8'));
  expect(motion.format).toBe('motion-recorder');
  expect(motion.version).toBe(1);
  expect(motion.name).toBe('E2E Take');
  expect(motion.tracks.length).toBeGreaterThan(10);

  // GLB export (engine re-imports it before offering the download)
  const [glbDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-glb').click()]);
  const glbPath = info.outputPath('take.glb');
  await glbDl.saveAs(glbPath);
  const glb = await readFile(glbPath);
  expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');

  // Delete the original, then import both files as fresh recordings.
  await page.getByTestId('back-to-live').click();
  const item = page.getByTestId('recording-item').filter({ hasText: 'E2E Take' });
  page.once('dialog', (d) => void d.accept());
  await item.getByTestId('delete-recording').click();
  await expect(page.getByTestId('recording-item')).toHaveCount(0);

  await page.getByTestId('import-input').setInputFiles(jsonPath);
  await expect(page.getByTestId('recording-item')).toHaveCount(1);
  await page.getByTestId('import-input').setInputFiles(glbPath);
  await expect(page.getByTestId('recording-item')).toHaveCount(2);

  // Both imports replay to the same pose as the original at t = 1 s.
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('recording-item').nth(i).click();
    await page.getByTestId('play').click();
    await page.getByTestId('pause').click();
    await page.evaluate(() => window.__motionRecorder!.engine.seek(1.0));
    await page.waitForTimeout(150);
    expect(angle(await boneQuat(page, 'DEF-forearm.L'), at1a)).toBeLessThan(0.01);
  }

  // Importing during playback leaves playback, so the new take (not the old one) plays next.
  await page.getByTestId('play').click();
  await expect(page.getByTestId('mode')).toHaveText('Playback');
  await page.getByTestId('import-input').setInputFiles(jsonPath);
  await expect(page.getByTestId('recording-item')).toHaveCount(3);
  await expect(page.getByTestId('mode')).not.toHaveText('Playback');
  await expect(page.getByTestId('recording-item').nth(2)).toHaveClass(/selected/);
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('recording-item').nth(2).getByTestId('delete-recording').click();
  await expect(page.getByTestId('recording-item')).toHaveCount(2);

  // Recordings survive a reload (IndexedDB). Wait until the delete has been committed before reloading.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const req = indexedDB.open('motion-recorder');
            req.onsuccess = () => {
              const c = req.result.transaction('recordings').objectStore('recordings').count();
              c.onsuccess = () => {
                resolve(c.result);
                req.result.close();
              };
            };
          }),
      ),
    )
    .toBe(2);
  await page.reload();
  await expect(page.getByTestId('recording-item')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('final.png') });
  expect(errors).toEqual([]);
});

test('rejects invalid and incompatible motion files', async ({ page }, info) => {
  await page.goto('/?source=synthetic');
  await expect(page.getByTestId('import')).toBeEnabled();
  const bad = info.outputPath('bad.json');
  await (await import('node:fs/promises')).writeFile(bad, '{"format":"something-else"}');
  await page.getByTestId('import-input').setInputFiles(bad);
  await expect(page.getByTestId('toast-error')).toBeVisible();
  await expect(page.getByTestId('recording-item')).toHaveCount(0);

  const wrongRig = info.outputPath('wrong-rig.json');
  await (await import('node:fs/promises')).writeFile(
    wrongRig,
    JSON.stringify({ format: 'motion-recorder', version: 1, name: 'x', duration: 1, fps: 30, rig: { id: 'other-rig' }, tracks: [] }),
  );
  await page.getByTestId('import-input').setInputFiles(wrongRig);
  await expect(page.getByTestId('toast-error').last()).toContainText(/rig/i);
  await expect(page.getByTestId('recording-item')).toHaveCount(0);
});

test('record is disabled until calibrated', async ({ page }) => {
  await page.goto('/?source=synthetic');
  await expect(page.getByTestId('record')).toBeDisabled();
  await page.getByTestId('start-camera').click();
  await expect(page.getByTestId('mode')).toHaveText(/Tracking|Calibrating/);
  await expect(page.getByTestId('record')).toBeDisabled();
});
