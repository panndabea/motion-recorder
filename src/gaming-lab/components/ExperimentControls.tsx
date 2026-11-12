import { useEffect, useState } from 'react';
import type { Experiment, Params } from '../engine/experiment';
import { useLab } from '../state/gamingLabStore';
import { liveReadouts } from './LabViewport';

export function ExperimentControls({ exp, params, onBake }: { exp: Experiment; params: Params; onBake: (kind: 'json' | 'glb' | 'recorder') => void }) {
  const setParam = useLab((s) => s.setParam);
  const setParams = useLab((s) => s.setParams);
  const resetParams = useLab((s) => s.resetParams);
  const [readouts, setReadouts] = useState<Record<string, string>>({});
  useEffect(() => {
    const id = setInterval(() => setReadouts({ ...liveReadouts.values }), 200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="gl-controls" data-testid="experiment-controls">
      <div className="gl-row gl-presets">
        {exp.presets.map((p) => (
          <button key={p.name} className="gl-btn" onClick={() => setParams(exp.id, p.params)} data-testid={`preset-${p.name}`}>
            {p.name}
          </button>
        ))}
      </div>
      {exp.controls.map((c) => {
        const v = params[c.key];
        if (c.type === 'toggle')
          return (
            <label key={c.key} className="gl-ctl gl-toggle">
              <input type="checkbox" checked={Boolean(v)} onChange={(e) => setParam(exp.id, c.key, e.target.checked)} data-testid={`ctl-${c.key}`} />
              {c.label}
            </label>
          );
        if (c.type === 'select')
          return (
            <label key={c.key} className="gl-ctl">
              <span>{c.label}</span>
              <select value={String(v)} onChange={(e) => setParam(exp.id, c.key, e.target.value)} data-testid={`ctl-${c.key}`}>
                {c.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          );
        return (
          <label key={c.key} className="gl-ctl">
            <span>
              {c.label} <b>{Number(v).toFixed(c.step < 0.1 ? 2 : 1)}</b>
            </span>
            <input type="range" min={c.min} max={c.max} step={c.step} value={Number(v)} onChange={(e) => setParam(exp.id, c.key, Number(e.target.value))} data-testid={`ctl-${c.key}`} />
          </label>
        );
      })}
      <button className="gl-btn" onClick={() => resetParams(exp.id, exp.defaults)} data-testid="reset-params">
        Reset to defaults
      </button>
      <div className="gl-readouts" data-testid="readouts">
        {Object.entries(readouts).map(([k, val]) => (
          <div key={k} className="gl-readout">
            <span>{k}</span>
            <b>{val}</b>
          </div>
        ))}
      </div>
      {exp.bakeable && (
        <div className="gl-bake">
          <h4>Bake current animation</h4>
          <p className="gl-note">Bakes the technique-enabled result into skeletal keyframes (local bone rotations + hips translation). Live interaction (dragging, runtime targets) is not part of the file.</p>
          <div className="gl-row">
            <button className="gl-btn" onClick={() => onBake('json')} data-testid="bake-json">Motion JSON</button>
            <button className="gl-btn" onClick={() => onBake('glb')} data-testid="bake-glb">GLB</button>
            <button className="gl-btn" onClick={() => onBake('recorder')} data-testid="bake-recorder">Send to MotionRecorder</button>
          </div>
        </div>
      )}
    </div>
  );
}
