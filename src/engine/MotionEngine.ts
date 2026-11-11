import { Quaternion, Vector3 } from 'three';
import { applyPose, resetToRest, type MannequinRig } from '../rig/mannequinLoader';
import { Retargeter, identityCalibration, type CalibrationData } from '../rig/retargeting';
import { LandmarkFilter, QuaternionSmoother } from '../rig/poseFiltering';
import { DRIVEN_BONES, ROOT_MOTION_BONE } from '../rig/rigSpec';
import type { LocalPose } from '../rig/rigDefinition';
import { Calibrator, serializeCalibration } from '../tracking/calibration';
import { mediaPipeToBody, type BodyFrame, type PoseFrame } from '../tracking/landmarks';
import type { PoseSource } from '../tracking/poseSource';
import { listCameras, openCamera, stopStream } from '../tracking/camera';
import { WebcamPoseSource } from '../tracking/poseLandmarker';
import { SyntheticPoseSource } from '../tracking/synthetic/syntheticSource';
import { MotionRecorder } from '../recording/motionRecorder';
import { MotionPlayer, sampleMotion } from '../recording/motionPlayback';
import type { MotionData } from '../recording/motionFormat';
import { exportMotionGlb } from '../export/glbExporter';
import { motionFileName, serializeMotion } from '../export/jsonExporter';
import { parseMotionJson } from '../import/jsonImporter';
import { importMotionGlb } from '../import/glbImporter';
import { deleteRecording, loadRecordings, saveRecording, type StoredRecording } from '../storage/recordingStore';
import { downloadBlob, safeFileName } from '../util/download';
import { toast, useStore, type AppMode } from '../state/store';

const set = useStore.setState;
const get = useStore.getState;

