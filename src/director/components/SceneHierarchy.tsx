import { useDirector } from '../state/directorStore';

const ICON: Record<string, string> = { actor: '🧍', table: '▭', glass: '◌', chair: '⑂', ground: '▦', camera: '⌖', light: '☀' };

export function SceneHierarchy() {
  const objects = useDirector((s) => s.project.scene.objects);
  const selected = useDirector((s) => s.selectedObject);
  return (
    <div className="ds-panel">
      <h3>Scene</h3>
      <ul className="ds-tree" data-testid="scene-hierarchy">
        {objects.map((o) => (
          <li key={o.id}>
            <button className={selected === o.id ? 'sel' : ''} data-testid={`object-${o.id}`} onClick={() => useDirector.setState({ selectedObject: o.id, selectedAction: null })}>
              <span className="ic" aria-hidden>
                {ICON[o.kind]}
              </span>
              {o.name}
              <span className="id">#{o.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
