import type { GeneratedMotion } from '../retarget';

export interface GenerateRequest {
  prompt: string;
  seconds: number;
  seed: number;
  signal?: AbortSignal;
  onProgress?: (stage: string, completed: number, total: number) => void;
}

/** A replaceable text-to-motion backend. Every implementation must return raw model output, never canned clips. */
export interface MotionGenerator {
  id: string;
  label: string;
  generate(req: GenerateRequest): Promise<GeneratedMotion>;
  dispose?(): Promise<void>;
}
