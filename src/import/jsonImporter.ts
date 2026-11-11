import type { RigDefinition } from '../rig/rigDefinition';
import { validateMotion, type ValidationResult } from '../recording/motionFormat';

export const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** Parses untrusted text with JSON.parse only (no evaluation) and validates it against the rig. */
export function parseMotionJson(text: string, rig: RigDefinition): ValidationResult {
  if (text.length > MAX_JSON_BYTES) return { ok: false, errors: ['File is too large.'], warnings: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings: [] };
  }
  return validateMotion(data, rig);
}
