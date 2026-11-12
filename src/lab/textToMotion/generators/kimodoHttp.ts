import type { GeneratedMotion } from '../retarget';
import { SOMA_MAPPING } from '../skeletons';
import type { GenerateRequest, MotionGenerator } from './types';

/**
 * Wire format of a self-hosted Kimodo backend (see experiments/kimodo-server). The server owns any model
 * credentials; the browser only sends the prompt and receives raw generated joints.
 */
export interface KimodoResponse {
  model: string;
  modelRevision?: string;
  runtime: string;
  fps: number;
  jointNames: string[];
  parents: number[];
  restPositions: [number, number, number][];
  /** frames × joints × [x, y, z, w], global rotations relative to restPositions. */
  globalRotations: number[];
  /** frames × joints × 3, metres, y-up, floor at 0. */
  positions: number[];
  seed: number;
  latencyMs: number;
  extra?: Record<string, unknown>;
}

export class KimodoHttpGenerator implements MotionGenerator {
  readonly id = 'kimodo-http';
  readonly label = 'Kimodo · self-hosted backend';
  constructor(public baseUrl: string) {}

  async generate(req: GenerateRequest): Promise<GeneratedMotion> {
    req.onProgress?.('requesting', 0, 1);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: req.prompt, seconds: req.seconds, seed: req.seed }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`Kimodo backend: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const d = (await res.json()) as KimodoResponse;
    const J = d.jointNames.length;
    const frames = d.positions.length / (J * 3);
    if (!Number.isInteger(frames) || d.globalRotations.length !== frames * J * 4) throw new Error('Kimodo backend returned inconsistent array sizes.');
    req.onProgress?.('requesting', 1, 1);
    return {
      skeleton: { id: 'soma30', jointNames: d.jointNames, parents: d.parents, restPositions: d.restPositions, mapping: SOMA_MAPPING, hipsJoint: 'Hips', noAlign: ['LeftShoulder', 'RightShoulder'] },
      fps: d.fps,
      frameCount: frames,
      globalRotations: Float32Array.from(d.globalRotations),
      positions: Float32Array.from(d.positions),
      provenance: {
        generator: this.id, model: d.model, modelRevision: d.modelRevision, runtime: d.runtime, prompt: req.prompt, seed: d.seed,
        fps: d.fps, frames, latencyMs: d.latencyMs, generatedAt: new Date().toISOString(), extra: { ...d.extra, backend: this.baseUrl },
      },
    };
  }
}