const newId = () => `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Orchestrates capture -> retargeting -> recording -> playback outside React.
 * `update()` runs once per rendered frame (from the viewport) and is the only place bones are written.
 */
export class MotionEngine {
  readonly rig: MannequinRig;
  readonly retargeter: Retargeter;
  private readonly landmarkFilter = new LandmarkFilter();
  private readonly smoother = new QuaternionSmoother();
  private readonly calibrator: Calibrator;
  private calibration: CalibrationData = identityCalibration();
  private readonly recorder = new MotionRecorder(DRIVEN_BONES, [ROOT_MOTION_BONE]);
  private readonly player: MotionPlayer;
  private source: PoseSource | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private pendingFrame: PoseFrame | null | undefined = undefined;
  private lastBody: BodyFrame | null = null;
  private lastSolveTime = 0;
  private target: LocalPose | null = null;
  private lastStatsAt = 0;
  private lastUiAt = 0;
  private takeCounter = 1;
  /** Listeners for raw frames (webcam overlay). */
  private frameListeners = new Set<(frame: PoseFrame | null) => void>();

  constructor(rig: MannequinRig, readonly synthetic = false) {
    this.rig = rig;
    this.retargeter = new Retargeter(rig.definition);
    this.calibrator = new Calibrator(rig.definition);
    this.player = new MotionPlayer(rig);
    set({ sourceKind: synthetic ? 'synthetic' : 'webcam' });
  }

  // ---------- recordings ----------

  async init() {
    try {
      const recordings = await loadRecordings(this.rig.definition);
      this.takeCounter = recordings.length + 1;
      set({ recordings, selectedId: recordings.at(-1)?.id ?? null, newRecordingName: `Take ${this.takeCounter}` });
    } catch (e) {
      console.warn('Could not load stored recordings', e);
    }
    if (!this.synthetic) this.refreshCameras();
  }

  get selected(): StoredRecording | undefined {
    const { recordings, selectedId } = get();
    return recordings.find((r) => r.id === selectedId);
  }

  private async addRecording(motion: MotionData) {
    const rec = { id: newId(), motion };
    set((s) => ({ recordings: [...s.recordings, rec], selectedId: rec.id }));
    try {
      await saveRecording(rec);
    } catch (e) {
      toast('warning', `Recording kept in memory only (storage failed: ${(e as Error).message})`);
    }
    return rec;
  }

  select(id: string) {
    if (get().mode === 'playback') this.stopPlayback();
    set({ selectedId: id });
  }

  async rename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const rec = get().recordings.find((r) => r.id === id);
    if (!rec) return;
    const updated = { id, motion: { ...rec.motion, name: trimmed } };
    set((s) => ({ recordings: s.recordings.map((r) => (r.id === id ? updated : r)) }));
    await saveRecording(updated).catch(() => {});
  }

  async remove(id: string) {
    if (get().selectedId === id && get().mode === 'playback') this.stopPlayback();
    set((s) => {
      const recordings = s.recordings.filter((r) => r.id !== id);
      return { recordings, selectedId: s.selectedId === id ? (recordings.at(-1)?.id ?? null) : s.selectedId };
    });
    await deleteRecording(id).catch(() => {});
  }

  // ---------- camera / tracking ----------

  async refreshCameras() {
    try {
      const cameras = await listCameras();
      set((s) => ({ cameras, selectedCamera: s.selectedCamera ?? cameras[0]?.deviceId ?? null }));
    } catch {
      // enumerateDevices may be unavailable; selection just stays empty.
    }
  }

  onPoseFrame(listener: (frame: PoseFrame | null) => void) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async startCamera(video: HTMLVideoElement | null, deviceId?: string | null) {
    if (get().camera === 'starting') return;
    this.stopCamera(false);
    this.video = video;
    set({ camera: 'starting', cameraMessage: this.synthetic ? 'Starting synthetic pose source…' : 'Opening camera…' });
    try {
      let source: PoseSource;
      if (this.synthetic) {
        source = new SyntheticPoseSource();
      } else {
        if (!video) throw new Error('Video element not ready');
        this.stream = await openCamera(deviceId ?? undefined);
        video.srcObject = this.stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        await this.refreshCameras();
        const settings = this.stream.getVideoTracks()[0]?.getSettings();
        if (settings?.deviceId) set({ selectedCamera: settings.deviceId });
        set({ cameraMessage: 'Loading pose model…' });
        source = new WebcamPoseSource(video, this.stream.getVideoTracks()[0]?.label ?? 'Webcam');
      }
      source.onFrame = (frame) => {
        this.pendingFrame = frame;
        for (const l of this.frameListeners) l(frame);
      };
      await source.start();
      this.source = source;
      this.resetLive();
      set({
        camera: 'on',
        cameraMessage: null,
        tracking: { ...get().tracking, delegate: source instanceof WebcamPoseSource ? source.delegate : 'synthetic' },
      });
      if (get().mode !== 'playback') this.setMode(this.liveMode());
      if (!get().calibration.calibrated) toast('info', 'Stand in front of the camera and press Calibrate.');
    } catch (e) {
      stopStream(this.stream);
      this.stream = null;
      const message = (e as Error).message || String(e);
      set({ camera: 'error', cameraMessage: message });
      toast('error', message);
    }
  }

  stopCamera(updateMode = true) {
    if (get().mode === 'recording') this.stopRecording();
    this.source?.stop();
    this.source = null;
    stopStream(this.stream);
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.pendingFrame = undefined;
    for (const l of this.frameListeners) l(null);
    if (!updateMode) return;
    set({ camera: 'off', cameraMessage: null, tracking: { ...get().tracking, personDetected: false, fps: 0 } });
    if (get().mode !== 'playback') {
      resetToRest(this.rig);
      this.setMode('cameraDisabled');
    }
  }

  private liveMode(): AppMode {
    if (!this.source) return 'cameraDisabled';
    return get().calibration.calibrated ? 'ready' : 'tracking';
  }

  private setMode(mode: AppMode) {
    set({ mode });
  }

  private resetLive() {
    this.landmarkFilter.reset();
    this.smoother.reset();
    this.retargeter.reset();
    this.target = null;
    this.lastBody = null;
  }

  // ---------- calibration ----------

  startCalibration() {
    if (!this.source) return toast('warning', 'Start the camera first.');
    if (get().mode === 'recording' || get().mode === 'playback') return;
    this.calibrator.reset();
    set({ calibration: { ...get().calibration, progress: 0, message: 'Stand upright, facing the camera…' } });
    this.setMode('calibrating');
  }

  cancelCalibration() {
    if (get().mode === 'calibrating') this.setMode(this.liveMode());
  }

  setGrounding(on: boolean) {
    this.retargeter.options.grounding = on;
    set({ grounding: on });
  }

  // ---------- recording ----------

  startRecording() {
    const mode = get().mode;
    if (mode !== 'ready') {
      toast('warning', mode === 'tracking' ? 'Calibrate before recording.' : 'Start the camera and calibrate before recording.');
      return;
    }
    this.recorder.start(performance.now());
    set({ recordingElapsed: 0 });
    this.setMode('recording');
  }

  stopRecording() {
    if (!this.recorder.isRecording) return;
    const name = get().newRecordingName.trim() || `Take ${this.takeCounter}`;
    const motion = this.recorder.stop({
      name,
      fps: 30,
      rig: this.rig.definition,
      rawHeight: this.rig.rawHeight,
      meta: {
        source: this.synthetic ? 'synthetic' : 'webcam',
        rootMotion: this.retargeter.options.grounding ? 'vertical-grounded' : 'none',
        calibration: serializeCalibration(this.calibration),
        app: 'MotionRecorder 0.1.0',
      },
    });
    this.setMode(this.liveMode());
    if (!motion) {
      toast('warning', 'Recording too short – nothing was saved.');
      return;
    }
    this.takeCounter++;
    set({ newRecordingName: `Take ${this.takeCounter}` });
    void this.addRecording(motion).then(() =>
      toast('success', `Recorded "${motion.name}" (${motion.duration.toFixed(2)} s, ${motion.frameCount} frames).`),
    );
  }

  // ---------- playback ----------

  play() {
    const rec = this.selected;
    if (!rec) return toast('warning', 'Select or import a recording first.');
    if (get().mode === 'recording') return;
    if (get().mode === 'calibrating') this.cancelCalibration();
    if (get().mode !== 'playback' || !this.player.loaded) {
      this.player.setLoop(get().playback.loop);
      this.player.load(rec.motion);
      this.setMode('playback');
    }
    this.player.play();
    this.syncPlayback();
  }

  pause() {
    this.player.pause();
    this.syncPlayback();
  }

  restart() {
    if (get().mode !== 'playback') return this.play();
    this.player.restart();
    this.syncPlayback();
  }

  seek(t: number) {
    if (get().mode !== 'playback') {
      this.play();
      this.player.pause();
    }
    this.player.seek(t);
    this.syncPlayback();
  }

  setLoop(loop: boolean) {
    this.player.setLoop(loop);
    set((s) => ({ playback: { ...s.playback, loop } }));
  }

  /** Leaves playback; live tracking takes over the bones again. */
  stopPlayback() {
    this.player.unload();
    this.resetLive();
    this.setMode(this.liveMode());
    this.syncPlayback();
  }

  private syncPlayback() {
    set((s) => ({
      playback: {
        ...s.playback,
        time: this.player.time,
        duration: this.player.loaded ? this.player.duration : (this.selected?.motion.duration ?? 0),
        playing: this.player.playing,
      },
    }));
  }

  // ---------- import / export ----------

  exportJson(rec = this.selected) {
    if (!rec) return toast('warning', 'Nothing to export.');
    downloadBlob(serializeMotion(rec.motion), motionFileName(rec.motion), 'application/json');
  }

  async exportGlb(rec = this.selected) {
    if (!rec) return toast('warning', 'Nothing to export.');
    try {
      const glb = await exportMotionGlb(this.rig.sourceBytes, rec.motion, this.rig.definition);
      // Validate by re-importing before handing the file out.
      const check = await importMotionGlb(glb.slice().buffer, this.rig.definition);
      if (check.motions.length !== 1) throw new Error(`Re-import check failed: ${check.errors.join(' ')}`);
      const drift = maxPoseDrift(rec.motion, check.motions[0]);
      if (drift > 0.01) throw new Error(`Re-import check failed: poses differ by ${((drift * 180) / Math.PI).toFixed(2)}°.`);
      downloadBlob(glb as Uint8Array<ArrayBuffer>, `${safeFileName(rec.motion.name)}.glb`, 'model/gltf-binary');
      toast('success', `Exported GLB (${(glb.byteLength / 1024).toFixed(0)} KB) – re-import check passed.`);
    } catch (e) {
      toast('error', `GLB export failed: ${(e as Error).message}`);
    }
  }

  async importFile(file: File) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.glb')) {
        const res = await importMotionGlb(await file.arrayBuffer(), this.rig.definition);
        res.warnings.forEach((w) => toast('warning', w));
        if (res.errors.length) toast('error', `${file.name}: ${res.errors.join(' ')}`);
        for (const m of res.motions) await this.addRecording(m);
        if (res.motions.length) toast('success', `Imported ${res.motions.length} animation(s) from ${file.name}.`);
        return res.motions.length > 0;
      }
      const result = parseMotionJson(await file.text(), this.rig.definition);
      result.warnings.forEach((w) => toast('warning', w));
      if (!result.ok) {
        toast('error', `${file.name}: ${result.errors.slice(0, 3).join(' ')}`);
        return false;
      }
      if (get().mode === 'playback') this.stopPlayback();
      await this.addRecording(result.motion);
      toast('success', `Imported "${result.motion.name}" (${result.motion.duration.toFixed(2)} s).`);
      return true;
    } catch (e) {
      toast('error', `Import failed: ${(e as Error).message}`);
      return false;
    }
  }

  // ---------- per-frame update ----------

  update(dt: number, now = performance.now()) {
    const mode = get().mode;
    if (mode === 'playback') {
      this.player.update(dt);
      if (now - this.lastUiAt > 80 || this.player.finished) {
        this.lastUiAt = now;
        this.syncPlayback();
      }
      this.consumeFrame(now, false);
      return;
    }
    if (!this.source) return;
    this.consumeFrame(now, true);
    if (this.target) {
      const rotations = this.smoother.apply(this.target.rotations, dt);
      const pose = { rotations, translations: this.target.translations };
      applyPose(this.rig, pose);
      if (mode === 'recording') {
        this.recorder.addSample(now, pose);
        if (now - this.lastUiAt > 100) {
          this.lastUiAt = now;
          set({ recordingElapsed: this.recorder.elapsed(now) });
        }
      }
    }
    if (now - this.lastStatsAt > 500) {
      this.lastStatsAt = now;
      const stats = this.source.stats();
      set((s) => ({ tracking: { ...s.tracking, fps: stats.fps, inferenceMs: stats.inferenceMs, frameStride: stats.frameStride } }));
    }
  }

  /** Consumes the newest pose frame (if any) and updates calibration and the retarget target. */
  private consumeFrame(now: number, drive: boolean) {
    if (this.pendingFrame === undefined) return;
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    const detected = frame !== null;
    if (get().tracking.personDetected !== detected) set((s) => ({ tracking: { ...s.tracking, personDetected: detected } }));
    if (!drive) return;

    let body: BodyFrame;
    if (frame) {
      body = mediaPipeToBody(frame);
      this.lastBody = body;
    } else if (this.lastBody) {
      // Tracking lost: same points, zero confidence -> bones hold, then relax to rest.
      body = { timestamp: now, points: this.lastBody.points, visibility: this.lastBody.visibility.map(() => 0) };
    } else return;

    if (get().mode === 'calibrating' && frame) {
      const { status, result } = this.calibrator.addFrame(body);
      if (result) {
        this.calibration = result;
        this.resetLive();
        set({ calibration: { calibrated: true, legsTracked: result.legsTracked, progress: 1, message: status.message } });
        toast('success', status.message);
        this.setMode('ready');
      } else {
        set((s) => ({ calibration: { ...s.calibration, progress: status.progress, message: status.message } }));
      }
    }

    const dt = this.lastSolveTime ? Math.min(0.25, Math.max(0.001, (body.timestamp - this.lastSolveTime) / 1000)) : 1 / 30;
    this.lastSolveTime = body.timestamp;
    const filtered = this.landmarkFilter.apply(body);
    const result = this.retargeter.solve(filtered, this.calibration, dt);
    this.target = result;
    let lost = 0;
    for (const c of result.confidence.values()) if (c < 1) lost++;
    if (get().tracking.lostBones !== lost) set((s) => ({ tracking: { ...s.tracking, lostBones: lost } }));
  }

  // ---------- test hooks ----------

  boneQuaternion(name: string): number[] | null {
    return this.rig.bones.get(name)?.quaternion.toArray() ?? null;
  }

  bonePosition(name: string): number[] | null {
    const b = this.rig.bones.get(name);
    return b ? b.getWorldPosition(new Vector3()).toArray() : null;
  }

  boneWorldQuaternion(name: string): number[] | null {
    const b = this.rig.bones.get(name);
    return b ? b.getWorldQuaternion(new Quaternion()).toArray() : null;
  }

  dispose() {
    this.stopCamera();
    this.player.unload();
  }
}

/** Largest rotation difference (radians) between two motions, sampled across the clip. */
function maxPoseDrift(a: MotionData, b: MotionData): number {
  let max = 0;
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = (a.duration * i) / steps;
    const pa = sampleMotion(a, t);
    const pb = sampleMotion(b, t);
    for (const [bone, qa] of pa.rotations) {
      const qb = pb.rotations.get(bone);
      if (!qb) return Infinity;
      max = Math.max(max, qa.angleTo(qb));
    }
  }
  return max;
}
