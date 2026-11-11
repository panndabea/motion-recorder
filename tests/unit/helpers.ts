import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMannequin, type MannequinRig } from '../../src/rig/mannequinLoader';

export const MANNEQUIN_PATH = join(__dirname, '../../public/models/mannequin.glb');

export function mannequinBytes(): ArrayBuffer {
  const buf = readFileSync(MANNEQUIN_PATH);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function loadRig(): Promise<MannequinRig> {
  return parseMannequin(mannequinBytes());
}
