import { Quaternion, Vector3 } from 'three';
import type { BodyFrame } from '../tracking/landmarks';

/** One Euro filter (Casiez et al. 2012): low lag on fast motion, strong smoothing when still. */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.6,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dt: number): number {
    if (this.x === null || !(dt > 0)) {
      this.x = value;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export interface LandmarkFilterOptions {
  minCutoff: number;
  beta: number;
  /** Landmarks below this visibility do not update the filter (their previous estimate is kept). */
  minVisibility: number;
}

/** Filters all landmark coordinates of a body frame; low-confidence landmarks keep their last estimate. */
export class LandmarkFilter {
  private filters: OneEuroFilter[][] = [];
  private last: Vector3[] = [];
  private lastTime: number | null = null;
  constructor(private options: LandmarkFilterOptions = { minCutoff: 1.2, beta: 0.6, minVisibility: 0.5 }) {}

  reset() {
    this.filters = [];
    this.last = [];
    this.lastTime = null;
  }

  apply(frame: BodyFrame): BodyFrame {
    const dt = this.lastTime === null ? 0 : Math.max(1e-3, (frame.timestamp - this.lastTime) / 1000);
    this.lastTime = frame.timestamp;
    const points = frame.points.map((p, i) => {
      const fs = (this.filters[i] ??= [0, 1, 2].map(() => new OneEuroFilter(this.options.minCutoff, this.options.beta)));
      const visible = (frame.visibility[i] ?? 0) >= this.options.minVisibility;
      if (!visible && this.last[i]) return this.last[i].clone();
      const out = new Vector3(fs[0].filter(p.x, dt), fs[1].filter(p.y, dt), fs[2].filter(p.z, dt));
      this.last[i] = out;
      return out.clone();
    });
    return { timestamp: frame.timestamp, points, visibility: frame.visibility.slice() };
  }
}

/** Exponential slerp smoothing of per-bone rotations (frame-rate independent). */
export class QuaternionSmoother {
  private state = new Map<string, Quaternion>();
  constructor(public tau = 0.045) {}

  reset() {
    this.state.clear();
  }

  apply(rotations: Map<string, Quaternion>, dt: number): Map<string, Quaternion> {
    const a = this.tau <= 0 ? 1 : 1 - Math.exp(-Math.max(dt, 0) / this.tau);
    const out = new Map<string, Quaternion>();
    for (const [name, q] of rotations) {
      const prev = this.state.get(name);
      const next = prev ? prev.slerp(q, a) : q.clone();
      this.state.set(name, next.normalize());
      out.set(name, next.clone());
    }
    return out;
  }
}
