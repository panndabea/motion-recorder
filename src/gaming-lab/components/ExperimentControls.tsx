import { useEffect, useState } from 'react';
import type { Experiment, LabChart, Params } from '../engine/experiment';
import { labClock } from '../state/gamingLabStore';
import { useLab } from '../state/gamingLabStore';
import { liveReadouts } from './LabViewport';

export function ExperimentControls({ exp, params, onBake }: { exp: Experiment; params: Params; onBake: (kind: 'json' | 'glb' | 'recorder') => void }) {
  const setParam = useLab((s) => s.setParam);
  const setParams = useLab((s) => s.setParams);
  const resetParams = useLab((s) => s.resetParams);
  const [readouts, setReadouts] = useState<Record<string, string>>({});
  const [chart, setChart] = useState<LabChart | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      setReadouts({ ...liveReadouts.values });
      setChart(exp.chart ? exp.chart(params, labClock.time) : null);
    }, 200);
    return () => clearInterval(id);
  }, [exp, params]);
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
      {chart && <ChartView chart={chart} />}
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

export function ChartView({ chart }: { chart: LabChart }) {
  const W = 270;
  const H = 170;
  const pad = 26;
  const xs = chart.series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = chart.series.flatMap((s) => s.points.map((p) => p[1]));
  const x0 = Math.min(0, ...xs), x1 = Math.max(1e-3, ...xs);
  const y0 = Math.min(0, ...ys), y1 = Math.max(1e-3, ...ys);
  const sx = (x: number) => pad + ((x - x0) / (x1 - x0)) * (W - pad - 6);
  const sy = (y: number) => H - pad - ((y - y0) / (y1 - y0)) * (H - pad - 6);
  return (
    <figure className="gl-chart" data-testid="lab-chart">
      <figcaption>{chart.title}</figcaption>
      <svg width={W} height={H}>
        <line x1={pad} y1={H - pad} x2={W - 4} y2={H - pad} stroke="#3a4050" />
        <line x1={pad} y1={4} x2={pad} y2={H - pad} stroke="#3a4050" />
        <text x={W - 6} y={H - 8} textAnchor="end" fill="#8a93a6" fontSize="10">{chart.xLabel} (0–{x1.toFixed(1)})</text>
        <text x={4} y={12} fill="#8a93a6" fontSize="10">{chart.yLabel} (max {y1.toFixed(2)})</text>
        {chart.series.map((s) => (
          <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={1.6} strokeDasharray={s.dashed ? '4 3' : undefined} points={s.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(' ')} />
        ))}
        {chart.markers?.map((m, i) => <circle key={i} cx={sx(m.x)} cy={sy(m.y)} r={2.4} fill={m.color} />)}
        {chart.cursorX !== undefined && <line x1={sx(chart.cursorX)} x2={sx(chart.cursorX)} y1={4} y2={H - pad} stroke="#ff9f1c" />}
      </svg>
      <div className="gl-legend">
        {chart.series.map((s) => (
          <span key={s.name} style={{ color: s.color }}>■ {s.name}</span>
        ))}
      </div>
    </figure>
  );
}
