import type { PoseFrame, RawLandmark } from '../landmarks';
import { RateMeter, type PoseSource, type PoseSourceStats } from '../poseSource';

export interface SyntheticSequence {
  fps: number;
  description: string;
  segments: Array<{ clip: string; start: number; duration: number }>;
  /** frames[i][landmark] = [x, y, z, visibility] in MediaPipe world space (metres, hip-centred). */
  frames: number[][][];
}

/** Orthographic "camera" for the overlay: 2.4 m tall 4:3 view centred 1.2 m above the floor, hips at 0.95 m. */
export function worldToImage(world: RawLandmark[]): RawLandmark[] {
  return world.map((p) => ({ x: 0.5 + p.x / 3.2, y: 0.5 + (p.y + 0.25) / 2.4, z: p.z, visibility: p.visibility }));
}

/**
 * Replays a prerecorded synthetic landmark sequence in real time, standing in for the webcam +
 * MediaPipe pipeline in automated tests and demos (`?source=synthetic`).
 */
export class SyntheticPoseSource implements PoseSource {
  readonly kind = 'synthetic' as const;
  readonly label = 'Synthetic pose sequence';
  onFrame: (frame: PoseFrame | null) => void = () => {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private meter = new RateMeter();
  private t0 = 0;
  private sequence: SyntheticSequence | null = null;
  private holding = false;

  constructor(private readonly load: () => Promise<SyntheticSequence> = loadDefaultSequence) {}

  async start() {
    this.sequence = await this.load();
    const seq = this.sequence;
    this.t0 = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const idx = this.holding ? 0 : Math.floor(((now - this.t0) / 1000) * seq.fps) % seq.frames.length;
      const world = seq.frames[idx].map(([x, y, z, visibility]) => ({ x, y, z, visibility }));
      this.meter.tick(now);
      this.onFrame({ timestamp: now, world, image: worldToImage(world) });
    }, 1000 / seq.fps);
  }

  holdNeutral(on: boolean) {
    if (this.holding && !on) this.t0 = performance.now();
    this.holding = on;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats(): PoseSourceStats {
    return { fps: this.meter.rate, inferenceMs: 0, frameStride: 1 };
  }
}

export async function loadDefaultSequence(): Promise<SyntheticSequence> {
  const mod = await import('./sequence.json');
  return mod.default as SyntheticSequence;
}
