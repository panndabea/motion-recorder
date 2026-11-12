/** Deterministic integer hash -> [0, 1). */
export function hash01(seed: number, i: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [-1, 1] (C¹ continuous, quintic fade). `channel` decorrelates streams. */
export function smoothNoise(seed: number, channel: number, x: number) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const s = seed * 131 + channel * 7919;
  const a = hash01(s, i) * 2 - 1;
  const b = hash01(s, i + 1) * 2 - 1;
  return a + (b - a) * u;
}

/** Fractal (2 octave) smooth noise, still bounded by [-1, 1]. */
export function fbm(seed: number, channel: number, x: number) {
  return (smoothNoise(seed, channel, x) * 2 + smoothNoise(seed, channel + 101, x * 2.13)) / 3;
}

/**
 * Damped spring x'' = k(target − x) − c·x', integrated deterministically from t = 0 at a fixed step.
 * Returns the position at time t for a target signal.
 */
export function springAt(target: (t: number) => number, t: number, stiffness: number, damping: number, dt = 1 / 120) {
  let x = target(0);
  let v = 0;
  const n = Math.floor(t / dt);
  for (let i = 0; i < n; i++) {
    const a = stiffness * (target(i * dt) - x) - damping * v;
    v += a * dt;
    x += v * dt;
  }
  return x;
}
