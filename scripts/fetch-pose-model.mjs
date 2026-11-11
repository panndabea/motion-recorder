// Optional: downloads the MediaPipe pose model into public/models so the app works offline.
// Without it the app loads the model from Google's CDN at runtime (camera frames are never uploaded).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'pose_landmarker_full.task');
const res = await fetch(URL_);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${dest}`);
