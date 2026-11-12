import { BrowserArdyRuntime } from '../ardy/engine';
import { loadModelAssets, markModelCacheComplete } from '../ardy/model-assets';
import { matricesToQuaternions } from '../retarget';
import { core27Skeleton } from '../skeletons';
import type { GenerateRequest, MotionGenerator } from './types';

/** Immutable Hub commit of intsuc/Llama-3-ARDY-Mini-Core40-Browser (public, no token). */
export const ARDY_MODEL_REPO = 'intsuc/Llama-3-ARDY-Mini-Core40-Browser';
export const ARDY_MODEL_REVISION = '1c21362effeecec0454bfc0d818661525ae6b387';
export const ardyBaseUrl = (variant: 'fp32' | 'fp16') => `https://huggingface.co/${ARDY_MODEL_REPO}/resolve/${ARDY_MODEL_REVISION}/${variant}/`;

/** ARDY Mini Core40 running fully in the browser through ONNX Runtime Web (WebGPU execution provider). */
export class ArdyWebGpuGenerator implements MotionGenerator {
  readonly id = 'ardy-mini-webgpu';
  readonly label = 'ARDY Mini Core40 · browser WebGPU';
  private runtime: Promise<BrowserArdyRuntime> | null = null;
  loadMs = 0;
  variant: 'fp32' | 'fp16' = 'fp32';

  private async load(onProgress?: GenerateRequest['onProgress']) {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    this.variant = adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
    const t0 = performance.now();
    const report = (p: { stage: string; completed: number; total: number }) => onProgress?.(p.stage, p.completed, p.total);
    const assets = await loadModelAssets(ardyBaseUrl(this.variant), report);
    const runtime = await BrowserArdyRuntime.create(assets, { onProgress: report });
    await markModelCacheComplete(assets);
    this.loadMs = performance.now() - t0;
    return runtime;
  }

  async generate(req: GenerateRequest) {
    this.runtime ??= this.load(req.onProgress).catch((e) => {
      this.runtime = null;
      throw e;
    });
    const runtime = await this.runtime;
    const m = runtime.manifest;
    const fps = m.dimensions.fps;
    const frames = Math.max(m.generation.min_frames, Math.min(m.generation.max_frames, Math.round(req.seconds * fps)));
    const t0 = performance.now();
    const res = await runtime.generate({
      prompt: req.prompt,
      seed: req.seed,
      durationFrames: frames,
      signal: req.signal,
      onProgress: (p) => req.onProgress?.(p.stage, p.completed, p.total),
    });
    const latencyMs = performance.now() - t0;
    if (!res.globalRotations) throw new Error('ARDY decoder returned no global rotations.');
    const J = res.jointsShape[2];
    const sk = m.skeleton as unknown as { joint_names: string[]; parents: number[]; neutral_joints: [number, number, number][] };
    return {
      skeleton: core27Skeleton(sk.joint_names, sk.parents, sk.neutral_joints),
      fps,
      frameCount: res.frameCount,
      globalRotations: matricesToQuaternions(res.globalRotations, res.frameCount * J),
      positions: res.joints.slice(0, res.frameCount * J * 3),
      provenance: {
        generator: this.id,
        model: ARDY_MODEL_REPO,
        modelRevision: `${ARDY_MODEL_REVISION}/${this.variant}`,
        runtime: 'onnxruntime-web 1.27.0 (webgpu)',
        prompt: req.prompt,
        seed: res.seed,
        fps,
        frames: res.frameCount,
        latencyMs: Math.round(latencyMs),
        generatedAt: new Date().toISOString(),
        extra: { timingsMs: res.timingsMs, modelLoadMs: Math.round(this.loadMs), chunks: res.chunks, cfgWeight: m.generation.default_cfg_weight },
      },
    };
  }

  async dispose() {
    const r = await this.runtime?.catch(() => null);
    await r?.dispose();
    this.runtime = null;
  }
}
