import { createStore, del, entries, set } from 'idb-keyval';
import { validateMotion, type MotionData } from '../recording/motionFormat';
import type { RigDefinition } from '../rig/rigDefinition';

export interface StoredRecording {
  id: string;
  motion: MotionData;
}

const store = typeof indexedDB !== 'undefined' ? createStore('motion-recorder', 'recordings') : undefined;

/** Recordings persist in IndexedDB so they survive reloads; they are re-validated on load. */
export async function loadRecordings(rig: RigDefinition): Promise<StoredRecording[]> {
  if (!store) return [];
  const all = await entries<string, MotionData>(store);
  const out: StoredRecording[] = [];
  for (const [id, data] of all) {
    const v = validateMotion(data, rig);
    if (v.ok) out.push({ id, motion: v.motion });
  }
  return out.sort((a, b) => a.motion.createdAt.localeCompare(b.motion.createdAt));
}

export async function saveRecording(rec: StoredRecording) {
  if (store) await set(rec.id, rec.motion, store);
}

export async function deleteRecording(id: string) {
  if (store) await del(id, store);
}
