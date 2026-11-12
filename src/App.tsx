import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { loadMannequin } from './rig/mannequinLoader';
import { MANNEQUIN_URL } from './rig/rigSpec';
import { MotionEngine } from './engine/MotionEngine';
import { MODE_LABEL, useStore } from './state/store';
import { WebcamPanel } from './components/WebcamPanel';
import { RecorderPanel } from './components/RecorderPanel';
import { Toasts } from './components/Toasts';
import { CharacterViewport } from './viewport/CharacterViewport';


declare global {
  interface Window {
    __motionRecorder?: { engine: MotionEngine; store: typeof useStore };
  }
}

export function App() {
  const { search } = useLocation();
  // Read once per mount: the engine is created for one input source.
  const [{ synthetic, exposeTestHook }] = useState(() => {
    const params = new URLSearchParams(search);
    const syn = params.get('source') === 'synthetic';
    return { synthetic: syn, exposeTestHook: syn || params.has('test') };
  });
  const [engine, setEngine] = useState<MotionEngine | null>(null);
  const rigStatus = useStore((s) => s.rigStatus);
  const rigError = useStore((s) => s.rigError);
  const mode = useStore((s) => s.mode);

  useEffect(() => {
    let disposed = false;
    let created: MotionEngine | null = null;
    loadMannequin(MANNEQUIN_URL)
      .then(async (rig) => {
        if (disposed) return;
        created = new MotionEngine(rig, synthetic);
        await created.init();
        if (disposed) return created.dispose();
        if (exposeTestHook) window.__motionRecorder = { engine: created, store: useStore };
        useStore.setState({ rigStatus: 'ready' });
        setEngine(created);
      })
      .catch((e: Error) => useStore.setState({ rigStatus: 'error', rigError: e.message }));
    return () => {
      disposed = true;
      created?.dispose();
      if (window.__motionRecorder?.engine === created) delete window.__motionRecorder;
    };
  }, [synthetic, exposeTestHook]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ●
          </span>
          MotionRecorder
          {synthetic && <span className="tag">synthetic input</span>}
        </div>
        <div className="topbar-right">
          <div className={`mode mode-${mode}`} data-testid="mode">
            {MODE_LABEL[mode]}
          </div>
          <Link className="btn director-link" to={`/director${search}`} data-testid="open-director">
            AI Director Studio →
          </Link>
        </div>
      </header>
      {rigStatus === 'error' && <div className="fatal">Could not load the mannequin: {rigError}</div>}
      <main className="panels">
        <section className="panel webcam-panel">{engine ? <WebcamPanel engine={engine} /> : <div className="placeholder">Loading…</div>}</section>
        <section className="panel viewport-panel">
          {engine ? <CharacterViewport engine={engine} /> : <div className="placeholder">{rigStatus === 'loading' ? 'Loading mannequin…' : ''}</div>}
        </section>
      </main>
      <footer className="panel recorder-panel">{engine && <RecorderPanel engine={engine} />}</footer>
      <Toasts />
    </div>
  );
}
