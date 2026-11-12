import { STYLES, type DirectorAction } from '../ai/commandSchema';
import { deleteAction, insertPauseAfter, moveAction, updateAction, updateObject, useDirector } from '../state/directorStore';

function Num({ label, value, step = 0.05, min, max, onChange, testId }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="ds-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        defaultValue={+value.toFixed(3)}
        key={value}
        data-testid={testId}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onChange(v);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function ActionInspector({ a }: { a: DirectorAction }) {
  const time = useDirector((s) => s.perf?.actionTimes.get(a.id));
  return (
    <div className="ds-inspector" data-testid="action-inspector">
      <div className="ds-kv">
        <b>{a.type.replace('_', ' ')}</b> <span className="id">#{a.id}</span>
        {a.auto && <span className="ds-tag">auto</span>}
      </div>
      {a.target && <div className="ds-kv">target: {a.target}</div>}
      {a.direction && <div className="ds-kv">direction: {a.direction}</div>}
      {time && (
        <div className="ds-kv" data-testid="action-timing">
          {time.start.toFixed(2)}s → {time.end.toFixed(2)}s ({(time.end - time.start).toFixed(2)}s)
        </div>
      )}
      <Num label="Speed" value={a.speed} step={0.1} min={0.2} max={3} onChange={(v) => updateAction(a.id, { speed: Math.min(3, Math.max(0.2, v)) })} testId="action-speed" />
      {<Num label="Duration (s)" value={+(a.duration ?? (time ? time.end - time.start : 1)).toFixed(2)} step={0.1} min={0.1} max={20} onChange={(v) => updateAction(a.id, { duration: Math.min(20, Math.max(0.1, v)) })} testId="action-duration" />}
      {(a.type === 'walk_to' || a.type === 'bend') && <Num label="Bend (°)" value={a.bend ?? (a.type === 'bend' ? 35 : 0)} step={5} min={-30} max={70} onChange={(v) => updateAction(a.id, { bend: Math.min(70, Math.max(-30, v)) })} />}
      {(a.type === 'walk_to' || a.type.startsWith('look')) && <Num label="Amplitude" value={a.amplitude ?? 1} step={0.1} min={0} max={2.5} onChange={(v) => updateAction(a.id, { amplitude: Math.min(2.5, Math.max(0, v)) })} />}
      <label className="ds-field">
        <span>Style</span>
        <select value={a.style ?? 'normal'} onChange={(e) => updateAction(a.id, { style: e.target.value as DirectorAction['style'] })}>
          {STYLES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <div className="ds-row">
        <button className="ds-btn" onClick={() => moveAction(a.id, -1)} data-testid="action-earlier">
          ◀ Earlier
        </button>
        <button className="ds-btn" onClick={() => moveAction(a.id, 1)} data-testid="action-later">
          Later ▶
        </button>
      </div>
      <div className="ds-row">
        <button className="ds-btn" onClick={() => insertPauseAfter(a.id)} data-testid="insert-pause">
          + Pause after
        </button>
        <button className="ds-btn danger" onClick={() => deleteAction(a.id)} data-testid="delete-action">
          Delete
        </button>
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const selectedObject = useDirector((s) => s.selectedObject);
  const obj = useDirector((s) => s.project.scene.objects.find((o) => o.id === s.selectedObject));
  const action = useDirector((s) => s.project.actions.find((a) => a.id === s.selectedAction));
  const glassState = useDirector((s) => (s.perf ? s.perf.evaluate(s.time).glassState : null));
  return (
    <div className="ds-panel ds-grow">
      <h3>Inspector</h3>
      {action ? (
        <ActionInspector a={action} />
      ) : obj && selectedObject ? (
        <div className="ds-inspector" data-testid="object-inspector">
          <div className="ds-kv">
            <b>{obj.name}</b> <span className="id">#{obj.id}</span> <span className="ds-tag">{obj.kind}</span>
          </div>
          {obj.kind === 'glass' && glassState && (
            <div className="ds-kv" data-testid="glass-state">
              state: {glassState.replace('_', ' ')}
            </div>
          )}
          {(['actor', 'table', 'glass', 'chair', 'camera', 'light'] as string[]).includes(obj.kind) && (
            <>
              <Num label="X" value={obj.position[0]} onChange={(v) => updateObject(obj.id, { position: [v, obj.position[1], obj.position[2]] })} testId="pos-x" />
              {obj.kind !== 'actor' && obj.kind !== 'glass' && <Num label="Y" value={obj.position[1]} onChange={(v) => updateObject(obj.id, { position: [obj.position[0], v, obj.position[2]] })} />}
              <Num label="Z" value={obj.position[2]} onChange={(v) => updateObject(obj.id, { position: [obj.position[0], obj.position[1], v] })} testId="pos-z" />
              {obj.kind !== 'camera' && obj.kind !== 'light' && <Num label="Rotation Y (°)" value={obj.rotationY} step={5} onChange={(v) => updateObject(obj.id, { rotationY: v })} />}
            </>
          )}
          {obj.kind === 'actor' && <p className="ds-hint">Start mark of the actor. Drag the ring on the stage or type a position.</p>}
          {obj.kind === 'table' && obj.size && (
            <>
              <Num label="Width" value={obj.size[0]} min={0.4} max={3} onChange={(v) => updateObject(obj.id, { size: [Math.max(0.4, v), obj.size![1], obj.size![2]] })} />
              <Num label="Height" value={obj.size[1]} min={0.5} max={1.1} onChange={(v) => updateObject(obj.id, { size: [obj.size![0], Math.min(1.1, Math.max(0.5, v)), obj.size![2]] })} />
              <Num label="Depth" value={obj.size[2]} min={0.4} max={2} onChange={(v) => updateObject(obj.id, { size: [obj.size![0], obj.size![1], Math.max(0.4, v)] })} />
            </>
          )}
          {obj.kind === 'light' && <Num label="Intensity" value={obj.value ?? 2} step={0.2} min={0} max={10} onChange={(v) => updateObject(obj.id, { value: Math.max(0, v) })} />}
          {obj.kind === 'chair' && <p className="ds-hint">The actor sits facing the chair's front (rotation 0 faces +Z). Moving it re-plans the performance.</p>}
          {obj.kind === 'ground' && <p className="ds-hint">The ground is fixed at y = 0.</p>}
        </div>
      ) : (
        <p className="ds-hint">Select an object in the scene or an action in the timeline.</p>
      )}
    </div>
  );
}
