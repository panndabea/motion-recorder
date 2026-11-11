import { useRef, useState } from 'react';
import type { MotionEngine } from '../engine/MotionEngine';
import { useStore } from '../state/store';

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

export function RecorderPanel({ engine }: { engine: MotionEngine }) {
  const mode = useStore((s) => s.mode);
  const recordings = useStore((s) => s.recordings);
  const selectedId = useStore((s) => s.selectedId);
  const elapsed = useStore((s) => s.recordingElapsed);
  const newName = useStore((s) => s.newRecordingName);
  const playback = useStore((s) => s.playback);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const selected = recordings.find((r) => r.id === selectedId);
  const recording = mode === 'recording';
  const inPlayback = mode === 'playback';
  const duration = inPlayback ? playback.duration : (selected?.motion.duration ?? 0);
  const time = inPlayback ? playback.time : 0;

  return (
    <div className="recorder">
      <div className="rec-controls">
        <div className="group">
          {recording ? (
            <button className="danger" onClick={() => engine.stopRecording()} data-testid="stop-recording">
              ■ Stop
            </button>
          ) : (
            <button className="record" onClick={() => engine.startRecording()} disabled={mode !== 'ready'} data-testid="record" title={mode !== 'ready' ? 'Start the camera and calibrate first' : 'Start recording'}>
              ● Record
            </button>
          )}
          <input
            className="name-input"
            aria-label="Animation name"
            value={newName}
            disabled={recording}
            onChange={(e) => useStore.setState({ newRecordingName: e.target.value })}
            data-testid="animation-name"
          />
          <span className={`rec-time ${recording ? 'live' : ''}`} data-testid="recording-time">
            {recording ? `REC ${fmt(elapsed)}` : 'idle'}
          </span>
        </div>

        <div className="group">
          {inPlayback && playback.playing ? (
            <button onClick={() => engine.pause()} data-testid="pause">
              ❚❚ Pause
            </button>
          ) : (
            <button className="primary" onClick={() => engine.play()} disabled={!selected || recording} data-testid="play">
              ▶ Play
            </button>
          )}
          <button onClick={() => engine.restart()} disabled={!selected || recording} title="Restart">
            ⟲ Restart
          </button>
          <button onClick={() => engine.stopPlayback()} disabled={!inPlayback} data-testid="back-to-live">
            Back to live
          </button>
          <label className="check">
            <input type="checkbox" checked={playback.loop} onChange={(e) => engine.setLoop(e.target.checked)} data-testid="loop" /> Loop
          </label>
        </div>

        <div className="group">
          <button onClick={() => engine.exportJson()} disabled={!selected} data-testid="export-json">
            Export JSON
          </button>
          <button onClick={() => void engine.exportGlb()} disabled={!selected} data-testid="export-glb">
            Export GLB
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={recording} data-testid="import">
            Import…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.glb,application/json,model/gltf-binary"
            hidden
            data-testid="import-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void engine.importFile(file);
            }}
          />
        </div>
      </div>

      <div className="timeline">
        <span className="time" data-testid="playback-time">
          {fmt(time)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.001)}
          step={1 / 120}
          value={Math.min(time, duration)}
          disabled={!selected || recording}
          onChange={(e) => engine.seek(Number(e.target.value))}
          aria-label="Timeline"
          data-testid="timeline"
        />
        <span className="time" data-testid="duration">
          {fmt(duration)}
        </span>
      </div>

      <ul className="recordings" data-testid="recordings">
        {recordings.length === 0 && <li className="muted">No recordings yet. Calibrate, then press Record – or import a .motion.json / .glb.</li>}
        {recordings.map((r) => (
          <li key={r.id} className={r.id === selectedId ? 'selected' : ''} onClick={() => engine.select(r.id)} data-testid="recording-item">
            {editing === r.id ? (
              <input
                autoFocus
                value={draft}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  void engine.rename(r.id, draft);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
                data-testid="rename-input"
              />
            ) : (
              <span className="rec-name">{r.motion.name}</span>
            )}
            <span className="muted">
              {r.motion.duration.toFixed(2)} s · {r.motion.frameCount} f · {r.motion.meta.source}
            </span>
            <span className="actions">
              <button
                className="small"
                disabled={recording}
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft(r.motion.name);
                  setEditing(r.id);
                }}
              >
                Rename
              </button>
              <button
                className="small danger"
                disabled={recording}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${r.motion.name}"?`)) void engine.remove(r.id);
                }}
                data-testid="delete-recording"
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
