import { useEffect, useRef, useState } from 'react';
import type { MotionEngine } from '../engine/MotionEngine';
import { useStore } from '../state/store';
import { POSE_CONNECTIONS, type PoseFrame } from '../tracking/landmarks';

function drawOverlay(canvas: HTMLCanvasElement, frame: PoseFrame | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!frame) return;
  const pts = frame.image;
  const vis = (i: number) => pts[i]?.visibility ?? 1;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of POSE_CONNECTIONS) {
    const v = Math.min(vis(a), vis(b));
    if (v < 0.3) continue;
    ctx.strokeStyle = v >= 0.5 ? 'rgba(64, 224, 208, 0.9)' : 'rgba(255, 170, 60, 0.6)';
    ctx.beginPath();
    ctx.moveTo(pts[a].x * width, pts[a].y * height);
    ctx.lineTo(pts[b].x * width, pts[b].y * height);
    ctx.stroke();
  }
  pts.forEach((p, i) => {
    if (i > 10 && i < 33 && vis(i) >= 0.3) {
      ctx.fillStyle = vis(i) >= 0.5 ? '#ffffff' : '#ffaa3c';
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

export function WebcamPanel({ engine }: { engine: MotionEngine }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(4 / 3);
  const camera = useStore((s) => s.camera);
  const cameraMessage = useStore((s) => s.cameraMessage);
  const cameras = useStore((s) => s.cameras);
  const selectedCamera = useStore((s) => s.selectedCamera);
  const tracking = useStore((s) => s.tracking);
  const calibration = useStore((s) => s.calibration);
  const mode = useStore((s) => s.mode);
  const sourceKind = useStore((s) => s.sourceKind);
  const grounding = useStore((s) => s.grounding);

  useEffect(() => {
    const off = engine.onPoseFrame((f) => canvasRef.current && drawOverlay(canvasRef.current, f));
    return () => {
      off();
    };
  }, [engine]);

  const on = camera === 'on';
  const busy = mode === 'recording' || mode === 'playback';
  const start = (deviceId?: string | null) => void engine.startCamera(videoRef.current, deviceId ?? selectedCamera);

  return (
    <div className="webcam">
      <div className="panel-header">
        <h2>Webcam</h2>
        <div className="row">
          {sourceKind === 'webcam' && cameras.length > 0 && (
            <select
              aria-label="Camera"
              value={selectedCamera ?? ''}
              disabled={camera === 'starting' || mode === 'recording'}
              onChange={(e) => {
                useStore.setState({ selectedCamera: e.target.value });
                if (on) start(e.target.value);
              }}
            >
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {on ? (
            <button onClick={() => engine.stopCamera()} disabled={mode === 'recording'}>
              Stop camera
            </button>
          ) : (
            <button className="primary" onClick={() => start()} disabled={camera === 'starting'} data-testid="start-camera">
              {camera === 'starting' ? 'Starting…' : sourceKind === 'synthetic' ? 'Start synthetic input' : 'Start camera'}
            </button>
          )}
        </div>
      </div>

      <div className="video-wrap" style={{ aspectRatio: String(aspect) }}>
        <video
          ref={videoRef}
          className="mirrored"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
        />
        <canvas ref={canvasRef} className="overlay mirrored" data-testid="pose-overlay" />
        {!on && (
          <div className="video-placeholder">
            {camera === 'error' ? (
              <span className="error-text">{cameraMessage}</span>
            ) : (
              (cameraMessage ?? 'Camera is off. Video stays on this device; nothing is uploaded.')
            )}
          </div>
        )}
        {on && !tracking.personDetected && <div className="video-badge warn">No person detected</div>}
        {mode === 'calibrating' && (
          <div className="calib-overlay">
            <div>{calibration.message}</div>
            <div className="progress">
              <div style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="status-grid" data-testid="tracking-status">
        <span>Tracking</span>
        <strong className={on && tracking.personDetected ? 'ok' : 'muted'}>
          {!on ? 'off' : tracking.personDetected ? `${tracking.fps} fps` : 'searching…'}
        </strong>
        <span>Inference</span>
        <strong>
          {on && sourceKind === 'webcam' ? `${tracking.inferenceMs.toFixed(0)} ms · ${tracking.delegate ?? ''}${tracking.frameStride > 1 ? ` · 1/${tracking.frameStride} frames` : ''}` : '–'}
        </strong>
        <span>Held joints</span>
        <strong className={tracking.lostBones > 0 && on ? 'warn' : ''}>{on ? tracking.lostBones : '–'}</strong>
        <span>Calibration</span>
        <strong className={calibration.calibrated ? 'ok' : 'warn'} data-testid="calibration-status">
          {calibration.calibrated ? (calibration.legsTracked ? 'full body' : 'upper body only') : 'not calibrated'}
        </strong>
      </div>

      <div className="row">
        {mode === 'calibrating' ? (
          <button onClick={() => engine.cancelCalibration()}>Cancel calibration</button>
        ) : (
          <button className={calibration.calibrated ? '' : 'primary'} onClick={() => engine.startCalibration()} disabled={!on || busy} data-testid="calibrate">
            {calibration.calibrated ? 'Recalibrate' : 'Calibrate'}
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={grounding} onChange={(e) => engine.setGrounding(e.target.checked)} disabled={mode === 'recording'} />
          Foot grounding
        </label>
      </div>
      <p className="hint">
        Calibration: stand 2–3 m from the camera so your whole body is visible, face the camera upright with arms relaxed, and hold still for
        about 1.5 s.
      </p>
    </div>
  );
}
