import type { PoseFrame } from './landmarks';

export type PoseSourceKind = 'webcam' | 'synthetic';

export interface PoseSourceStats {
  /** Pose estimations per second. */
  fps: number;
  /** Average inference time (ms). */
  inferenceMs: number;
  /** 1 = every video frame is processed, 2 = every second frame, ... */
  frameStride: number;
}

/** Anything that produces pose frames. `null` means "no person detected". */
export interface PoseSource {
  readonly kind: PoseSourceKind;
  readonly label: string;
  onFrame: (frame: PoseFrame | null) => void;
  start(): Promise<void>;
  stop(): void;
  stats(): PoseSourceStats;
  /** Synthetic sources: jump back to the start of the sequence (its neutral standing pose). */
  rewind?(): void;
}

export class RateMeter {
  private times: number[] = [];
  tick(now: number) {
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 1000) this.times.shift();
  }
  get rate() {
    return this.times.length;
  }
}
