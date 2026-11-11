import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseFrame } from './landmarks';
import { RateMeter, type PoseSource, type PoseSourceStats } from './poseSource';

const BASE = import.meta.env.BASE_URL;
export const WASM_BASE = `${BASE}mediapipe/wasm`;
export const LOCAL_MODEL_URL = `${BASE}models/pose_landmarker_full.task`;
export const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

async function resolveModelUrl(): Promise<string> {
  try {
    const res = await fetch(LOCAL_MODEL_URL, { method: 'HEAD' });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && !type.includes('text/html')) return LOCAL_MODEL_URL;
  } catch {
    // fall through to CDN
  }
  return CDN_MODEL_URL;
}

let cached: Promise<{ landmarker: PoseLandmarker; delegate: 'GPU' | 'CPU' }> | null = null;

/** Creates (once) the MediaPipe Pose Landmarker; tries the GPU delegate first and falls back to CPU. */
export function createPoseLandmarker() {
  cached ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    const modelAssetPath = await resolveModelUrl();
    const make = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      return { landmarker: await make('GPU'), delegate: 'GPU' as const };
    } catch (e) {
      console.warn('GPU delegate unavailable, using CPU', e);
      return { landmarker: await make('CPU'), delegate: 'CPU' as const };
    }
  })();
  cached.catch(() => (cached = null));
  return cached;
}

/**
 * Runs pose estimation on a playing <video>. Adapts the frame stride when inference is slower than
 * the frame budget so the UI stays responsive.
 */
export class WebcamPoseSource implements PoseSource {
  readonly kind = 'webcam' as const;
  onFrame: (frame: PoseFrame | null) => void = () => {};
  private running = false;
  private handle = 0;
  private lastVideoTime = -1;
  private frameIndex = 0;
  private stride = 1;
  private inferenceEma = 0;
  private meter = new RateMeter();
  private lastTs = 0;
  delegate: 'GPU' | 'CPU' | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    readonly label: string,
  ) {}

  async start() {
    const { landmarker, delegate } = await createPoseLandmarker();
    this.delegate = delegate;
    this.running = true;
    const v = this.video;
    const hasVfc = 'requestVideoFrameCallback' in v;
    const schedule = () => {
      if (!this.running) return;
      this.handle = hasVfc ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    };
    const step = () => {
      if (!this.running) return;
      if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime && this.frameIndex++ % this.stride === 0) {
        this.lastVideoTime = v.currentTime;
        // detectForVideo requires strictly increasing timestamps.
        const ts = Math.max(performance.now(), this.lastTs + 1);
        this.lastTs = ts;
        const t0 = performance.now();
        try {
          const result = landmarker.detectForVideo(v, ts);
          const dt = performance.now() - t0;
          this.inferenceEma = this.inferenceEma ? this.inferenceEma * 0.9 + dt * 0.1 : dt;
          this.adapt();
          this.meter.tick(ts);
          const world = result.worldLandmarks[0];
          const image = result.landmarks[0];
          this.onFrame(world && image ? { timestamp: ts, world, image } : null);
        } catch (e) {
          console.error('Pose detection failed', e);
        }
      }
      schedule();
    };
    this.stopFn = () => {
      if (hasVfc) v.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
    };
    schedule();
  }

  private stopFn: () => void = () => {};

  private adapt() {
    // Keep inference within ~70% of a 30 fps budget; recover when it gets cheap again.
    if (this.inferenceEma > 24 && this.stride < 3) this.stride++;
    else if (this.inferenceEma < 12 && this.stride > 1) this.stride--;
  }

  stop() {
    this.running = false;
    this.stopFn();
  }

  stats(): PoseSourceStats {
    return { fps: this.meter.rate, inferenceMs: this.inferenceEma, frameStride: this.stride };
  }
}
