import { useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  exportActorGlb,
  exportFullSceneGlb,
  exportMotionJson,
  notify,
  openProjectFile,
  redo,
  renameProject,
  resetProject,
  saveProjectFile,
  sendToRecorder,
  undo,
  useDirector,
} from '../state/directorStore';

export function DirectorToolbar() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const name = useDirector((s) => s.project.name);
  const canUndo = useDirector((s) => s.canUndo);
  const canRedo = useDirector((s) => s.canRedo);
  const busy = useDirector((s) => s.busy);
  const ready = useDirector((s) => s.status === 'ready');
  const hasActions = useDirector((s) => s.project.actions.length > 0);
  const file = useRef<HTMLInputElement>(null);

  return (
    <header className="ds-toolbar">
      <Link className="ds-btn ds-back" to={`/recorder${search}`} data-testid="back-to-recorder">
        ← Back to MotionRecorder
      </Link>
      <div className="ds-title">
        <span className="ds-logo">◆</span> AI Director Studio
      </div>
      <input className="ds-name" aria-label="Project name" defaultValue={name} key={name} onBlur={(e) => e.target.value !== name && renameProject(e.target.value)} />
      <div className="ds-group">
        <button className="ds-btn" disabled={!ready} onClick={() => confirm('Start a new, empty scene? (Undo can bring the current one back.)') && resetProject()}>
          New
        </button>
        <button className="ds-btn" disabled={!ready} onClick={() => file.current?.click()}>
          Open…
        </button>
        <button className="ds-btn" disabled={!ready} onClick={saveProjectFile} data-testid="save-project">
          Save
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="open-project-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openProjectFile(f);
            e.target.value = '';
          }}
        />
      </div>
      <div className="ds-group">
        <button className="ds-btn" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)" data-testid="undo">
          Undo
        </button>
        <button className="ds-btn" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)" data-testid="redo">
          Redo
        </button>
      </div>
      <div className="ds-group">
        <button className="ds-btn" disabled={!hasActions || !!busy} onClick={exportMotionJson} data-testid="export-motion-json">
          Motion JSON
        </button>
        <button className="ds-btn" disabled={!hasActions || !!busy} onClick={() => void exportActorGlb()} data-testid="export-actor-glb">
          Actor GLB
        </button>
        <button className="ds-btn" disabled={!hasActions || !!busy} onClick={() => void exportFullSceneGlb()} data-testid="export-scene-glb">
          Scene GLB
        </button>
        <button
          className="ds-btn ds-accent"
          disabled={!hasActions || !!busy}
          data-testid="send-to-recorder"
          onClick={() =>
            void sendToRecorder().then((ok) => {
              if (ok) {
                notify('success', 'Sent to MotionRecorder.');
                navigate(`/recorder${search}`);
              }
            })
          }
        >
          Send to MotionRecorder
        </button>
      </div>
      {busy && <span className="ds-busy">{busy}…</span>}
    </header>
  );
}
