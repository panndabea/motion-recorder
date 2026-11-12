import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { exportMotionGlb } from '../../export/glbExporter';
import { serializeMotion } from '../../export/jsonExporter';
import { fetchMannequinBytes } from '../../rig/mannequinLoader';
import { MANNEQUIN_URL } from '../../rig/rigSpec';
import { saveRecording } from '../../storage/recordingStore';
import { downloadBlob, safeFileName } from '../../util/download';
import { ConceptExplanation } from '../components/ConceptExplanation';
import { ExperimentControls } from '../components/ExperimentControls';
import { ActorView } from '../components/LabViewport';
import { CONCEPTS } from '../education/concepts';
import { bakeExperiment } from '../engine/bake';
import { LabActor } from '../engine/labActor';
import { EXPERIMENTS, PLANNED, experimentById } from '../experiments/registry';
import { labClock, useLab, type CameraPreset } from '../state/gamingLabStore';
import '../gamingLab.css';

const FRAME = 1 / 30;

function usePlaybackClock(duration: number) {
  const playing = useLab((s) => s.playing);
  const speed = useLab((s) => s.speed);
  const loop = useLab((s) => s.loop);
  useEffect(() => {
    labClock.duration = duration;
    if (labClock.time > duration) labClock.time = 0;
  }, [duration]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      labClock.time += dt * speed;
      if (labClock.time > labClock.duration) {
        if (loop) labClock.time %= labClock.duration;
        else {
          labClock.time = labClock.duration;
          useLab.getState().set({ playing: false });
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, loop]);
}

function Transport({ duration }: { duration: number }) {
  const { playing, speed, loop, compare, debug, skeleton, axes, camera, set } = useLab();
  const [time, setTime] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTime(labClock.time), 100);
    return () => clearInterval(id);
  }, []);
  const seek = (t: number) => {
    labClock.time = Math.min(duration, Math.max(0, t));
    setTime(labClock.time);
  };
  return (
    <div className="gl-transport" data-testid="transport">
      <button className="gl-btn" onClick={() => set({ playing: !playing })} data-testid="play-toggle">
        {playing ? 'Pause' : 'Play'}
      </button>
      <button className="gl-btn" onClick={() => (set({ playing: false }), seek(labClock.time - FRAME))} data-testid="step-back" title="Previous frame">
        ◀︎|
      </button>
      <button className="gl-btn" onClick={() => (set({ playing: false }), seek(labClock.time + FRAME))} data-testid="step-forward" title="Next frame">
        |▶︎
      </button>
      <button className="gl-btn" onClick={() => seek(0)} data-testid="rewind">
        Reset time
      </button>
      <input className="gl-scrub" type="range" min={0} max={duration} step={0.001} value={Math.min(time, duration)} onChange={(e) => (set({ playing: false }), seek(Number(e.target.value)))} data-testid="scrub" />
      <span className="gl-time" data-testid="time">
        {time.toFixed(2)} / {duration.toFixed(2)} s
      </span>
      <select value={speed} onChange={(e) => set({ speed: Number(e.target.value) })} data-testid="speed" title="Playback speed">
        {[0.1, 0.25, 0.5, 1, 1.5, 2].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <label className="gl-toggle">
        <input type="checkbox" checked={loop} onChange={(e) => set({ loop: e.target.checked })} /> Loop
      </label>
      <span className="gl-sep" />
      <label className="gl-toggle">
        <input type="checkbox" checked={compare === 'split'} onChange={(e) => set({ compare: e.target.checked ? 'split' : 'single' })} data-testid="split-toggle" /> Split-screen
      </label>
      <label className="gl-toggle">
        <input type="checkbox" checked={debug} onChange={(e) => set({ debug: e.target.checked })} data-testid="debug-toggle" /> Debug overlay
      </label>
      <label className="gl-toggle">
        <input type="checkbox" checked={skeleton} onChange={(e) => set({ skeleton: e.target.checked })} /> Skeleton
      </label>
      <label className="gl-toggle">
        <input type="checkbox" checked={axes} onChange={(e) => set({ axes: e.target.checked })} /> Axes
      </label>
      <select value={camera} onChange={(e) => set({ camera: e.target.value as CameraPreset, cameraNonce: useLab.getState().cameraNonce + 1 })} data-testid="camera-preset" title="Camera preset">
        {['front', 'side', 'three-quarter', 'top', 'close-up', 'wide'].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}

export default function GamingLabPage() {
  const { search } = useLocation();
  const [actors, setActors] = useState<{ main: LabActor; baseline: LabActor; bake: LabActor; bytes: ArrayBuffer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const experimentId = useLab((s) => s.experimentId);
  const allParams = useLab((s) => s.params);
  const compare = useLab((s) => s.compare);
  const select = useLab((s) => s.select);
  const exp = experimentById(experimentId) ?? EXPERIMENTS[0];
  const params = useMemo(() => ({ ...exp.defaults, ...allParams[exp.id] }), [exp, allParams]);
  const duration = exp.duration(params);
  usePlaybackClock(duration);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      const bytes = await fetchMannequinBytes(MANNEQUIN_URL);
      const [main, baseline, bake] = await Promise.all([LabActor.create(bytes.slice(0)), LabActor.create(bytes.slice(0)), LabActor.create(bytes.slice(0))]);
      setActors({ main, baseline, bake, bytes });
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const bake = async (kind: 'json' | 'glb' | 'recorder') => {
    if (!actors) return;
    const motion = bakeExperiment(exp, actors.bake, params, `Gaming Lab – ${exp.title}`);
    if (kind === 'json') downloadBlob(serializeMotion(motion), `${safeFileName(motion.name)}.motion.json`, 'application/json');
    else if (kind === 'glb') {
      const glb = await exportMotionGlb(actors.bytes, motion, actors.bake.def);
      downloadBlob(glb as BlobPart, `${safeFileName(motion.name)}.glb`, 'model/gltf-binary');
    } else {
      const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `g${Date.now()}`;
      await saveRecording({ id, motion });
    }
    setNotice(`Baked ${motion.frameCount} frames @ ${motion.fps} fps (${motion.duration.toFixed(2)} s)${kind === 'recorder' ? ' and saved to MotionRecorder recordings' : ''}.`);
  };

  return (
    <div className="gl-root" data-testid="gaming-lab">
      <header className="gl-top">
        <div className="gl-brand">Gaming Animation Lab</div>
        <div className="gl-row">
          <Link className="gl-btn" to={`/recorder${search}`} data-testid="lab-to-recorder">
            ← MotionRecorder
          </Link>
          <Link className="gl-btn" to={`/director${search}`}>
            AI Director Studio
          </Link>
        </div>
      </header>
      <div className="gl-main">
        <nav className="gl-nav" data-testid="concept-explorer">
          <h3>Concepts</h3>
          <ol>
            {PLANNED.map((p) => {
              const available = Boolean(experimentById(p.id));
              return (
                <li key={p.id}>
                  <button className={`gl-nav-item ${p.id === exp.id ? 'active' : ''}`} disabled={!available} onClick={() => select(p.id, experimentById(p.id)?.camera)} data-testid={`concept-${p.id}`}>
                    {p.title}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="gl-center">
          <div className={`gl-views ${compare}`}>
            {error && <div className="gl-error">Could not load mannequin.glb: {error}</div>}
            {!actors && !error && <div className="gl-placeholder">Loading mannequin…</div>}
            {actors && compare === 'split' && (
              <ActorView key={`b-${exp.id}`} actor={actors.baseline} exp={exp} params={params} enabled={false} label="Technique OFF (baseline)" primary={false} testId="view-baseline" />
            )}
            {actors && (
              <ActorView key={`m-${exp.id}`} actor={actors.main} exp={exp} params={params} enabled={Boolean(params[exp.toggleKey])} label={compare === 'split' ? 'Technique ON' : undefined} primary testId="view-main" />
            )}
          </div>
          <Transport duration={duration} />
          <div className="gl-bottom">
            <h2 data-testid="experiment-title">{exp.title}</h2>
            <ConceptExplanation concept={CONCEPTS[exp.id]} />
          </div>
        </section>
        <aside className="gl-side">
          <h3>Experiment controls</h3>
          <ExperimentControls exp={exp} params={params} onBake={(k) => void bake(k).catch((e: unknown) => setNotice(`Bake failed: ${String(e)}`))} />
          {notice && (
            <div className="gl-notice" data-testid="bake-notice">
              {notice}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
