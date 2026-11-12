import { readFileSync } from 'node:fs';
import { LabActor } from '../../../src/gaming-lab/engine/labActor';

export async function loadActor() {
  const buf = readFileSync('public/models/mannequin.glb');
  return LabActor.create(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}
