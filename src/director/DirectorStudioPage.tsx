import { useEffect, useState } from 'react';
import { loadMannequin, type MannequinRig } from '../rig/mannequinLoader';
import { MANNEQUIN_URL } from '../rig/rigSpec';
import { getContext, initDirector, setDirectorError, useDirector } from './state/directorStore';
import { DirectorToolbar } from './components/DirectorToolbar';
import { SceneHierarchy } from './components/SceneHierarchy';
import { InspectorPanel } from './components/InspectorPanel';
import { DirectorChat } from './components/DirectorChat';
import { DirectorTimeline } from './components/DirectorTimeline';
import { StageViewport } from './components/StageViewport';
import './director.css';

declare global {
  interface Window {
    __director?: { store: typeof useDirector; context: typeof getContext };
  }
}

export default function DirectorStudioPage() {
  const [rig, setRig] = useState<MannequinRig | null>(null);
  const status = useDirector((s) => s.status);
  const error = useDirector((s) => s.error);
  const notices = useDirector((s) => s.notices);

  useEffect(() => {
    let disposed = false;
    loadMannequin(MANNEQUIN_URL)
      .then(async (r) => {
        if (disposed) return;
        await initDirector(r);
        if (!disposed) setRig(r);
      })
      .catch((e: Error) => setDirectorError(e.message));
    window.__director = { store: useDirector, context: getContext };
    return () => {
      disposed = true;
      useDirector.setState({ playing: false });
      delete window.__director;
    };
  }, []);

  return (
    <div className="ds-app" data-testid="director-studio">
      <DirectorToolbar />
      {status === 'error' && <div className="ds-fatal">Could not load the mannequin: {error}</div>}
      <div className="ds-main">
        <aside className="ds-left">
          <SceneHierarchy />
          <InspectorPanel />
        </aside>
        <section className="ds-stage">{rig ? <StageViewport rig={rig} /> : <div className="ds-placeholder">Loading stage…</div>}</section>
        <aside className="ds-right">
          <DirectorChat />
        </aside>
      </div>
      <DirectorTimeline />
      <div className="ds-notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`ds-notice ${n.kind}`} data-testid="director-notice">
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}
